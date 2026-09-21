import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";

// Cockpit S2a Task 4: the lane lock must actually bite on assignment
// mutations. Ann holds the driver's lane; Bo's commit onto that same driver
// must be refused, and — the assertion that actually matters — refused
// BEFORE anything is written. Ann, the holder, must never be blocked from
// her own lane.
//
// The lock is taken and checked exclusively through the real HTTP routes
// (POST /api/dispatcher/locks, then POST/DELETE /api/dispatcher/assignments*)
// rather than by calling lib/locks.ts's acquire() directly in the test — a
// direct call would bypass the actual route wiring (the real req.auth-derived
// dispatcherId, the real laneId the guard derives from the URL/body) that
// this suite exists to exercise. lib/locks.ts's table is global by laneId
// (no org bucket to get wrong), so the risk a direct acquire() call would
// hide is no longer "wrong bucket" — it's "the guard silently checks a
// different lane or dispatcher than the route actually mutates."

beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

// Commit fixture copied from tests/dispatcher-assignments.test.ts's seed() —
// same shape, not reinvented. The driver/tractor/trailer/loads are org-scoped
// because Prisma requires an orgId on them, not because the lock does: with
// lib/locks.ts's table global by laneId, a lock on this driver's lane binds
// regardless of which dispatcher's own org scope is (or isn't) set — see the
// scoped-vs-unscoped test below, which is exactly the case that requires
// that to be true.
async function seed() {
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const driver = await prisma.driver.create({
    data: {
      email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: "RF-1", type: "Reefer", status: "active" },
  });
  const load1 = await prisma.load.create({
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
  // A second load for the same driver/tractor/trailer so Ann's own-lane
  // commit (assertion 4) has something open to commit onto without first
  // having to unwind Bo's commit on load1.
  const load2 = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 25000, fscCents: 3000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock 2", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock 2", lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load1, load2 };
}

async function scopedDispatcher(orgId: string, name: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `${name.toLowerCase()}@x.com`, passwordHash: "x", name, orgId },
  });
  return { Authorization: `Bearer ${signDispatcherAccess(disp.id)}` };
}

// Legacy/dev dispatcher with no org (Dispatcher.orgId is nullable) — attachOrgScope
// sets req.orgScope = null for these, and middleware/orgScope.ts's documented
// stance is that an unscoped account sees (and can act on) every org's data.
async function unscopedDispatcher(name: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `${name.toLowerCase()}@x.com`, passwordHash: "x", name },
  });
  return { Authorization: `Bearer ${signDispatcherAccess(disp.id)}` };
}

