import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import * as realtime from "../src/realtime.js";
import { disarmVanish, vanishNext } from "./vanish.js";

// Cockpit S2a Task 8: PATCH /assignments/:id/plan — the one endpoint every
// board gesture lands in. A drag in time, a move to another driver's row and a
// right-edge resize are all the same operation: unassign-and-reassign inside
// one Serializable transaction.
//
// Two hazards this suite exists to catch, both of which a merely-green suite
// would hide:
//
//  1. SELF-OVERLAP. The busy-interval query must exclude the assignment being
//     replanned. Without `NOT: { id }` every leg blocks against itself and no
//     move is ever feasible — yet a suite that only asserts "a blocked move
//     returns 422" stays green. `moves a leg in time...` below asserts the
//     absence of an overlap conflict on a plain time shift, which is the only
//     assertion shape that can fail on this bug.
//
//  2. HOS DOUBLE-CHARGE. Restore-then-evaluate-then-decrement must happen in
//     one transaction. On a SAME-driver move the restore is not optional: skip
//     it and the driver pays twice for one leg. `a same-driver time move
//     restores...` pins the re-snapshot to the ORIGINAL snapshot columns, so a
//     skipped restore is an integer mismatch, not a vague "the clocks moved".
//
// HOS expectations are read from the stored hosDriveBefore/hosWindowBefore/
// hosCycleBefore/hosBreakBefore columns, never recomputed in the test — a test
// that reproduces the handler's arithmetic agrees with a handler that gets the
// arithmetic wrong.

beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const DES_MOINES = { lat: 41.5868, lng: -93.625 };
const WICHITA = { lat: 37.6872, lng: -97.3301 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

const MIN = 60_000;
const QUARTER = 15 * MIN;
const HOUR = 60 * MIN;

/** The engine snaps proposedStart onto the 15-minute grid, so every fixture
 *  time is grid-aligned and a "+3h" move lands on an exact, assertable
 *  instant rather than "about three hours later". */
const BASE = Math.ceil((Date.now() + 24 * HOUR) / QUARTER) * QUARTER;

// Deliberately non-round starting clocks: an arithmetic restore drifts off
// these (the trip crosses the 8h cumulative-driving boundary, so a break is
// inserted and minutesSinceBreak is reset to 0 at commit), while the exact
// snapshot restore lands back on them to the minute.
const A_CLOCKS = { driveRemainingMin: 500, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 460 };
const B_CLOCKS = { driveRemainingMin: 600, windowRemainingMin: 800, cycleRemainingMin: 4000, minutesSinceBreak: 100 };
/** Untouched clocks, for fixtures that need room for two legs in a day. */
const FRESH = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

let seq = 0;

async function dispatcherIn(orgId: string | null, name: string) {
  seq += 1;
  const disp = await prisma.dispatcher.create({
    data: { email: `${name.toLowerCase()}-${seq}@x.com`, passwordHash: "x", name, ...(orgId ? { orgId } : {}) },
  });
  return { id: disp.id, auth: { Authorization: `Bearer ${signDispatcherAccess(disp.id)}` } };
}

async function makeDriver(
  orgId: string,
  name: string,
  at: { lat: number; lng: number },
  clocks: typeof A_CLOCKS,
) {
  seq += 1;
  return prisma.driver.create({
    data: {
      email: `drv-${seq}@x.com`, passwordHash: "x", name, orgId,
      hazmatEndorsed: true, lastLat: at.lat, lastLng: at.lng,
      hos: { create: clocks },
    },
  });
}

async function makeLoad(orgId: string, label: string) {
  seq += 1;
  return prisma.load.create({
    data: {
      orgId, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: `${label} KC dock`, lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: `${label} Omaha dock`, lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
}

// Fixture shape copied from tests/dispatcher-assignments.test.ts's seed() —
// same geometry (driver parked on the pickup, so deadhead ~0), not reinvented.
async function seed() {
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const driverA = await makeDriver(org.id, "Jake", KC, A_CLOCKS);
  seq += 1;
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: `T-${seq}`, status: "active" } });
  seq += 1;
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: `RF-${seq}`, type: "Reefer", status: "active" } });
  const load = await makeLoad(org.id, "L1");
  return { org, driverA, tractor, trailer, load };
}

interface Plan { proposedStart: number; proposedEnd: number; driveMin: number; onDutyMin: number }

async function commit(
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ id: string; plan: Plan }> {
  const res = await request(app).post("/api/dispatcher/assignments").set(auth).send({ availableAt: BASE, ...body });
  expect(res.status).toBe(201);
  return { id: res.body.assignment.id as string, plan: res.body.plan as Plan };
}

