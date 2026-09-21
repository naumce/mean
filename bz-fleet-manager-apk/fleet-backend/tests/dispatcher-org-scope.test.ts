import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

const WINDOW = { from: "2026-08-21T00:00:00.000Z", to: "2026-08-22T00:00:00.000Z" };
const KC = { lat: 39.0997, lng: -94.5786 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

async function makeOrg(name: string) {
  const org = await prisma.org.create({ data: { name } });
  const driver = await prisma.driver.create({
    data: {
      email: `${name.toLowerCase()}@x.com`, passwordHash: "x", name: `${name} Driver`,
      orgId: org.id, lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: `${name}-L1`, requiredEquip: "DryVan", revenueCents: 30000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "A", lat: KC.lat, lng: KC.lng, appointment: { create: { windowEnd: FAR } } },
          { sequence: 2, type: "delivery", address: "B", lat: 41.26, lng: -95.93, appointment: { create: { windowEnd: FAR } } },
        ],
      },
    },
  });
  return { org, driver, load };
}

async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

it("a scoped dispatcher only sees their own org's lanes and loads", async () => {
  const a = await makeOrg("Alpha");
  await makeOrg("Beta");
  const auth = await scopedAuth(a.org.id);

  const res = await request(app).get("/api/dispatcher/loadboard").query(WINDOW).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.lanes.map((l: { name: string }) => l.name)).toEqual(["Alpha Driver"]);
  expect(res.body.loads.map((l: { reference: string }) => l.reference)).toEqual(["Alpha-L1"]);
});

it("suggest and assignments 404 a load from another org", async () => {
  const a = await makeOrg("Alpha");
  const b = await makeOrg("Beta");
  const auth = await scopedAuth(a.org.id);

  const sug = await request(app).get(`/api/dispatcher/suggest?loadId=${b.load.id}`).set("authorization", auth);
  expect(sug.status).toBe(404);

  const asg = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: b.load.id, driverId: b.driver.id, tractorId: "t", trailerId: "tr" });
  expect(asg.status).toBe(404);
});

