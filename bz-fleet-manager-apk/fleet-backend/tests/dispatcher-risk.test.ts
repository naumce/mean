import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const DENVER = { lat: 39.7392, lng: -104.9903 };
const MIN = 60_000;

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

async function seedAssignment(orgId: string, tag: string, opts: {
  status: string; plannedStart: Date; plannedEnd: Date; windowEnd: Date;
  driverPos?: { lat: number; lng: number };
}) {
  const driver = await prisma.driver.create({ data: {
    email: `${tag}@x.com`, passwordHash: "x", name: `Driver ${tag}`, orgId,
    lastLat: opts.driverPos?.lat, lastLng: opts.driverPos?.lng,
  } });
  const load = await prisma.load.create({ data: {
    orgId, requiredEquip: "DryVan", orderRef: `REF-${tag}`, status: "assigned",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng },
      { sequence: 2, type: "delivery", address: "KC yard", lat: KC.lat, lng: KC.lng,
        appointment: { create: { windowEnd: opts.windowEnd, type: "delivery" } } },
    ] },
  } });
  await prisma.assignment.create({ data: {
    orgId, loadId: load.id, driverId: driver.id, status: opts.status,
    plannedStart: opts.plannedStart, plannedEnd: opts.plannedEnd,
  } });
  return { driver, load };
}

it("surfaces a slipped start as late risk and leaves healthy trips alone", async () => {
  const { org, token } = await orgScopedDispatcher();
  const now = Date.now();
  // Planned 3h run that should have started 90 min ago; window closes in 2h ->
  // projected arrival now+3h misses by an hour.
  await seedAssignment(org.id, "late", {
    status: "assigned",
    plannedStart: new Date(now - 90 * MIN), plannedEnd: new Date(now + 90 * MIN),
    windowEnd: new Date(now + 120 * MIN),
  });
  // Same shape but the start is still ahead — no risk.
  await seedAssignment(org.id, "fine", {
    status: "assigned",
    plannedStart: new Date(now + 60 * MIN), plannedEnd: new Date(now + 240 * MIN),
    windowEnd: new Date(now + 300 * MIN),
  });

  const res = await request(app).get("/api/dispatcher/risk").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.risks).toHaveLength(1);
  expect(res.body.risks[0].ref).toBe("REF-late");
  expect(res.body.risks[0].kind).toBe("late_start");
  expect(res.body.risks[0].severity).toBe("block");
  expect(res.body.risks[0].driverName).toBe("Driver late");
  expect(new Date(res.body.risks[0].projectedArrival).getTime()).toBeGreaterThan(now);
});

it("flags a rolling driver who is physically too far to make the window", async () => {
  const { org, token } = await orgScopedDispatcher();
  const now = Date.now();
  // Driver pinging from Denver, drop in KC (~600+ mi), window closes in 1h.
  await seedAssignment(org.id, "far", {
    status: "in_progress",
    plannedStart: new Date(now - 120 * MIN), plannedEnd: new Date(now + 30 * MIN),
    windowEnd: new Date(now + 60 * MIN),
    driverPos: DENVER,
  });

  const res = await request(app).get("/api/dispatcher/risk").set("authorization", `Bearer ${token}`);
  expect(res.body.risks).toHaveLength(1);
  expect(res.body.risks[0].kind).toBe("behind_schedule");
  expect(res.body.risks[0].severity).toBe("block");
  expect(res.body.risks[0].detail).toContain("even a direct run misses");
});

it("never shows another org's risk", async () => {
  const { token } = await orgScopedDispatcher();
  const rival = await prisma.org.create({ data: { name: "Rival" } });
  const now = Date.now();
  await seedAssignment(rival.id, "rival", {
    status: "assigned",
    plannedStart: new Date(now - 90 * MIN), plannedEnd: new Date(now + 90 * MIN),
    windowEnd: new Date(now + 60 * MIN),
  });

  const res = await request(app).get("/api/dispatcher/risk").set("authorization", `Bearer ${token}`);
  expect(res.body.risks).toHaveLength(0);
});