const patch = (auth: Record<string, string>, id: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/dispatcher/assignments/${id}/plan`).set(auth).send(body);

// ---------------------------------------------------------------------------
// GEOMETRY / CORRECTNESS
// ---------------------------------------------------------------------------

it("moves a leg in time on the same driver: the leg never conflicts with ITSELF, and plannedStart shifts by exactly the requested delta", async () => {
  // HAZARD 1. With the busy-interval query missing `NOT: { id: assignment.id }`
  // the assignment being moved is still in its own busy list, the new window
  // overlaps the old one, and this 200 becomes a 422 carrying an overlap
  // block. No amount of "a blocked move returns 422" testing would notice.
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  const res = await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR });

  // The self-overlap assertion, first so it is the one that names the bug.
  // `?? []` because a 409 body carries no conflicts at all: without it a
  // different self-overlap regression fails here with a TypeError instead of
  // the status assertion's readable message.
  expect((res.body.conflicts ?? []).filter((c: { kind: string }) => c.kind === "overlap")).toEqual([]);
  expect(res.status).toBe(200);
  expect(res.body.forced).toBe(false);

  const moved = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(moved.plannedStart.getTime()).toBe(BASE + 3 * HOUR);
  // Same geometry, so the leg keeps its duration: the whole bar slid 3h.
  // trunc because the engine's proposedEnd carries a fractional millisecond
  // (drive minutes are floats) and `new Date()` truncates toward zero — the
  // same sub-ms loss POST /assignments already persists.
  expect(moved.plannedEnd.getTime()).toBe(Math.trunc(res.body.plan.proposedEnd));
  expect(res.body.plan.proposedStart).toBe(BASE + 3 * HOUR);
});

it("a same-driver time move restores the old plan's HOS before re-charging it — the driver is not billed twice for one leg", async () => {
  // HAZARD 2. The load-bearing assertion is that the NEW snapshot equals the
  // ORIGINAL snapshot: both are the driver's clocks with this leg absent. Skip
  // the restore and the new snapshot is the already-charged state, so the
  // driver silently pays for the leg a second time.
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  const hosAfterCommit = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  // The fixture is only meaningful if the commit actually charged the driver.
  expect(before.driveMin).toBeGreaterThan(0);
  expect(hosAfterCommit.driveRemainingMin).toBe(before.hosDriveBefore! - before.driveMin);

  expect((await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR })).status).toBe(200);

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  // Exact integers, read from the stored snapshot columns rather than
  // recomputed here. A restore that wrote garbage fails these; so does no
  // restore at all.
  expect(after.hosDriveBefore).toBe(before.hosDriveBefore);
  expect(after.hosWindowBefore).toBe(before.hosWindowBefore);
  expect(after.hosCycleBefore).toBe(before.hosCycleBefore);
  expect(after.hosBreakBefore).toBe(before.hosBreakBefore);

  // ...and the live clocks are charged exactly once for exactly one leg.
  const hosAfterMove = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  expect(hosAfterMove.driveRemainingMin).toBe(after.hosDriveBefore! - after.driveMin);
  expect(hosAfterMove.windowRemainingMin).toBe(after.hosWindowBefore! - after.onDutyMin);
  expect(hosAfterMove.cycleRemainingMin).toBe(after.hosCycleBefore! - after.onDutyMin);
  // Same geometry moved in time consumes the same hours, so the clocks land
  // where the original commit left them — not one leg further down.
  expect(hosAfterMove.driveRemainingMin).toBe(hosAfterCommit.driveRemainingMin);
  expect(hosAfterMove.windowRemainingMin).toBe(hosAfterCommit.windowRemainingMin);
  expect(hosAfterMove.cycleRemainingMin).toBe(hosAfterCommit.cycleRemainingMin);
});

it("moves a leg to another driver: the old driver's clocks are restored EXACTLY from the stored snapshot, the new driver's are charged", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", KC, B_CLOCKS);
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  // Captured BEFORE the patch: the replan overwrites these columns with the
  // NEW driver's clocks, so the old driver's expectation has to be taken now.
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  const bBeforeMove = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverB.id } });

  const res = await patch(disp.auth, id, { driverId: driverB.id });
  expect(res.status).toBe(200);
  expect(res.body.assignment.driverId).toBe(driverB.id);

  // The OLD driver is made whole, to the minute, from the snapshot columns.
  const aHos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  expect(aHos.driveRemainingMin).toBe(before.hosDriveBefore);
  expect(aHos.windowRemainingMin).toBe(before.hosWindowBefore);
  expect(aHos.cycleRemainingMin).toBe(before.hosCycleBefore);
  expect(aHos.minutesSinceBreak).toBe(before.hosBreakBefore);

  // The NEW driver is charged: the fresh snapshot is B's own pre-move state
  // (never A's), and the live clocks are that state minus this one leg.
  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(after.driverId).toBe(driverB.id);
  expect(after.hosDriveBefore).toBe(bBeforeMove.driveRemainingMin);
  expect(after.hosWindowBefore).toBe(bBeforeMove.windowRemainingMin);
  expect(after.hosCycleBefore).toBe(bBeforeMove.cycleRemainingMin);
  expect(after.hosBreakBefore).toBe(bBeforeMove.minutesSinceBreak);

  const bHos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverB.id } });
  expect(bHos.driveRemainingMin).toBe(after.hosDriveBefore! - after.driveMin);
  expect(bHos.windowRemainingMin).toBe(after.hosWindowBefore! - after.onDutyMin);
  expect(bHos.cycleRemainingMin).toBe(after.hosCycleBefore! - after.onDutyMin);
  // B's clocks genuinely moved — the assertions above would also hold for a
  // zero-minute leg.
  expect(bHos.driveRemainingMin).toBeLessThan(bBeforeMove.driveRemainingMin);
});

it("right-edge resize: an extended plannedEnd is honoured verbatim and the start is untouched", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id, plan } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  // Integer epoch-ms, the way a client sends it.
  const held = Math.trunc(plan.proposedEnd) + 2 * HOUR;
  const res = await patch(disp.auth, id, { plannedEnd: held });
  expect(res.status).toBe(200);

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(after.plannedEnd.getTime()).toBe(held);
  expect(after.plannedStart.getTime()).toBe(plan.proposedStart);
  // The engine's own plan is still reported unchanged — the override widens
  // the persisted window, it does not rewrite the engine's verdict.
  expect(res.body.plan.proposedEnd).toBe(plan.proposedEnd);
});

it("refuses a resize that shrinks the leg below what the drive actually takes (plan_too_short), and writes nothing", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id, plan } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });

  const res = await patch(disp.auth, id, { plannedEnd: plan.proposedEnd - 60 * MIN });
  expect(res.status).toBe(422);
  expect(res.body.error).toBe("plan_too_short");
  // The verdict still carries the engine's plan so the board can snap the bar
  // back to a legal width instead of just flashing an error.
  expect(res.body.plan.proposedEnd).toBe(plan.proposedEnd);

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(after.plannedEnd.getTime()).toBe(before.plannedEnd.getTime());
  expect(after.plannedStart.getTime()).toBe(before.plannedStart.getTime());
});

it("the plan_too_short boundary is INCLUSIVE: exactly proposedEnd - 15min succeeds, one minute less is refused", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id, plan } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  // EXACTLY on the boundary: allowed. Not "about 15 minutes" — the literal
  // value the rule names.
  const onBoundary = plan.proposedEnd - QUARTER;
  const ok = await patch(disp.auth, id, { plannedEnd: onBoundary });
  expect(ok.status).toBe(200);
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).plannedEnd.getTime())
    .toBe(Math.trunc(onBoundary));

  // ONE MILLISECOND past it: refused. A ±1ms pair is the sharpest possible
  // statement that the comparison is `<` and not `<=`. The engine's plan is
  // unchanged by the successful resize above (evaluate never reads the
  // persisted plannedEnd), so proposedEnd is still the same reference point.
  const overBoundary = plan.proposedEnd - QUARTER - 1;
  const tooShort = await patch(disp.auth, id, { plannedEnd: overBoundary });
  expect(tooShort.status).toBe(422);
  expect(tooShort.body.error).toBe("plan_too_short");
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).plannedEnd.getTime())
    .toBe(Math.trunc(onBoundary));
});

// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------

it("dryRun returns the verdict and economics and writes NOTHING", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  const hosBefore = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  // Rate's primary key IS loadId (there is no separate id column), so a
  // delete-and-recreate would be invisible to an id comparison. A sentinel
  // value is the stronger probe: only a rewrite can erase it.
  const SENTINEL = -424242;
  await prisma.rate.update({ where: { loadId: load.id }, data: { marginCents: SENTINEL } });

  const res = await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR, dryRun: true });
  expect(res.status).toBe(200);
  expect(res.body.feasible).toBe(true);
  expect(res.body.economics.marginCents).toBeDefined();
  expect(res.body.plan.proposedStart).toBe(BASE + 3 * HOUR);
  // A preview must not pretend to be a commit.
  expect(res.body.assignment).toBeUndefined();

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(after.plannedStart.getTime()).toBe(before.plannedStart.getTime());
  expect(after.plannedEnd.getTime()).toBe(before.plannedEnd.getTime());
  expect(after.hosDriveBefore).toBe(before.hosDriveBefore);
  expect(after.driveMin).toBe(before.driveMin);
  expect(after.marginCents).toBe(before.marginCents);

  expect((await prisma.rate.findUniqueOrThrow({ where: { loadId: load.id } })).marginCents).toBe(SENTINEL);
  const hosAfter = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  expect(hosAfter.driveRemainingMin).toBe(hosBefore.driveRemainingMin);
  expect(hosAfter.minutesSinceBreak).toBe(hosBefore.minutesSinceBreak);
});

it("a blocked move is refused with 422 and writes nothing; the same move with force succeeds and reports forced:true", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const shopTractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "SHOP-1", status: "in_shop" } });
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  const hosBefore = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });

  const blocked = await patch(disp.auth, id, { tractorId: shopTractor.id });
  expect(blocked.status).toBe(422);
  expect(blocked.body.feasible).toBe(false);
  expect(blocked.body.conflicts.map((c: { kind: string }) => c.kind)).toContain("tractor_unavail");

  // Refused means refused: no equipment change, no HOS churn.
  const stillOld = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(stillOld.tractorId).toBe(tractor.id);
  expect(stillOld.hosDriveBefore).toBe(before.hosDriveBefore);
  const hosStill = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  expect(hosStill.driveRemainingMin).toBe(hosBefore.driveRemainingMin);

  const forced = await patch(disp.auth, id, { tractorId: shopTractor.id, force: true });
  expect(forced.status).toBe(200);
  expect(forced.body.forced).toBe(true);
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).tractorId).toBe(shopTractor.id);
});

it("moving onto a driver who already has an overlapping leg is refused with an overlap block", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", KC, B_CLOCKS);
  const tractor2 = await prisma.tractor.create({ data: { orgId: org.id, unit: "1300", status: "active" } });
  const trailer2 = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-2", type: "Reefer", status: "active" } });
  const load2 = await makeLoad(org.id, "L2");
  const disp = await dispatcherIn(org.id, "Ann");

  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  // B is busy over exactly the same window (same availableAt, same geometry).
  await commit(disp.auth, {
    loadId: load2.id, driverId: driverB.id, tractorId: tractor2.id, trailerId: trailer2.id,
  });
  const bHosBefore = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverB.id } });

  const res = await patch(disp.auth, id, { driverId: driverB.id });
  expect(res.status).toBe(422);
  expect(res.body.feasible).toBe(false);
  const overlap = res.body.conflicts.find((c: { kind: string; severity: string }) => c.kind === "overlap");
  expect(overlap).toBeDefined();
  expect(overlap.severity).toBe("block");

  // Nothing moved, and neither driver's clocks were touched.
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).driverId).toBe(driverA.id);
  const bHosAfter = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverB.id } });
  expect(bHosAfter.driveRemainingMin).toBe(bHosBefore.driveRemainingMin);
});

it("refuses to replan a rolling truck: an in_progress assignment is 409", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  const start = await request(app).post(`/api/dispatcher/assignments/${id}/status`).set(disp.auth)
    .send({ status: "in_progress" });
  expect(start.status).toBe(200);
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });

  const res = await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR });
  expect(res.status).toBe(409);
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).plannedStart.getTime())
    .toBe(before.plannedStart.getTime());
});

it("cross-org ids are 404, never 403 — both the assignment itself and the target driver", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const owner = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(owner.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });

  const rivalOrg = await prisma.org.create({ data: { name: "Rival Fleet" } });
  const rivalDriver = await makeDriver(rivalOrg.id, "Mallory Driver", KC, B_CLOCKS);
  const mallory = await dispatcherIn(rivalOrg.id, "Mallory");

  // 1. Another org's assignment id reads as "not found".
  const foreign = await patch(mallory.auth, id, { availableAt: BASE + 3 * HOUR });
  expect(foreign.status).toBe(404);
  expect(foreign.status).not.toBe(403);

  // 2. The caller's OWN assignment moved onto a foreign driver is equally
  //    "not found" — the target driver is org-validated, not just the row.
  const foreignTarget = await patch(owner.auth, id, { driverId: rivalDriver.id });
  expect(foreignTarget.status).toBe(404);
  expect(foreignTarget.status).not.toBe(403);

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(after.driverId).toBe(driverA.id);
  expect(after.plannedStart.getTime()).toBe(before.plannedStart.getTime());
  const rivalHos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: rivalDriver.id } });
  expect(rivalHos.driveRemainingMin).toBe(B_CLOCKS.driveRemainingMin);
});

it("refuses when another dispatcher holds a lane the replan touches — the source lane AND the target driver's lane", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", DES_MOINES, B_CLOCKS);
  const ann = await dispatcherIn(org.id, "Ann");
  const bo = await dispatcherIn(org.id, "Bo");
  const { id } = await commit(bo.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });

  // Ann holds the lane the leg currently sits in.
  expect((await request(app).post("/api/dispatcher/locks").set(ann.auth).send({ laneId: driverA.id })).status).toBe(200);
  const onSource = await patch(bo.auth, id, { availableAt: BASE + 3 * HOUR });
  expect(onSource.status).toBe(409);
  expect(onSource.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect(onSource.body.lock.name).toBe("Ann");
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).plannedStart.getTime())
    .toBe(before.plannedStart.getTime());

  // Ann moves her lock to the lane Bo wants to move the leg INTO.
  expect((await request(app).delete(`/api/dispatcher/locks/${driverA.id}`).set(ann.auth)).status).toBe(204);
  expect((await request(app).post("/api/dispatcher/locks").set(ann.auth).send({ laneId: driverB.id })).status).toBe(200);
  const onTarget = await patch(bo.auth, id, { driverId: driverB.id });
  expect(onTarget.status).toBe(409);
  expect(onTarget.body.error).toBe("ENTITY_ALREADY_LOCKED");
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).driverId).toBe(driverA.id);

  // The holder is never blocked from her own lanes: released, Bo goes through.
  expect((await request(app).delete(`/api/dispatcher/locks/${driverB.id}`).set(ann.auth)).status).toBe(204);
  expect((await patch(bo.auth, id, { driverId: driverB.id })).status).toBe(200);
});

it("replanning a tendered assignment keeps it tendered — a move must not silently accept the offer", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id, tender: true,
  });
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).status).toBe("tendered");

  const res = await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR });
  expect(res.status).toBe(200);
  expect(res.body.assignment.status).toBe("tendered");

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(after.status).toBe("tendered");
  expect(after.tenderedAt).not.toBeNull();
  expect(after.plannedStart.getTime()).toBe(BASE + 3 * HOUR);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).status).toBe("tendered");
});

it("rewrites the Rate snapshot and the deadhead leg for the new plan", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  // A driver parked away from the pickup, so the move produces a real
  // deadhead leg where the original commit had none.
  const driverB = await makeDriver(org.id, "Mona", DES_MOINES, B_CLOCKS);
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  expect(await prisma.deadheadLeg.count({ where: { assignmentId: id } })).toBe(0);
  await prisma.rate.update({ where: { loadId: load.id }, data: { marginCents: -424242 } });

  const res = await patch(disp.auth, id, { driverId: driverB.id });
  expect(res.status).toBe(200);

  // Exactly one leg — a replan must replace the previous leg, not accumulate.
  const legs = await prisma.deadheadLeg.findMany({ where: { assignmentId: id } });
  expect(legs).toHaveLength(1);
  expect(legs[0].miles).toBeGreaterThan(100);
  expect(legs[0].toLat).toBeCloseTo(KC.lat, 3);

  const rate = await prisma.rate.findUniqueOrThrow({ where: { loadId: load.id } });
  expect(rate.marginCents).toBe(res.body.economics.marginCents);
  expect(rate.deadheadMi).toBeCloseTo(res.body.plan.deadheadMi, 3);
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).marginCents)
    .toBe(res.body.economics.marginCents);
});

// ---------------------------------------------------------------------------
// CONTROLLER RULINGS (round 2)
// ---------------------------------------------------------------------------

it("APPENDS the replan's conflicts to the audit trail and never deletes the commit's — the alerts feed must not keep describing a plan that no longer exists", async () => {
  // Ruling 2. Rewriting Rate/DeadheadLeg but writing NO conflicts leaves the
  // alerts feed rendering the ORIGINAL commit's verdict as though it described
  // the current plan: stale data wearing the costume of measured data. Append,
  // never delete.
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  // Inspection expiring mid-trip is a WARN at commit and still a warn after a
  // +3h move, so both plans genuinely produce a conflict to record.
  await prisma.tractor.update({ where: { id: tractor.id }, data: { inspectionExpiresAt: new Date(BASE + 4 * HOUR) } });

  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  expect(await prisma.dispatchConflict.count({ where: { loadId: load.id, kind: "inspection" } })).toBe(1);

  // A distinctive row standing in for accumulated history. If a future "tidy
  // up" starts purging conflicts on replan, this is what fails.
  await prisma.dispatchConflict.create({
    data: {
      orgId: org.id, loadId: load.id, driverId: driverA.id,
      kind: "equipment", severity: "block", detail: "ORIGINAL-COMMIT-AUDIT",
    },
  });
  const beforeCount = await prisma.dispatchConflict.count({ where: { loadId: load.id } });

  const res = await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR });
  expect(res.status).toBe(200);
  expect(res.body.conflicts.length).toBeGreaterThan(0);

  // 1. History survives, verbatim.
  const survivor = await prisma.dispatchConflict.findFirst({ where: { detail: "ORIGINAL-COMMIT-AUDIT" } });
  expect(survivor).not.toBeNull();
  expect(survivor!.severity).toBe("block");

  // 2. The replan's own verdict was recorded — exactly one new row per
  //    conflict the response reported, nothing dropped and nothing invented.
  const afterCount = await prisma.dispatchConflict.count({ where: { loadId: load.id } });
  expect(afterCount).toBe(beforeCount + res.body.conflicts.length);
  expect(await prisma.dispatchConflict.count({ where: { loadId: load.id, kind: "inspection" } })).toBe(2);
});

it("attributes the appended conflicts to the driver the leg MOVED TO, not the one it came from", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", KC, B_CLOCKS);
  const disp = await dispatcherIn(org.id, "Ann");
  await prisma.tractor.update({ where: { id: tractor.id }, data: { inspectionExpiresAt: new Date(BASE + 4 * HOUR) } });
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  const res = await patch(disp.auth, id, { driverId: driverB.id });
  expect(res.status).toBe(200);

  const appended = await prisma.dispatchConflict.findMany({ where: { loadId: load.id, driverId: driverB.id } });
  expect(appended.length).toBe(res.body.conflicts.length);
  // The commit's rows still point at the original driver — history, untouched.
  expect(await prisma.dispatchConflict.count({ where: { loadId: load.id, driverId: driverA.id } })).toBe(1);
});

it("RECOMPUTES empty-miles-saved on a move: dragging a leg onto a much closer driver updates the ROI number instead of leaving the commit-time figure standing", async () => {
  // Ruling 3. savedMi feeds the "EMPTY MI AVOIDED / ROI PROOF" tile. A stale
  // value here is a confident number that is no longer true — invisible unless
  // something specifically checks it CHANGED after a move that should change it.
  const { org, driverA, tractor, trailer, load } = await seed();
  // The committed driver sits far from the pickup...
  await prisma.driver.update({
    where: { id: driverA.id },
    data: { lastLat: DES_MOINES.lat, lastLng: DES_MOINES.lng },
  });
  await prisma.hosState.update({ where: { driverId: driverA.id }, data: FRESH });
  // ...one alternative is parked ON the pickup, one is far away in Wichita.
  const nearDriver = await makeDriver(org.id, "Near", KC, FRESH);
  await makeDriver(org.id, "Far", WICHITA, FRESH);
  const disp = await dispatcherIn(org.id, "Ann");

  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  const atCommit = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  // Choosing the FAR driver saved nothing: the median alternative was closer.
  expect(atCommit.savedMi).toBe(0);
  expect(atCommit.deadheadMi).toBeGreaterThan(100);

  const res = await patch(disp.auth, id, { driverId: nearDriver.id });
  expect(res.status).toBe(200);

  const afterMove = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  // The move eliminated the deadhead, so the saving is real and must be shown.
  expect(afterMove.deadheadMi).toBeCloseTo(0, 1);
  expect(afterMove.savedMi).toBeGreaterThan(100);
  expect(afterMove.savedMi).not.toBe(atCommit.savedMi);

  // And the KPI tile the number feeds agrees with the row.
  const kpis = await request(app).get("/api/dispatcher/kpis").set(disp.auth);
  expect(kpis.body.economics.emptyMilesSavedMi).toBeCloseTo(afterMove.savedMi, 1);
});

it("RE-STAMPS tenderedAt when a tender moves to a different driver, and leaves it alone when the same driver's offer merely shifts in time", async () => {
  // Ruling 4. The new driver must be timed from when THEY were offered the
  // load, not from when the previous driver was.
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", KC, B_CLOCKS);
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id, tender: true,
  });

  // Backdate the offer to an unmistakable hour ago, so "re-stamped" and
  // "untouched" are hours apart rather than milliseconds apart.
  const OFFERED_AT = new Date(Date.now() - HOUR);
  await prisma.assignment.update({ where: { id }, data: { tenderedAt: OFFERED_AT } });

  // 1. Same driver, new time: the same offer at a new hour. Clock stands.
  expect((await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR })).status).toBe(200);
  const sameDriver = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(sameDriver.status).toBe("tendered");
  expect(sameDriver.tenderedAt!.getTime()).toBe(OFFERED_AT.getTime());

  // 2. Different driver: a NEW offer. Clock restarts.
  expect((await patch(disp.auth, id, { driverId: driverB.id })).status).toBe(200);
  const moved = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(moved.driverId).toBe(driverB.id);
  expect(moved.status).toBe("tendered");
  expect(moved.tenderedAt!.getTime()).toBeGreaterThan(OFFERED_AT.getTime());
});

it("a right-edge extension that reaches into the NEXT leg is refused with a renderable overlap conflict, not an opaque 409", async () => {
  // The engine's own overlap check only ever sees proposedEnd, so it cannot
  // see a collision the dispatcher's own extension creates. Without the
  // explicit re-check this surfaces as the in-transaction 409 ("a concurrent
  // dispatch...") — a misleading message for a deterministic, local mistake.
  const { org, driverA, tractor, trailer, load } = await seed();
  await prisma.hosState.update({ where: { driverId: driverA.id }, data: FRESH });
  const laterLoad = await makeLoad(org.id, "L-LATER");
  const disp = await dispatcherIn(org.id, "Ann");

  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });
  // A second leg for the same driver, well clear of the first.
  await commit(disp.auth, {
    loadId: laterLoad.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
    availableAt: BASE + 10 * HOUR,
  });
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id } });

  // Drag the first leg's right edge deep into the second leg's window.
  const intoNextLeg = BASE + 12 * HOUR;
  const res = await patch(disp.auth, id, { plannedEnd: intoNextLeg });
  expect(res.status).toBe(422);
  expect(res.body.feasible).toBe(false);
  const overlap = res.body.conflicts.find(
    (c: { kind: string; severity: string }) => c.kind === "overlap" && c.severity === "block",
  );
  expect(overlap).toBeDefined();
  expect(overlap.detail).toContain("extended window");
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).plannedEnd.getTime())
    .toBe(before.plannedEnd.getTime());

  // `force` overrides the ADVISORY verdict, but not the invariant that one
  // driver cannot be in two places at once: the Serializable guard refuses the
  // double-booking regardless — exactly as POST /assignments does. What it must
  // NOT do is blame a phantom concurrent dispatcher for a collision this
  // dispatcher could see and asked for anyway.
  const forced = await patch(disp.auth, id, { plannedEnd: intoNextLeg, force: true });
  expect(forced.status).toBe(409);
  expect(forced.body.error).toBe("Driver is already committed to an overlapping trip — an overlap cannot be forced");
  expect(forced.body.error).not.toContain("concurrent");
  expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).plannedEnd.getTime())
    .toBe(before.plannedEnd.getTime());
});

// ---------------------------------------------------------------------------
// REALTIME FAN-OUT (S2a final review, I3)
//
// PATCH /plan could emit NOTHING and 46 tests stayed green. A leg dragged from
// Jake to Mona then leaves Jake's phone holding it forever, never tells Mona,
// and every other dispatcher's board keeps rendering it on Jake's lane until
// somebody reloads. The three emits are asserted by NAME and by RECIPIENT,
// because that is what the clients dispatch on.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

it("a same-driver move announces board_update {replanned:true} to the org, naming the load, assignment and lane", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  const toBoards = vi.spyOn(realtime, "emitToDispatchers");
  const toDrivers = vi.spyOn(realtime, "emitToDriver");
  expect((await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR })).status).toBe(200);

  const boards = toBoards.mock.calls.filter((c) => c[1] === "board_update");
  expect(boards).toHaveLength(1);
  const [orgId, , payload] = boards[0] as [string | null, string, Record<string, unknown>];
  expect(orgId).toBe(org.id);
  expect(payload.replanned).toBe(true);
  expect(payload.loadId).toBe(load.id);
  expect(payload.assignmentId).toBe(id);
  expect(payload.driverId).toBe(driverA.id);

  // The leg never left this lane, so neither driver-side event belongs here:
  // telling Jake he has been unassigned and then re-assigned would flash his
  // trip out and back for a three-hour slip.
  expect(toDrivers).not.toHaveBeenCalled();
});

it("moving a leg to another driver tells BOTH phones: trip_unassignment to the old driver, trip_assignment to the new one", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", KC, B_CLOCKS);
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id,
  });

  const toBoards = vi.spyOn(realtime, "emitToDispatchers");
  const toDrivers = vi.spyOn(realtime, "emitToDriver");
  expect((await patch(disp.auth, id, { driverId: driverB.id })).status).toBe(200);

  const eventsFor = (driverId: string) =>
    toDrivers.mock.calls.filter((c) => c[0] === driverId).map((c) => c[1]);
  // Jake's app must drop the trip; Mona's must gain it. Exact arrays, so an
  // extra or a swapped event fails too.
  expect(eventsFor(driverA.id)).toEqual(["trip_unassignment"]);
  expect(eventsFor(driverB.id)).toEqual(["trip_assignment"]);

  const toMona = toDrivers.mock.calls.find((c) => c[0] === driverB.id)!;
  expect((toMona[2] as Record<string, unknown>).assignmentId).toBe(id);
  expect((toMona[2] as Record<string, unknown>).loadId).toBe(load.id);

  const boards = toBoards.mock.calls.filter((c) => c[1] === "board_update");
  expect(boards).toHaveLength(1);
  // The board is told the NEW lane — the whole point of the event is that
  // other dispatchers stop drawing the bar on Jake's row.
  expect((boards[0]![2] as Record<string, unknown>).driverId).toBe(driverB.id);
  expect((boards[0]![2] as Record<string, unknown>).replanned).toBe(true);
});

it("an unanswered OFFER moves as an offer: the new driver gets trip_tender, never trip_assignment", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const driverB = await makeDriver(org.id, "Mona", KC, B_CLOCKS);
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id, tender: true,
  });

  const toDrivers = vi.spyOn(realtime, "emitToDriver");
  expect((await patch(disp.auth, id, { driverId: driverB.id })).status).toBe(200);

  // "trip_assignment" here would render a confirmed trip on Mona's phone for
  // an offer she has not answered — the same failure I2 pins on the commit.
  expect(toDrivers.mock.calls.filter((c) => c[0] === driverB.id).map((c) => c[1])).toEqual(["trip_tender"]);
  expect(toDrivers.mock.calls.filter((c) => c[0] === driverA.id).map((c) => c[1])).toEqual(["trip_unassignment"]);
});

// ---------------------------------------------------------------------------
// P2025 — the row vanished mid-replan (S2a final review, M8)
//
// The catch mapped CommitConflict, P2034 and P2002 but not P2025 ("record to
// update not found"). That is not an exotic race: the DRIVER's own tender
// decline (routes/driver.ts) deletes this exact Assignment and carries no lane
// lock — locks are a dispatcher-vs-dispatcher device — so a dispatcher
// dragging a tendered leg while its driver taps Reject lands squarely on it.
//
// And an unmapped rejection is not a 500. Express 4 does not await handlers,
// so the promise rejects into the void and NO HTTP RESPONSE IS EVER SENT: the
// dispatcher's drag hangs until their client gives up. Without the mapping
// this test does not fail with a status mismatch — it TIMES OUT waiting for a
// reply that never comes, which is precisely the user-visible symptom.
//
// The injection is tests/vanish.ts's shared one-shot middleware — four suites
// now need this and four copies of it would be the drift this wave removed.

it("answers 409 — not silence — when the assignment is deleted out from under the replan (P2025)", async () => {
  const { org, driverA, tractor, trailer, load } = await seed();
  const disp = await dispatcherIn(org.id, "Ann");
  const { id } = await commit(disp.auth, {
    loadId: load.id, driverId: driverA.id, tractorId: tractor.id, trailerId: trailer.id, tender: true,
  });

  vanishNext("Assignment", "update");
  const res = await patch(disp.auth, id, { availableAt: BASE + 3 * HOUR });
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("This assignment no longer exists — refresh the board");

  // The aborted transaction left nothing behind: the driver's clocks were not
  // handed back for a leg that is still charged to them.
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driverA.id } });
  const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
  expect(hos.driveRemainingMin).toBe(row.hosDriveBefore! - row.driveMin);
}, 20_000);
