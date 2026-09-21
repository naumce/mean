import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import * as assignmentActions from "../src/lib/assignmentActions.js";
import { LoadLocked } from "../src/lib/loadLocks.js";
import { disarmVanish, vanishNext } from "./vanish.js";

// Cockpit S2a Task 9: the driver's own accept/decline of an outstanding
// tender. Same effects as the dispatcher's POST
// /assignments/:id/tender/accept|decline (Task 7) — reached through
// lib/assignmentActions.ts, not reimplemented — plus an ownership check that
// is the ONLY new logic: the assignment must belong to the calling driver,
// else 404 (never 403, which would confirm the tender exists to someone who
// shouldn't see it).
//
// The HOS-restore assertion below compares against the Assignment's own
// hos*Before snapshot columns (what the server itself persisted at tender
// time), never a value recomputed in the test — a test that reproduces the
// implementation's arithmetic would agree with a buggy implementation making
// the same mistake.

beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

let seedSeq = 0;
async function seed(
  opts: { hos?: { driveRemainingMin: number; windowRemainingMin: number; cycleRemainingMin: number; minutesSinceBreak: number } } = {},
) {
  seedSeq += 1;
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: `disp${seedSeq}@x.com`, passwordHash: "x", name: "Dispatcher", orgId: org.id },
  });
  const driver = await prisma.driver.create({
    data: {
      email: `drv${seedSeq}@x.com`, passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      hos: {
        create: opts.hos ?? { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 },
      },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: "RF-1", type: "Reefer", status: "active" },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, dispatcher, driver, tractor, trailer, load };
}

/** Commits a real tender through POST /dispatcher/assignments (never
 *  bypassed by writing an Assignment row directly) so the hos*Before
 *  snapshot columns are populated exactly the way the real commit path
 *  populates them. */
async function createTender(seeded: Awaited<ReturnType<typeof seed>>) {
  const { load, driver, tractor, trailer, dispatcher } = seeded;
  const res = await request(app).post("/api/dispatcher/assignments")
    .set("authorization", `Bearer ${signDispatcherAccess(dispatcher.id)}`)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });
  expect(res.status).toBe(201);
  expect(res.body.assignment.status).toBe("tendered");
  return res.body.assignment as { id: string };
}

it("the tendered driver accepts: 200, status assigned", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send();

  expect(res.status).toBe(200);
  expect(res.body.assignment.status).toBe("assigned");

  const persisted = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(persisted?.status).toBe("assigned");
  expect((await prisma.load.findUnique({ where: { id: seeded.load.id } }))?.status).toBe("assigned");
});

// Fix round 1: the driver accepting their own tender is not a dispatcher —
// actorOf(req) would have read no dispatcherId off a driver token and traced
// the write as the generic "dispatcher". The LoadChange row must instead say
// which driver moved the load.
it("the driver's own tender-accept traces the load's status change with the driver's name, not a generic 'dispatcher'", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send();
  expect(res.status).toBe(200);

  // Two "status" rows exist by now (open→tendered from the dispatcher's
  // commit, tendered→assigned from this accept) — filtered on `after` so the
  // query names the accept's own row, not whichever findFirst returns first.
  const row = await prisma.loadChange.findFirst({ where: { loadId: seeded.load.id, field: "status", after: "assigned" } });
  expect(row?.actorName).toContain("Jake");
  expect(row?.actorId).toBeNull();
});

// Fix round 2 (ruling R14): the driver has taken the freight — external
// reality, same stance as the decline. A dispatcher's Cockpit edit lock on
// this load must not refuse the driver's own accept, let alone hang it.
// Real lock, real route, genuinely reachable path — not a mocked throw.
it("a driver accepts a tender even while a dispatcher holds the load's edit lock", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: seeded.load.id } })).version).toBe(1);

  await prisma.loadLock.create({
    data: { loadId: seeded.load.id, orgId: seeded.org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
  });

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send();

  expect(res.status).toBe(200);
  expect(res.body.assignment.status).toBe("assigned");
  const load = await prisma.load.findUniqueOrThrow({ where: { id: seeded.load.id } });
  expect(load.status).toBe("assigned");
  expect(load.version).toBe(2);
});

// The forced half of the never-hang net: after the fix, LoadLocked cannot
// actually surface from this route's real path (bypassLock:true above), so
// this proves the CATCH maps it to a clean 409 rather than a hang or a bare
// 500 if that ever changes — same technique as tests/tender-cancel.test.ts's
// equivalent net test for cancel.
it("driver accept maps a forced LoadLocked to a clean 409 — a never-hang net, not a hang or a 500", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  const fakeLock = {
    loadId: seeded.load.id, orgId: seeded.org.id, dispatcherId: "disp-maria", by: "Maria",
    since: Date.now(), expiresAt: Date.now() + 60_000,
  };
  const spy = vi.spyOn(assignmentActions, "acceptTender").mockRejectedValueOnce(new LoadLocked(fakeLock));

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send();
  spy.mockRestore();

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  // Untouched: the mocked throw means nothing about the tender should have moved.
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id: tender.id } })).status).toBe("tendered");
});

it("a DIFFERENT driver accepting the same tender gets 404, never 403, and the tender is untouched", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);
  const rival = await prisma.driver.create({ data: { email: "rival@x.com", passwordHash: "x", name: "Rival" } });

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signAccess(rival.id)}`)
    .send();

  expect(res.status).toBe(404);
  expect(res.status).not.toBe(403);

  const persisted = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(persisted?.status).toBe("tendered");
});

it("a DIFFERENT driver declining the same tender gets 404, never 403, and the tender is untouched", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);
  const rival = await prisma.driver.create({ data: { email: "rival2@x.com", passwordHash: "x", name: "Rival" } });

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/decline`)
    .set("authorization", `Bearer ${signAccess(rival.id)}`)
    .send({});

  expect(res.status).toBe(404);
  expect(res.status).not.toBe(403);

  const persisted = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(persisted?.status).toBe("tendered");
});