it("an unscoped (legacy) dispatcher still sees everything", async () => {
  await makeOrg("Alpha");
  await makeOrg("Beta");
  const disp = await prisma.dispatcher.create({ data: { email: "legacy@x.com", passwordHash: "x", name: "L" } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

  const res = await request(app).get("/api/dispatcher/loadboard").query(WINDOW).set("authorization", auth);
  expect(res.body.lanes).toHaveLength(2);
  expect(res.body.loads).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Legacy Trip/Conversation domain (dispatcherTrips, dispatcherBoard,
// dispatcherApprovals, dispatcherComms). These four routers had no org scoping
// at all; each case below is a cross-tenant attack that was demonstrated to
// succeed against the unscoped code. They assert EFFECTS, not status codes: a
// list must not contain the foreign row, and a mutation must leave the row
// unchanged when re-read. Where a write is under test the data assertion comes
// FIRST, so reverting the guard fails on "the write landed" rather than on the
// status line — a status assertion placed first would abort the test and mask
// whether the row actually changed.
// ---------------------------------------------------------------------------

const SECRET = "ORGA CONFIDENTIAL: gate code 4417";

async function legacyFixture() {
  const [orgA, orgB] = await Promise.all([
    prisma.org.create({ data: { name: "LegacyA" } }),
    prisma.org.create({ data: { name: "LegacyB" } }),
  ]);
  const driverA = await prisma.driver.create({
    data: { email: "legacy-a@x.com", passwordHash: "x", name: "LegacyA Driver", orgId: orgA.id },
  });
  const driverB = await prisma.driver.create({
    data: { email: "legacy-b@x.com", passwordHash: "x", name: "LegacyB Driver", orgId: orgB.id },
  });
  // Org A's trip: inside the board window, awaiting approval, driver-owned.
  const tripA = await prisma.trip.create({
    data: {
      identifier: "TR-A-SECRET", status: "awaiting_approval", driverId: driverA.id,
      scheduledStart: new Date("2026-08-21T09:00:00.000Z"),
      scheduledEnd: new Date("2026-08-21T12:00:00.000Z"),
      stops: { create: [{ sequence: 1, address: "1 Secret Way, Alpha" }] },
    },
    include: { stops: true },
  });
  const tripB = await prisma.trip.create({
    data: {
      identifier: "TR-B-OWN", status: "awaiting_approval", driverId: driverB.id,
      scheduledStart: new Date("2026-08-21T09:00:00.000Z"),
      scheduledEnd: new Date("2026-08-21T12:00:00.000Z"),
      stops: { create: [{ sequence: 1, address: "1 Beta Rd" }] },
    },
  });
  const proofA = await prisma.signsProof.create({
    data: { stopId: tripA.stops[0]!.id, proofType: "signature", fileUrl: "/uploads/orga-secret.png", status: "pending" },
  });
  const convA = await prisma.conversation.create({ data: { driverId: driverA.id, tripId: tripA.id } });
  await prisma.message.create({ data: { conversationId: convA.id, senderType: "driver", text: SECRET } });
  await prisma.driverLocation.create({ data: { driverId: driverA.id, latitude: 40.1, longitude: -95.2 } });
  await prisma.driverLocation.create({ data: { driverId: driverB.id, latitude: 33.3, longitude: -84.4 } });
  return { orgA, orgB, driverA, driverB, tripA, tripB, proofA, convA, auth: await scopedAuth(orgB.id) };
}

describe("dispatcherTrips is tenant-scoped", () => {
  it("GET /trips omits another org's trip entirely", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/trips").set("authorization", f.auth);
    const ids = res.body.map((t: { id: string }) => t.id);
    expect(ids).not.toContain(f.tripA.id);
    expect(ids).toContain(f.tripB.id);
  });

  it("GET /trips?driverId= another org's driver leaks nothing", async () => {
    const f = await legacyFixture();
    const res = await request(app).get(`/api/dispatcher/trips?driverId=${f.driverA.id}`).set("authorization", f.auth);
    expect(res.body).toEqual([]);
  });

  it("GET /trips/:id 404s another org's trip instead of returning its stops", async () => {
    const f = await legacyFixture();
    const res = await request(app).get(`/api/dispatcher/trips/${f.tripA.id}`).set("authorization", f.auth);
    expect(res.body.identifier).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("1 Secret Way");
    expect(res.status).toBe(404);
  });

  it("POST /trips/:id/assign cannot re-home another org's trip — the row is unchanged", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/trips/${f.tripA.id}/assign`)
      .set("authorization", f.auth).send({ driverId: f.driverB.id });
    const after = await prisma.trip.findUnique({ where: { id: f.tripA.id } });
    expect(after?.driverId).toBe(f.driverA.id);
    expect(after?.status).toBe("awaiting_approval");
    expect(await prisma.routePreAssignment.count({ where: { tripId: f.tripA.id } })).toBe(0);
    expect(res.status).toBe(404);
  });

  it("POST /trips/:id/assign cannot hand a caller's own trip to a foreign driver", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/trips/${f.tripB.id}/assign`)
      .set("authorization", f.auth).send({ driverId: f.driverA.id });
    const after = await prisma.trip.findUnique({ where: { id: f.tripB.id } });
    expect(after?.driverId).toBe(f.driverB.id);
    expect(res.status).toBe(404);
  });

  it("a scoped dispatcher can still read and assign inside their own org", async () => {
    const f = await legacyFixture();
    const read = await request(app).get(`/api/dispatcher/trips/${f.tripB.id}`).set("authorization", f.auth);
    expect(read.status).toBe(200);
    expect(read.body.identifier).toBe("TR-B-OWN");

    const created = await request(app).post("/api/dispatcher/trips").set("authorization", f.auth)
      .send({ identifier: "TR-B-NEW", stops: [{ sequence: 1, address: "B St" }] });
    expect(created.status).toBe(201);
    // An unassigned trip has no tenant column to carry, so it must remain
    // visible to the dispatcher who just created it (lib/tripScope.ts).
    const list = await request(app).get("/api/dispatcher/trips").set("authorization", f.auth);
    expect(list.body.map((t: { id: string }) => t.id)).toContain(created.body.id);

    const assigned = await request(app).post(`/api/dispatcher/trips/${created.body.id}/assign`)
      .set("authorization", f.auth).send({ driverId: f.driverB.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.driverId).toBe(f.driverB.id);
  });
});

describe("dispatcherBoard is tenant-scoped", () => {
  it("GET /board omits another org's lanes and trips", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/board").query(WINDOW).set("authorization", f.auth);
    expect(res.status).toBe(200);
    const laneIds = res.body.lanes.map((l: { id: string }) => l.id);
    expect(laneIds).not.toContain(f.driverA.id);
    expect(laneIds).toContain(f.driverB.id);
    const tripIds = res.body.trips.map((t: { id: string }) => t.id);
    expect(tripIds).not.toContain(f.tripA.id);
    expect(tripIds).toContain(f.tripB.id);
  });
});

describe("dispatcherApprovals is tenant-scoped", () => {
  it("GET /approvals/trips omits another org's queue", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/approvals/trips").set("authorization", f.auth);
    const ids = res.body.map((t: { id: string }) => t.id);
    expect(ids).not.toContain(f.tripA.id);
    expect(ids).toContain(f.tripB.id);
  });

  it("POST /trips/:id/approve cannot approve another org's trip — the row is unchanged", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/trips/${f.tripA.id}/approve`).set("authorization", f.auth);
    const after = await prisma.trip.findUnique({ where: { id: f.tripA.id } });
    expect(after?.status).toBe("awaiting_approval");
    expect(after?.approvedBy).toBeNull();
    expect(after?.approvedAt).toBeNull();
    expect(res.status).toBe(404);
  });

  it("POST /trips/:id/reject cannot reject another org's trip — the row is unchanged", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/trips/${f.tripA.id}/reject`)
      .set("authorization", f.auth).send({ reason: "x" });
    const after = await prisma.trip.findUnique({ where: { id: f.tripA.id } });
    expect(after?.status).toBe("awaiting_approval");
    expect(res.status).toBe(404);
  });

  it("GET /approvals/signs-proof omits another org's proofs", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/approvals/signs-proof").set("authorization", f.auth);
    expect(res.body.map((p: { id: string }) => p.id)).not.toContain(f.proofA.id);
    expect(JSON.stringify(res.body)).not.toContain("orga-secret.png");
  });

  it("POST /signs-proof/:id/approve cannot approve another org's proof — the row is unchanged", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/signs-proof/${f.proofA.id}/approve`)
      .set("authorization", f.auth);
    const after = await prisma.signsProof.findUnique({ where: { id: f.proofA.id } });
    expect(after?.status).toBe("pending");
    expect(res.status).toBe(404);
  });

  it("GET /locations returns only the caller's own org's drivers", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/locations").set("authorization", f.auth);
    expect(res.status).toBe(200);
    const driverIds = res.body.map((l: { driverId: string }) => l.driverId);
    expect(driverIds).not.toContain(f.driverA.id);
    expect(driverIds).toContain(f.driverB.id);
  });

  it("GET /overview counts only the caller's own org's trips", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/overview").set("authorization", f.auth);
    // Both orgs hold exactly one awaiting_approval trip; a leak reads as 2.
    expect(res.body.awaiting_approval).toBe(1);
  });
});

describe("dispatcherComms is tenant-scoped", () => {
  it("GET /conversations omits another org's conversation and its message text", async () => {
    const f = await legacyFixture();
    const res = await request(app).get("/api/dispatcher/conversations").set("authorization", f.auth);
    expect(res.body.map((c: { id: string }) => c.id)).not.toContain(f.convA.id);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain("LegacyA Driver");
  });

  it("GET /conversations/:id/messages 404s another org's thread instead of leaking it", async () => {
    const f = await legacyFixture();
    const res = await request(app).get(`/api/dispatcher/conversations/${f.convA.id}/messages`)
      .set("authorization", f.auth);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.status).toBe(404);
  });

  it("POST /conversations/:id/messages cannot inject into another org's thread", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/conversations/${f.convA.id}/messages`)
      .set("authorization", f.auth).send({ text: "INJECTED BY ORG B" });
    const after = await prisma.message.findMany({ where: { conversationId: f.convA.id } });
    expect(after.map((m) => m.text)).toEqual([SECRET]);
    expect(res.status).toBe(404);
  });

  it("POST /drivers/:id/conversations cannot open a thread with another org's driver", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/drivers/${f.driverA.id}/conversations`)
      .set("authorization", f.auth).send({});
    expect(await prisma.conversation.count({ where: { driverId: f.driverA.id } })).toBe(1);
    expect(res.status).toBe(404);
  });

  it("POST /drivers/:id/notify cannot push a notification to another org's driver", async () => {
    const f = await legacyFixture();
    const res = await request(app).post(`/api/dispatcher/drivers/${f.driverA.id}/notify`)
      .set("authorization", f.auth).send({ type: "custom", title: "ORG B INJECTED", body: "pull over now" });
    expect(await prisma.notification.findMany({ where: { driverId: f.driverA.id } })).toEqual([]);
    expect(res.status).toBe(404);
  });

  it("a scoped dispatcher can still message their own org's driver", async () => {
    const f = await legacyFixture();
    const conv = await request(app).post(`/api/dispatcher/drivers/${f.driverB.id}/conversations`)
      .set("authorization", f.auth).send({});
    expect(conv.status).toBe(200);
    const sent = await request(app).post(`/api/dispatcher/conversations/${conv.body.id}/messages`)
      .set("authorization", f.auth).send({ text: "own-org ping" });
    expect(sent.status).toBe(200);
    const list = await request(app).get("/api/dispatcher/conversations").set("authorization", f.auth);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(conv.body.id);
  });
});

it("an unscoped (legacy) dispatcher still sees every org across all four routers", async () => {
  const f = await legacyFixture();
  const disp = await prisma.dispatcher.create({ data: { email: "legacy-all@x.com", passwordHash: "x", name: "L" } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

  const trips = await request(app).get("/api/dispatcher/trips").set("authorization", auth);
  expect(trips.body.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([f.tripA.id, f.tripB.id]));

  const one = await request(app).get(`/api/dispatcher/trips/${f.tripA.id}`).set("authorization", auth);
  expect(one.status).toBe(200);
  expect(one.body.identifier).toBe("TR-A-SECRET");

  const board = await request(app).get("/api/dispatcher/board").query(WINDOW).set("authorization", auth);
  expect(board.body.lanes.map((l: { id: string }) => l.id)).toEqual(expect.arrayContaining([f.driverA.id, f.driverB.id]));
  expect(board.body.trips.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([f.tripA.id, f.tripB.id]));

  const queue = await request(app).get("/api/dispatcher/approvals/trips").set("authorization", auth);
  expect(queue.body.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([f.tripA.id, f.tripB.id]));
  const proofs = await request(app).get("/api/dispatcher/approvals/signs-proof").set("authorization", auth);
  expect(proofs.body.map((p: { id: string }) => p.id)).toContain(f.proofA.id);
  const overview = await request(app).get("/api/dispatcher/overview").set("authorization", auth);
  expect(overview.body.awaiting_approval).toBe(2);
  const locations = await request(app).get("/api/dispatcher/locations").set("authorization", auth);
  expect(locations.body.map((l: { driverId: string }) => l.driverId))
    .toEqual(expect.arrayContaining([f.driverA.id, f.driverB.id]));

  const convs = await request(app).get("/api/dispatcher/conversations").set("authorization", auth);
  expect(convs.body.map((c: { id: string }) => c.id)).toContain(f.convA.id);
  const thread = await request(app).get(`/api/dispatcher/conversations/${f.convA.id}/messages`)
    .set("authorization", auth);
  expect(thread.status).toBe(200);
  expect(thread.body.map((m: { text: string }) => m.text)).toEqual([SECRET]);
});
