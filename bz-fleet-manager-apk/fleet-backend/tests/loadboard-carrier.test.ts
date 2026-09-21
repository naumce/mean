import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

// T1 Carrier Layer, Task 5 — the loadboard read model gains two things:
// (1) every lane reports which carrier's truck it is (or null, a real state,
// never dressed up as '' / '—' / 'Unassigned'), and (2) ?carrierId= filters
// the lane list. The filter's one hard requirement is that it fails CLOSED:
// an unknown or cross-org carrierId must return an empty lane list, never
// silently fall back to the unfiltered board — that's the difference between
// "no results for this carrier" and "showing you someone else's trucks".

beforeEach(resetDb);

const WINDOW = { from: "2026-08-21T00:00:00.000Z", to: "2026-08-22T00:00:00.000Z" };

async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

describe("loadboard carrier field + filter", () => {
  it("a lane for a driver with a carrier reports both carrierId and carrierName", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Swift Logistics" } });
    const auth = await scopedAuth(org.id);
    const driver = await prisma.driver.create({
      data: { email: "carried@x.com", passwordHash: "x", name: "Carrie D", orgId: org.id, carrierId: carrier.id },
    });

    const res = await request(app).get("/api/dispatcher/loadboard").query(WINDOW).set("authorization", auth);
    expect(res.status).toBe(200);
    const lane = res.body.lanes.find((l: { id: string }) => l.id === driver.id);
    expect(lane.carrierId).toBe(carrier.id);
    expect(lane.carrierName).toBe("Swift Logistics");
  });

  it("a lane for a driver with no carrier reports null for both, not an empty string", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const driver = await prisma.driver.create({
      data: { email: "direct@x.com", passwordHash: "x", name: "Direct D", orgId: org.id },
    });

    const res = await request(app).get("/api/dispatcher/loadboard").query(WINDOW).set("authorization", auth);
    expect(res.status).toBe(200);
    const lane = res.body.lanes.find((l: { id: string }) => l.id === driver.id);
    // toBeNull(), not a falsiness check — '' is falsy too, and would pass a
    // weaker assertion while violating the "absent must never be dressed up
    // as a value" contract.
    expect(lane.carrierId).toBeNull();
    expect(lane.carrierName).toBeNull();
  });

  it("?carrierId=<real> returns only that carrier's lanes", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrierA = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier A" } });
    const carrierB = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier B" } });
    const auth = await scopedAuth(org.id);
    const onA = await prisma.driver.create({
      data: { email: "ona@x.com", passwordHash: "x", name: "On A", orgId: org.id, carrierId: carrierA.id },
    });
    await prisma.driver.create({
      data: { email: "onb@x.com", passwordHash: "x", name: "On B", orgId: org.id, carrierId: carrierB.id },
    });
    await prisma.driver.create({
      data: { email: "direct2@x.com", passwordHash: "x", name: "Direct", orgId: org.id },
    });

    const res = await request(app)
      .get("/api/dispatcher/loadboard")
      .query({ ...WINDOW, carrierId: carrierA.id })
      .set("authorization", auth);
    expect(res.status).toBe(200);
    const ids = res.body.lanes.map((l: { id: string }) => l.id);
    expect(ids).toEqual([onA.id]);
  });

  it("?carrierId=<other org's carrier> returns an empty lane list, not the unfiltered board", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const carrierB = await prisma.carrier.create({ data: { orgId: orgB.id, name: "Beta Carrier" } });
    const authA = await scopedAuth(orgA.id);
    // Alpha has drivers of its own — if the filter fell open, these would
    // leak into the response for a Beta carrier id.
    await prisma.driver.create({ data: { email: "alpha1@x.com", passwordHash: "x", name: "A1", orgId: orgA.id } });
    await prisma.driver.create({ data: { email: "alpha2@x.com", passwordHash: "x", name: "A2", orgId: orgA.id } });

    const res = await request(app)
      .get("/api/dispatcher/loadboard")
      .query({ ...WINDOW, carrierId: carrierB.id })
      .set("authorization", authA);
    expect(res.status).toBe(200);
    expect(res.body.lanes).toEqual([]);
  });

  it("?carrierId=<nonexistent> returns an empty lane list, not the unfiltered board", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    await prisma.driver.create({ data: { email: "someone@x.com", passwordHash: "x", name: "Someone", orgId: org.id } });

    const res = await request(app)
      .get("/api/dispatcher/loadboard")
      .query({ ...WINDOW, carrierId: "does-not-exist" })
      .set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.lanes).toEqual([]);
  });

  // T1 Carrier Layer, Task 8 — the gap: ?carrierId= narrowed lanes only,
  // leaving the yard (tractors/trailers) showing every carrier's equipment
  // under a carrier-filtered board. That's the exact mixing the carrier
  // layer exists to prevent (a Carrier B trailer could get hooked onto a
  // Carrier A driver), so the filter must narrow tractors and trailers too.
  it("?carrierId=<real> also narrows tractors and trailers to that carrier, not just lanes", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrierA = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier A" } });
    const carrierB = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier B" } });
    const auth = await scopedAuth(org.id);
    const tractorA = await prisma.tractor.create({ data: { orgId: org.id, unit: "A-100", carrierId: carrierA.id } });
    await prisma.tractor.create({ data: { orgId: org.id, unit: "B-200", carrierId: carrierB.id } });
    await prisma.tractor.create({ data: { orgId: org.id, unit: "N-300" } }); // no carrier — must not leak in
    const trailerA = await prisma.trailer.create({ data: { orgId: org.id, unit: "TA-1", type: "DryVan", carrierId: carrierA.id } });
    await prisma.trailer.create({ data: { orgId: org.id, unit: "TB-1", type: "DryVan", carrierId: carrierB.id } });
    await prisma.trailer.create({ data: { orgId: org.id, unit: "TN-1", type: "DryVan" } }); // no carrier

    const res = await request(app)
      .get("/api/dispatcher/loadboard")
      .query({ ...WINDOW, carrierId: carrierA.id })
      .set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.tractors.map((t: { id: string }) => t.id)).toEqual([tractorA.id]);
    expect(res.body.trailers.map((t: { id: string }) => t.id)).toEqual([trailerA.id]);
  });

  // The open backlog is deliberately NOT carrier-filtered: Load has no
  // carrierId column (it's priced through the driver's carrier only once
  // assigned), so an unfiltered `loads` array alongside filtered
  // lanes/tractors/trailers is the correct, intended shape — not a gap.
  it("?carrierId= does not touch the loads array — the open backlog stays shared across carriers", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrierA = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier A" } });
    const auth = await scopedAuth(org.id);
    await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "DryVan", status: "open",
        stops: { create: [{ sequence: 1, type: "pickup", address: "KC" }, { sequence: 2, type: "delivery", address: "OMA" }] },
      },
    });

    const res = await request(app)
      .get("/api/dispatcher/loadboard")
      .query({ ...WINDOW, carrierId: carrierA.id })
      .set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.loads).toHaveLength(1);
  });

  it("?carrierId=<real> keeps only that carrier's covered brokered loads, and never touches the open backlog", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrierA = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier A" } });
    const carrierB = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier B" } });
    const auth = await scopedAuth(org.id);
    const coveredA = await prisma.load.create({ data: {
      orgId: org.id, requiredEquip: "DryVan", status: "assigned", carrierId: carrierA.id,
      stops: { create: [
        { sequence: 1, type: "pickup", address: "Kansas City, MO",
          appointment: { create: { windowStart: new Date("2026-08-21T10:00:00.000Z"), windowEnd: new Date("2026-08-21T12:00:00.000Z"), type: "pickup" } } },
        { sequence: 2, type: "delivery", address: "Omaha, NE" },
      ] },
    } });
    const coveredB = await prisma.load.create({ data: {
      orgId: org.id, requiredEquip: "DryVan", status: "assigned", carrierId: carrierB.id,
      stops: { create: [
        { sequence: 1, type: "pickup", address: "Kansas City, MO",
          appointment: { create: { windowStart: new Date("2026-08-21T10:00:00.000Z"), windowEnd: new Date("2026-08-21T12:00:00.000Z"), type: "pickup" } } },
        { sequence: 2, type: "delivery", address: "Omaha, NE" },
      ] },
    } });
    const openB = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", status: "open", carrierId: carrierB.id } });

    const res = await request(app)
      .get("/api/dispatcher/loadboard")
      .query({ ...WINDOW, carrierId: carrierA.id })
      .set("authorization", auth);
    const ids = res.body.loads.map((l: { id: string }) => l.id);
    expect(ids).toContain(coveredA.id);
    expect(ids).not.toContain(coveredB.id);
    expect(ids).toContain(openB.id);
  });
});
