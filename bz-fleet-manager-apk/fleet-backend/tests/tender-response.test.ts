import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import * as realtime from "../src/realtime.js";
import { disarmVanish, vanishNext } from "./vanish.js";

// Cockpit S2a Task 7: accept/decline an outstanding tender.
//
// Accept must NEVER touch the driver's HOS clocks a second time — the hours
// were already decremented when the tender was created (Task 6). Decline
// must restore them EXACTLY, via the same unassign() path DELETE
// /assignments/:id uses. Both tests below compare against values the server
// itself persisted (the whole HosState row for accept, the Assignment's own
// hos*Before snapshot columns for decline) rather than recomputing an
// expected number in the test — a test that reproduces the implementation's
// arithmetic would agree with a buggy implementation making the same mistake.

beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

let dispatcherSeq = 0;
/** Returns the bearer header string, plus the raw id for tests that need it. */
async function dispatcherAuth(orgId?: string) {
  dispatcherSeq += 1;
  const disp = await prisma.dispatcher.create({
    data: { email: `d${dispatcherSeq}@x.com`, passwordHash: "x", name: `D${dispatcherSeq}`, orgId },
  });
  return { id: disp.id, header: `Bearer ${signDispatcherAccess(disp.id)}` };
}

// Commit fixture copied from tests/dispatcher-assignments.test.ts's seed() —
// same shape, not reinvented. `seedSeq` keeps emails unique across the
// several orgs/drivers a single test may seed (no resetDb between them).
let seedSeq = 0;
async function seed(
  opts: { hos?: { driveRemainingMin: number; windowRemainingMin: number; cycleRemainingMin: number; minutesSinceBreak: number } } = {},
) {
  seedSeq += 1;
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
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
  return { org, driver, tractor, trailer, load };
}

/** Commits a real tender through POST /assignments (never bypassed by
 *  writing an Assignment row directly) so the hos*Before snapshot columns
 *  are populated exactly the way the real commit path populates them. */
async function createTender(authHeader: string, seeded: Awaited<ReturnType<typeof seed>>) {
  const { load, driver, tractor, trailer } = seeded;
  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", authHeader)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });
  expect(res.status).toBe(201);
  expect(res.body.assignment.status).toBe("tendered");
  return res.body.assignment as { id: string };
}

it("accept: 200, status assigned, tenderedAt null, and does NOT double-charge the driver's HOS", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const tender = await createTender(auth, seeded);

  // Whole-row snapshot before the accept — not a single field, so a bug that
  // nudges ANY clock (or leaves updatedAt touched) is caught.
  const hosBefore = await prisma.hosState.findUnique({ where: { driverId: seeded.driver.id } });

  const res = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/accept`)
    .set("authorization", auth)
    .send();

  expect(res.status).toBe(200);
  expect(res.body.assignment.status).toBe("assigned");
  expect(res.body.assignment.tenderedAt).toBeNull();

  const persisted = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(persisted?.status).toBe("assigned");
  expect(persisted?.tenderedAt).toBeNull();
  expect((await prisma.load.findUnique({ where: { id: seeded.load.id } }))?.status).toBe("assigned");

  const hosAfter = await prisma.hosState.findUnique({ where: { driverId: seeded.driver.id } });
  // The load-bearing assertion: accepting only relabels the offer. The whole
  // row — including updatedAt — must be byte-identical, because accept must
  // never touch hosState at all.
  expect(hosAfter).toEqual(hosBefore);
});

it("decline: 204, assignment deleted, load back to open, HOS restored EXACTLY to the persisted snapshot, and a tender_declined DispatchConflict is written", async () => {
  const { header: auth } = await dispatcherAuth();
  // Non-trivial starting clocks so an arithmetic (rather than exact-snapshot)
  // restore would visibly drift.
  const seeded = await seed({ hos: { driveRemainingMin: 500, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 460 } });
  const tender = await createTender(auth, seeded);

  // The snapshot the commit itself wrote. The assertions below compare
  // against THIS — read from the server's own persisted row — never against
  // a value recomputed in the test.
  const snapshot = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(snapshot?.hosDriveBefore).not.toBeNull();
  expect(snapshot?.hosWindowBefore).not.toBeNull();
  expect(snapshot?.hosCycleBefore).not.toBeNull();
  expect(snapshot?.hosBreakBefore).not.toBeNull();

  const res = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/decline`)
    .set("authorization", auth)
    .send({ reason: "driver unavailable" });

  expect(res.status).toBe(204);
  expect(await prisma.assignment.findUnique({ where: { id: tender.id } })).toBeNull();
  expect((await prisma.load.findUnique({ where: { id: seeded.load.id } }))?.status).toBe("open");

  const hosAfter = await prisma.hosState.findUnique({ where: { driverId: seeded.driver.id } });
  expect(hosAfter?.driveRemainingMin).toBe(snapshot!.hosDriveBefore);
  expect(hosAfter?.windowRemainingMin).toBe(snapshot!.hosWindowBefore);
  expect(hosAfter?.cycleRemainingMin).toBe(snapshot!.hosCycleBefore);
  expect(hosAfter?.minutesSinceBreak).toBe(snapshot!.hosBreakBefore);

  const conflicts = await prisma.dispatchConflict.findMany({
    where: { loadId: seeded.load.id, kind: "tender_declined" },
  });
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].severity).toBe("warn");
  expect(conflicts[0].detail).toContain("driver unavailable");
});