it("refuses a mutation on a lane another dispatcher holds, never blocks the holder, and stops refusing once released", async () => {
  const { driver, tractor, trailer, load1, load2, org } = await seed();
  const ann = await scopedDispatcher(org.id, "Ann");
  const bo = await scopedDispatcher(org.id, "Bo");

  // Ann takes the lane through the real lock route.
  const lockRes = await request(app).post("/api/dispatcher/locks").set(ann).send({ laneId: driver.id });
  expect(lockRes.status).toBe(200);

  const commit1 = { loadId: load1.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id };

  // 1. Bo's commit onto Ann's locked lane -> 409 ENTITY_ALREADY_LOCKED, and
  //    the body carries the holding lock so the client can name who holds it.
  const boBlocked = await request(app).post("/api/dispatcher/assignments").set(bo).send(commit1);
  expect(boBlocked.status).toBe(409);
  expect(boBlocked.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect(boBlocked.body.lock.laneId).toBe(driver.id);
  expect(boBlocked.body.lock.name).toBe("Ann");

  // 2. The guard ran BEFORE the write: refusing the mutation must not leave
  //    an assignment behind. This is the assertion that actually pins the
  //    guard's placement ahead of the transaction.
  expect(await prisma.assignment.count()).toBe(0);

  // 3. Once Ann releases the lane, Bo's identical POST succeeds.
  const unlock = await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(ann);
  expect(unlock.status).toBe(204);
  const boNowAllowed = await request(app).post("/api/dispatcher/assignments").set(bo).send(commit1);
  expect(boNowAllowed.status).toBe(201);
  const assignmentBo = boNowAllowed.body.assignment as { id: string };

  // 4. Ann re-takes the SAME lane and commits on it herself -> 201. The
  //    holder is never blocked from their own lane. A far-future availableAt
  //    keeps this plan from overlapping the driver's freshly-committed load1
  //    trip, so this 201 is a real feasible commit, not a fluke.
  const reLock = await request(app).post("/api/dispatcher/locks").set(ann).send({ laneId: driver.id });
  expect(reLock.status).toBe(200);
  const farAvailableAt = Date.now() + 5 * 24 * 60 * 60 * 1000;
  const annOwnLane = await request(app).post("/api/dispatcher/assignments").set(ann).send({
    loadId: load2.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id,
    availableAt: farAvailableAt,
  });
  expect(annOwnLane.status).toBe(201);
  const assignmentAnn = annOwnLane.body.assignment as { id: string };

  // 5. DELETE /assignments/:id and POST /assignments/:id/status are guarded
  //    too — Ann still holds the lane, so Bo is refused on both, while Ann
  //    (the holder) can still act. Two different assignments so neither
  //    check disturbs the other's precondition (delete needs "assigned",
  //    status advance needs "assigned").
  const boDelete = await request(app).delete(`/api/dispatcher/assignments/${assignmentAnn.id}`).set(bo);
  expect(boDelete.status).toBe(409);
  expect(boDelete.body.error).toBe("ENTITY_ALREADY_LOCKED");

  const boStatus = await request(app)
    .post(`/api/dispatcher/assignments/${assignmentBo.id}/status`)
    .set(bo)
    .send({ status: "in_progress" });
  expect(boStatus.status).toBe(409);
  expect(boStatus.body.error).toBe("ENTITY_ALREADY_LOCKED");

  // Bonus discrimination check: Ann, the holder, is not blocked on these
  // routes either — proving the guard actually discriminates by dispatcher
  // rather than refusing everyone once a lock exists.
  const annDelete = await request(app).delete(`/api/dispatcher/assignments/${assignmentAnn.id}`).set(ann);
  expect(annDelete.status).toBe(200);
  const annStatus = await request(app)
    .post(`/api/dispatcher/assignments/${assignmentBo.id}/status`)
    .set(ann)
    .send({ status: "in_progress" });
  expect(annStatus.status).toBe(200);
});

it("closes the cross-tenant DoS: a foreign org's laneId is 404, and the driver's own org can still commit", async () => {
  // Cockpit S2a Task 3, fix round 2. POST/DELETE /api/dispatcher/locks used
  // to perform NO ownership check on laneId at all. Harmless while the lock
  // table was bucketed by org; once Ruling 14 flattened it to
  // Map<laneId, Lock> (one lock per lane, globally), a lock taken on ANY
  // org's driver id became visible to that driver's own org's guardLane()
  // above — so a dispatcher in an unrelated org, knowing only another org's
  // driver UUID, could lock it and deny that org's own dispatcher their own
  // driver: a working cross-tenant DoS, plus the 409 body naming the
  // attacker. This proves the fix closes it end to end — the foreign
  // attempt is refused before it can touch the lock table at all, and the
  // driver's real org still commits normally afterward — not merely that
  // POST /locks now returns a different status code.
  const { driver, tractor, trailer, load1, org } = await seed();
  const rival = await prisma.org.create({ data: { name: "Rival Fleet" } });
  const attacker = await scopedDispatcher(rival.id, "Mallory");
  const owner = await scopedDispatcher(org.id, "Ann");

  // Org B, knowing only org A's driver UUID, tries to lock it.
  const attack = await request(app).post("/api/dispatcher/locks").set(attacker).send({ laneId: driver.id });
  expect(attack.status).toBe(404);
  expect(attack.body.error).toBe("Driver not found");
  // The refused attempt must not have left a lock behind.
  expect((await request(app).get("/api/dispatcher/locks").set(owner)).body.locks).toEqual([]);

  // Org A's own dispatcher can still commit on their own driver — the DoS is
  // closed end to end, not just at the lock endpoint's status code.
  const commit = await request(app).post("/api/dispatcher/assignments").set(owner).send({
    loadId: load1.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  expect(commit.status).toBe(201);
  expect(await prisma.assignment.count()).toBe(1);
});

it("a scoped dispatcher and an unscoped (legacy) dispatcher genuinely contend for the same lane, in either order", async () => {
  // This is the exact hole the bucketed design had: an unscoped dispatcher's
  // lock/mutation used to land in a different bucket than a scoped
  // dispatcher's, so a scoped holder's lock never refused an unscoped
  // mutator (and vice versa) even though middleware/orgScope.ts's own stance
  // is that an unscoped account can reach every org's data. lib/locks.ts's
  // table is now global by laneId, so this must refuse in both directions.
  const { driver, tractor, trailer, load1, load2, org } = await seed();
  const ann = await scopedDispatcher(org.id, "Ann");
  const cy = await unscopedDispatcher("Cy");
  const commitFor = (loadId: string) => ({ loadId, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });

  // Scoped holds the lane; the unscoped dispatcher's commit is refused.
  expect((await request(app).post("/api/dispatcher/locks").set(ann).send({ laneId: driver.id })).status).toBe(200);
  const cyBlocked = await request(app).post("/api/dispatcher/assignments").set(cy).send(commitFor(load1.id));
  expect(cyBlocked.status).toBe(409);
  expect(cyBlocked.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect(cyBlocked.body.lock.dispatcherId).toBeDefined();
  expect(await prisma.assignment.count()).toBe(0);
  expect((await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(ann)).status).toBe(204);

  // Unscoped holds the SAME lane; the scoped dispatcher's commit is refused.
  expect((await request(app).post("/api/dispatcher/locks").set(cy).send({ laneId: driver.id })).status).toBe(200);
  const annBlocked = await request(app).post("/api/dispatcher/assignments").set(ann).send(commitFor(load2.id));
  expect(annBlocked.status).toBe(409);
  expect(annBlocked.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect(await prisma.assignment.count()).toBe(0);
});

// ---------------------------------------------------------------------------
// Cockpit S2a, final wave: the assignment guard must not be a cross-tenant
// oracle.
//
// POST /assignments validated the LOAD's tenancy, then called guardLane() on
// the RAW request body's driverId, and only afterwards checked that the driver
// belonged to that load's org. lib/locks.ts's table is global by laneId (which
// is correct — see that file's header), so the guard happily answered
// questions about a lane in a different tenant: a dispatcher in org B, holding
// nothing but one open Load of her own, could name any org A driver id and
// read back a per-driver oracle — 409 carrying org A's dispatcher name,
// dispatcher UUID, org UUID and lock timestamps when that lane was held, a
// plain 404 when it was not. `dryRun: true` made it a pure read, and no rate
// limit applies.
//
// The fix resolves the driver against the CALLER's org before the guard runs,
// so a foreign driver id is refused with the same bare 404 whether or not the
// lane is locked. The assertion that matters is the absence of the holder's
// identity in the body — a status-code assertion alone would still pass if a
// future refactor moved the leak into a 404 payload.
// ---------------------------------------------------------------------------

/** Dispatcher whose id the leak assertions need, alongside its auth header. */
async function namedDispatcher(orgId: string, name: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `${name.toLowerCase()}-probe@x.com`, passwordHash: "x", name, orgId },
  });
  return { id: disp.id, auth: { Authorization: `Bearer ${signDispatcherAccess(disp.id)}` } };
}

/** An open load in `orgId` — the one thing the attacker needs of her own. */
async function openLoad(orgId: string, reference: string) {
  return prisma.load.create({
    data: {
      orgId, externalId: reference, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
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
}

it("never answers a lock question about another org's driver — no holder identity, and locked and unlocked are indistinguishable", async () => {
  const { driver, org } = await seed();
  // A second org A driver, deliberately left UNLOCKED, so the two arms of the
  // oracle can be compared directly.
  const quietDriver = await prisma.driver.create({
    data: { email: "quiet@x.com", passwordHash: "x", name: "Quiet", orgId: org.id, lastLat: KC.lat, lastLng: KC.lng },
  });
  const ann = await namedDispatcher(org.id, "Ann");

  const rival = await prisma.org.create({ data: { name: "Rival Fleet" } });
  const mallory = await namedDispatcher(rival.id, "Mallory");
  const mallorysLoad = await openLoad(rival.id, "RIVAL-L1");

  // Org A's own dispatcher takes org A's lane, entirely legitimately.
  const held = await request(app).post("/api/dispatcher/locks").set(ann.auth).send({ laneId: driver.id });
  expect(held.status).toBe(200);
  const lock = held.body.lock as { since: number; expiresAt: number };

  const probe = (driverId: string) =>
    request(app).post("/api/dispatcher/assignments").set(mallory.auth).send({
      loadId: mallorysLoad.id, driverId, tractorId: "any", trailerId: "any", dryRun: true,
    });

  const onLocked = await probe(driver.id);
  const onUnlocked = await probe(quietDriver.id);

  // 1. THE finding. Nothing about org A's lock may cross the tenant boundary:
  //    not the holder's name, not her dispatcher UUID, not the org UUID, not
  //    the timestamps that reveal when org A started working that lane.
  const leaked = JSON.stringify(onLocked.body);
  expect(leaked).not.toContain("Ann");
  expect(leaked).not.toContain(ann.id);
  expect(leaked).not.toContain(org.id);
  expect(leaked).not.toContain(String(lock.since));
  expect(leaked).not.toContain(String(lock.expiresAt));
  expect(onLocked.body.lock).toBeUndefined();

  // 2. The oracle itself: a held lane and a free lane in a foreign org must be
  //    byte-identical refusals, so the response cannot be used to enumerate
  //    which of another tenant's drivers are being worked right now.
  expect(onLocked.status).toBe(404);
  expect(onLocked.status).toBe(onUnlocked.status);
  expect(onLocked.body).toEqual(onUnlocked.body);

  // 3. The refusal is a 404, never a 403 — a 403 would confirm the driver
  //    exists, which is the same enumeration by another route.
  expect(onLocked.status).not.toBe(403);

  // 4. Closing the oracle must not have disarmed the guard: org A's OWN other
  //    dispatcher is still refused on Ann's held lane, with the lock details
  //    she is entitled to see.
  const bo = await namedDispatcher(org.id, "Bo");
  const ownOrgBlocked = await request(app).post("/api/dispatcher/assignments").set(bo.auth).send({
    loadId: (await openLoad(org.id, "ACME-L3")).id,
    driverId: driver.id, tractorId: "any", trailerId: "any", dryRun: true,
  });
  expect(ownOrgBlocked.status).toBe(409);
  expect(ownOrgBlocked.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect(ownOrgBlocked.body.lock.name).toBe("Ann");
});
