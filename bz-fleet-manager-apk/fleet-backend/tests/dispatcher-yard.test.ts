import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
beforeEach(resetDb);

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

it("lists only genuinely available resources — live trips remove them from the yard", async () => {
  const { org, token } = await orgScopedDispatcher();
  const free = await prisma.driver.create({ data: {
    email: "f@x.com", passwordHash: "x", name: "Free Driver", orgId: org.id,
    hos: { create: { driveRemainingMin: 400, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 0 } },
  } });
  const busyDriver = await prisma.driver.create({ data: { email: "b@x.com", passwordHash: "x", name: "Busy Driver", orgId: org.id } });
  const t1 = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const busyTractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1212", status: "active" } });
  await prisma.tractor.create({ data: { orgId: org.id, unit: "1199", status: "in_shop" } });
  const dryVan = await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-1", type: "DryVan", status: "active" } });
  const busyTrailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-1", type: "Reefer", status: "active" } });

  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", status: "assigned" } });
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: busyDriver.id,
    tractorId: busyTractor.id, trailerId: busyTrailer.id, status: "in_progress",
    plannedStart: new Date(Date.now() - 3600_000), plannedEnd: new Date(Date.now() + 3600_000),
  } });

  const res = await request(app).get("/api/dispatcher/yard").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.tractors.map((t: { id: string }) => t.id)).toEqual([t1.id]); // busy + in_shop excluded
  expect(res.body.trailers.map((t: { id: string }) => t.id)).toEqual([dryVan.id]);
  expect(res.body.drivers.map((d: { id: string }) => d.id)).toEqual([free.id]);
  expect(res.body.drivers[0].hosKnown).toBe(true);
  expect(res.body.drivers[0].driveRemainingMin).toBe(400);
});

it("a completed trip returns its resources to the yard", async () => {
  const { org, token } = await orgScopedDispatcher();
  const driver = await prisma.driver.create({ data: { email: "x@x.com", passwordHash: "x", name: "X", orgId: org.id } });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", status: "delivered" } });
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: driver.id, tractorId: tractor.id, status: "completed",
    plannedStart: new Date(Date.now() - 7200_000), plannedEnd: new Date(Date.now() + 3600_000),
  } });

  const res = await request(app).get("/api/dispatcher/yard").set("authorization", `Bearer ${token}`);
  expect(res.body.tractors).toHaveLength(1);
  expect(res.body.drivers).toHaveLength(1);
});

// T1 Carrier Layer, Task 8 (follow-up) — the chips a dispatcher actually
// drags onto a lane come from THIS endpoint (YardChips.vue renders
// lb.yard, not the /loadboard tractors/trailers arrays), so the
// equipment-mixing hazard (a Carrier B trailer hooked onto a Carrier A
// driver) isn't closed until the yard itself narrows by carrier too.
describe("?carrierId= on the yard", () => {
  it("narrows tractors and trailers to that carrier; drivers stay unfiltered", async () => {
    const { org, token } = await orgScopedDispatcher();
    const carrierA = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier A" } });
    const carrierB = await prisma.carrier.create({ data: { orgId: org.id, name: "Carrier B" } });
    const tractorA = await prisma.tractor.create({ data: { orgId: org.id, unit: "A-100", status: "active", carrierId: carrierA.id } });
    await prisma.tractor.create({ data: { orgId: org.id, unit: "B-200", status: "active", carrierId: carrierB.id } });
    await prisma.tractor.create({ data: { orgId: org.id, unit: "N-300", status: "active" } }); // no carrier
    const trailerA = await prisma.trailer.create({ data: { orgId: org.id, unit: "TA-1", type: "DryVan", status: "active", carrierId: carrierA.id } });
    await prisma.trailer.create({ data: { orgId: org.id, unit: "TB-1", type: "DryVan", status: "active", carrierId: carrierB.id } });
    await prisma.driver.create({ data: { email: "openb@x.com", passwordHash: "x", name: "Open B", orgId: org.id, carrierId: carrierB.id } });

    const res = await request(app)
      .get("/api/dispatcher/yard")
      .query({ carrierId: carrierA.id })
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // The assertion that pins the actual failure mode: only Carrier A's
    // trailer reaches the yard a dispatcher would drag onto an A driver.
    expect(res.body.tractors.map((t: { id: string }) => t.id)).toEqual([tractorA.id]);
    expect(res.body.trailers.map((t: { id: string }) => t.id)).toEqual([trailerA.id]);
    // Drivers are out of scope for this fix (see route comment) — the open
    // Carrier B driver still appears despite the carrierId=A filter.
    expect(res.body.drivers).toHaveLength(1);
  });

  it("?carrierId=<other org's carrier or nonexistent> returns empty tractors/trailers, not the unfiltered yard", async () => {
    const { org, token } = await orgScopedDispatcher();
    const otherOrg = await prisma.org.create({ data: { name: "Beta" } });
    const otherCarrier = await prisma.carrier.create({ data: { orgId: otherOrg.id, name: "Beta Carrier" } });
    await prisma.tractor.create({ data: { orgId: org.id, unit: "A-100", status: "active" } });
    await prisma.trailer.create({ data: { orgId: org.id, unit: "TA-1", type: "DryVan", status: "active" } });

    const res = await request(app)
      .get("/api/dispatcher/yard")
      .query({ carrierId: otherCarrier.id })
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tractors).toEqual([]);
    expect(res.body.trailers).toEqual([]);
  });
});