// Fix round 1: the driver's answer to a tender is a fact like a
// cancellation, not a Cockpit edit — declineTender's own unassign() call
// passes bypassLock:true, so a colleague editing this load's fields on
// Their Board must never leave the driver's decline hanging or refused.
it("driver declines even while a dispatcher holds the load's edit lock, and the version still bumps", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: seeded.load.id } })).version).toBe(1);

  await prisma.loadLock.create({
    data: { loadId: seeded.load.id, orgId: seeded.org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
  });

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/decline`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send({});

  expect(res.status).toBe(204);
  expect(await prisma.assignment.findUnique({ where: { id: tender.id } })).toBeNull();
  const load = await prisma.load.findUniqueOrThrow({ where: { id: seeded.load.id } });
  expect(load.status).toBe("open");
  expect(load.version).toBe(2);
});

it("driver declines: 204, load back to open, and HOS restored EXACTLY to the persisted snapshot", async () => {
  // Non-trivial starting clocks so an arithmetic (rather than exact-snapshot)
  // restore would visibly drift.
  const seeded = await seed({ hos: { driveRemainingMin: 500, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 460 } });
  const tender = await createTender(seeded);

  // The snapshot the commit itself wrote. The assertion below compares
  // against THIS — read from the server's own persisted row — never against
  // a value recomputed here.
  const snapshot = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(snapshot?.hosDriveBefore).not.toBeNull();
  expect(snapshot?.hosWindowBefore).not.toBeNull();
  expect(snapshot?.hosCycleBefore).not.toBeNull();
  expect(snapshot?.hosBreakBefore).not.toBeNull();

  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/decline`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send({ reason: "cannot make the pickup window" });

  expect(res.status).toBe(204);
  expect(await prisma.assignment.findUnique({ where: { id: tender.id } })).toBeNull();
  expect((await prisma.load.findUnique({ where: { id: seeded.load.id } }))?.status).toBe("open");

  const hosAfter = await prisma.hosState.findUnique({ where: { driverId: seeded.driver.id } });
  expect(hosAfter?.driveRemainingMin).toBe(snapshot!.hosDriveBefore);
  expect(hosAfter?.windowRemainingMin).toBe(snapshot!.hosWindowBefore);
  expect(hosAfter?.cycleRemainingMin).toBe(snapshot!.hosCycleBefore);
  expect(hosAfter?.minutesSinceBreak).toBe(snapshot!.hosBreakBefore);
});

it("rejects an accept without a token: 401", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  const res = await request(app).post(`/api/driver/tenders/${tender.id}/accept`).send();
  expect(res.status).toBe(401);
});

it("rejects a decline without a token: 401", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  const res = await request(app).post(`/api/driver/tenders/${tender.id}/decline`).send({});
  expect(res.status).toBe(401);
});

it("a dispatcher token does not satisfy the driver route: 404, not 200/403 — a dispatcher token carries no real driverId", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  const accept = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signDispatcherAccess(seeded.dispatcher.id)}`)
    .send();
  expect(accept.status).toBe(404);
  expect(accept.status).not.toBe(403);

  const decline = await request(app)
    .post(`/api/driver/tenders/${tender.id}/decline`)
    .set("authorization", `Bearer ${signDispatcherAccess(seeded.dispatcher.id)}`)
    .send({});
  expect(decline.status).toBe(404);
  expect(decline.status).not.toBe(403);

  const persisted = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(persisted?.status).toBe("tendered");
});

it("accept 409s an assignment that is already 'assigned' rather than 'tendered'", async () => {
  const seeded = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments")
    .set("authorization", `Bearer ${signDispatcherAccess(seeded.dispatcher.id)}`)
    .send({ loadId: seeded.load.id, driverId: seeded.driver.id, tractorId: seeded.tractor.id, trailerId: seeded.trailer.id });
  expect(commit.status).toBe(201);
  const id = commit.body.assignment.id as string;

  const accept = await request(app)
    .post(`/api/driver/tenders/${id}/accept`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send();
  expect(accept.status).toBe(409);
});

// --- The driver side of the same write-conflict mapping ---------------------
// acceptTender/declineTender open their transaction inside
// lib/assignmentActions.ts, but `res` only exists at the route — so the
// mapping is per call site, and there are FOUR (two here, two on the
// dispatcher's routes). The driver is the more likely loser of this race: the
// dispatcher can withdraw a tender at any moment while the offer sits
// unanswered on a phone. Unmapped, the Accept button just spins.

it("driver accept answers 409 — not silence — when the tender was withdrawn mid-accept (P2025)", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  vanishNext("Assignment", "update");
  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/accept`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send();
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("This tender is no longer available — it was withdrawn or already answered.");
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id: tender.id } })).status).toBe("tendered");
}, 20_000);

it("driver decline answers 409 — not silence — when the tender was withdrawn mid-decline (P2025)", async () => {
  const seeded = await seed();
  const tender = await createTender(seeded);

  vanishNext("Assignment", "delete");
  const res = await request(app)
    .post(`/api/driver/tenders/${tender.id}/decline`)
    .set("authorization", `Bearer ${signAccess(seeded.driver.id)}`)
    .send({});
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("This tender is no longer available — it was withdrawn or already answered.");
  // The HOS restore inside the aborted transaction must not have landed alone.
  const row = await prisma.assignment.findUniqueOrThrow({ where: { id: tender.id } });
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: seeded.driver.id } });
  expect(hos.driveRemainingMin).toBe(row.hosDriveBefore! - row.driveMin);
}, 20_000);