it("decline without a reason still writes a tender_declined DispatchConflict (reason is optional)", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const tender = await createTender(auth, seeded);

  const res = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/decline`)
    .set("authorization", auth)
    .send({});

  expect(res.status).toBe(204);
  const conflicts = await prisma.dispatchConflict.findMany({
    where: { loadId: seeded.load.id, kind: "tender_declined" },
  });
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].severity).toBe("warn");
});

it("accept and decline both 409 on an assignment that is 'assigned' rather than 'tendered'", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: seeded.load.id, driverId: seeded.driver.id, tractorId: seeded.tractor.id, trailerId: seeded.trailer.id });
  expect(commit.status).toBe(201);
  expect(commit.body.assignment.status).toBe("assigned");
  const id = commit.body.assignment.id as string;

  const accept = await request(app).post(`/api/dispatcher/assignments/${id}/tender/accept`).set("authorization", auth).send();
  expect(accept.status).toBe(409);

  const decline = await request(app).post(`/api/dispatcher/assignments/${id}/tender/decline`).set("authorization", auth).send({});
  expect(decline.status).toBe(409);

  // Neither refused attempt touched anything.
  const persisted = await prisma.assignment.findUnique({ where: { id } });
  expect(persisted?.status).toBe("assigned");
  expect(persisted?.tenderedAt).toBeNull();
});

it("cross-org id is 404 on both accept and decline, never 403, and leaves the tender untouched", async () => {
  const seeded = await seed();
  const owner = await dispatcherAuth(seeded.org.id);
  const tender = await createTender(owner.header, seeded);

  const rival = await prisma.org.create({ data: { name: "Rival" } });
  const attacker = await dispatcherAuth(rival.id);

  const accept = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/accept`)
    .set("authorization", attacker.header)
    .send();
  expect(accept.status).toBe(404);
  expect(accept.status).not.toBe(403);

  const decline = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/decline`)
    .set("authorization", attacker.header)
    .send({});
  expect(decline.status).toBe(404);
  expect(decline.status).not.toBe(403);

  const persisted = await prisma.assignment.findUnique({ where: { id: tender.id } });
  expect(persisted?.status).toBe("tendered");
});

it("a lane lock held by another dispatcher refuses both accept and decline with 409 ENTITY_ALREADY_LOCKED, but never blocks the holder", async () => {
  const seeded = await seed();
  const ann = await dispatcherAuth(seeded.org.id);
  const bo = await dispatcherAuth(seeded.org.id);
  const tender = await createTender(ann.header, seeded);

  const lock = await request(app).post("/api/dispatcher/locks").set("authorization", ann.header)
    .send({ laneId: seeded.driver.id });
  expect(lock.status).toBe(200);

  const boAccept = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/accept`)
    .set("authorization", bo.header)
    .send();
  expect(boAccept.status).toBe(409);
  expect(boAccept.body.error).toBe("ENTITY_ALREADY_LOCKED");

  const boDecline = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/decline`)
    .set("authorization", bo.header)
    .send({});
  expect(boDecline.status).toBe(409);
  expect(boDecline.body.error).toBe("ENTITY_ALREADY_LOCKED");

  // Neither refused attempt touched the tender.
  expect((await prisma.assignment.findUnique({ where: { id: tender.id } }))?.status).toBe("tendered");

  // The holder herself is never blocked from her own lane.
  const annAccept = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/accept`)
    .set("authorization", ann.header)
    .send();
  expect(annAccept.status).toBe(200);
});