it("a brokered load past its pickup window with no assignment is a late start attributed to its carrier", async () => {
  const { org, token } = await orgScopedDispatcher();
  const auth = { authorization: `Bearer ${token}` };
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
  const load = await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "assigned", carrierId: carrier.id, externalId: "0563265",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowStart: new Date(Date.now() - 3 * 3600_000), windowEnd: new Date(Date.now() - 2 * 3600_000), type: "pickup", kind: "appointment" } } },
      { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date(Date.now() + 20 * 3600_000), type: "delivery", kind: "appointment" } } },
    ] },
  } });
  const res = await request(app).get("/api/dispatcher/risk").set(auth);
  const row = res.body.risks.find((r: { loadId: string }) => r.loadId === load.id);
  expect(row).toMatchObject({ kind: "late_start", assignmentId: null, driverId: null, carrierName: "Blue Road LLC", ref: "0563265" });
  // F4: the only fact the record holds for a brokered load is that the pickup
  // window opened — no GPS on a carrier's truck (spec §8.4) means no transit
  // estimate and no "projected arrival"/"miss by" figure may appear here.
  expect(row.detail).toMatch(/^PU window opened \d+h \d+m ago; no carrier check-in$/);
  expect(row.detail).not.toMatch(/projected|miss the delivery window|arrival/i);
});

// R20: A3's final review found the brokered rows still shipped a
// `projectedArrival` computed by treating the PU->DEL appointment span as a
// transit estimate — the wording was fixed so no dispatcher reads it as a
// tracked ETA, but the number itself was still in the JSON, a trap for the
// next component to render it as something we can stand behind.
it("ships no projected arrival for a load we do not track", async () => {
  // Spec §8.4: we have no GPS for a carrier's truck. A projection derived
  // from an appointment window is a guess wearing a number's clothes.
  const { org, token } = await orgScopedDispatcher();
  const auth = { authorization: `Bearer ${token}` };
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
  await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "assigned", carrierId: carrier.id, externalId: "0563265",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowStart: new Date(Date.now() - 3 * 3600_000), windowEnd: new Date(Date.now() - 2 * 3600_000), type: "pickup", kind: "appointment" } } },
      { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date(Date.now() + 20 * 3600_000), type: "delivery", kind: "appointment" } } },
    ] },
  } });
  const res = await request(app).get("/api/dispatcher/risk").set(auth);
  expect(res.status).toBe(200);
  const brokered = res.body.risks.filter((r: { driverId: string | null }) => r.driverId === null);
  expect(brokered.length).toBeGreaterThan(0);
  for (const row of brokered) {
    expect(row.projectedArrival ?? null).toBeNull();
    expect(row.projectedArrivalMs ?? null).toBeNull();
  }
});

// F4: the fix must not touch how OUR OWN driver-load risk rows read — only a
// brokered row (driverId === null) takes the new wording.
it("keeps the own-driver late_start and behind_schedule detail wording unchanged", async () => {
  const { org, token } = await orgScopedDispatcher();
  const now = Date.now();
  await seedAssignment(org.id, "late2", {
    status: "assigned",
    plannedStart: new Date(now - 90 * MIN), plannedEnd: new Date(now + 90 * MIN),
    windowEnd: new Date(now + 120 * MIN),
  });
  await seedAssignment(org.id, "far2", {
    status: "in_progress",
    plannedStart: new Date(now - 120 * MIN), plannedEnd: new Date(now + 30 * MIN),
    windowEnd: new Date(now + 60 * MIN),
    driverPos: DENVER,
  });

  const res = await request(app).get("/api/dispatcher/risk").set("authorization", `Bearer ${token}`);
  const lateStart = res.body.risks.find((r: { ref: string }) => r.ref === "REF-late2");
  expect(lateStart.detail).toMatch(/^Not started .+ after the planned start — projected to miss the delivery window by .+$/);
  const behindSchedule = res.body.risks.find((r: { ref: string }) => r.ref === "REF-far2");
  expect(behindSchedule.detail).toMatch(/^Rolling, .+ mi from the drop — even a direct run misses the delivery window by .+$/);
});