// Fix round 2 (ruling R14): pinning the asymmetry deliberately, not by
// accident — the driver's own accept bypasses the Cockpit edit lock (their
// tender answer is external reality), but the DISPATCHER's twin accept route
// keeps its existing guardLoad check: a dispatcher accepting on a load a
// colleague is actively editing is exactly the collision that lock exists
// for.
it("a load lock held by another dispatcher still refuses the DISPATCHER's own accept with 409 — the driver's accept is the deliberate exception, not this route", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const tender = await createTender(auth, seeded);

  await prisma.loadLock.create({
    data: { loadId: seeded.load.id, orgId: seeded.org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
  });

  const res = await request(app)
    .post(`/api/dispatcher/assignments/${tender.id}/tender/accept`)
    .set("authorization", auth)
    .send();

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id: tender.id } })).status).toBe("tendered");
});

// --- decline announces the load, not the assignment (A4 Task 9) ------------
// Declining deletes the Assignment row; board_update used to name it so a
// board knew which bar to remove. board_update retired here — the load
// itself moved back to "open" through unassign()'s one writer, and
// load_changed is what announces that now: the writer's own version, not a
// second read, matching the convention at every other retired site.

it("decline's load_changed carries the load's own version (board_update retired here)", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const tendered = await createTender(auth, seeded);
  const spy = vi.spyOn(realtime, "emitToDispatchers");

  const res = await request(app)
    .post(`/api/dispatcher/assignments/${tendered.id}/tender/decline`)
    .set("authorization", auth)
    .send({ reason: "no thanks" });
  expect(res.status).toBe(204);

  const changed = spy.mock.calls.filter((c) => c[1] === "load_changed");
  expect(changed).toHaveLength(1);
  const fresh = await prisma.load.findUniqueOrThrow({ where: { id: seeded.load.id } });
  expect(changed[0]![2]).toMatchObject({ loadId: seeded.load.id, version: fresh.version, fields: ["status"] });
  expect(fresh.status).toBe("open");
  expect(await prisma.assignment.findUnique({ where: { id: tendered.id } })).toBeNull();
  vi.restoreAllMocks();
});

// --- acceptTender/declineTender's transactions were unmapped ----------------
// Both open their own Serializable transaction inside lib/assignmentActions.ts
// and both were called with no catch. The mapping has to live at the ROUTE,
// because that is where `res` is — which is also why all FOUR call sites need
// it (dispatcher accept/decline here, driver accept/decline in
// tests/driver-tenders.test.ts) and why forgetting one is the live hazard.

it("dispatcher accept answers 409 — not silence — when the tender vanishes mid-accept (P2025)", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const tendered = await createTender(auth, seeded);

  vanishNext("Assignment", "update");
  const res = await request(app).post(`/api/dispatcher/assignments/${tendered.id}/tender/accept`).set("authorization", auth);
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("This tender is no longer available — it was withdrawn or already answered.");
  // Rolled back: still an unanswered offer, not a half-accepted one.
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id: tendered.id } })).status).toBe("tendered");
}, 20_000);

it("dispatcher decline answers 409 — not silence — when the tender vanishes mid-decline (P2025)", async () => {
  const { header: auth } = await dispatcherAuth();
  const seeded = await seed();
  const tendered = await createTender(auth, seeded);

  vanishNext("Assignment", "delete");
  const res = await request(app).post(`/api/dispatcher/assignments/${tendered.id}/tender/decline`)
    .set("authorization", auth).send({});
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("This tender is no longer available — it was withdrawn or already answered.");
  // The HOS restore inside the same transaction must not have landed alone.
  const row = await prisma.assignment.findUniqueOrThrow({ where: { id: tendered.id } });
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: seeded.driver.id } });
  expect(hos.driveRemainingMin).toBe(row.hosDriveBefore! - row.driveMin);
}, 20_000);
