import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import * as realtime from "../src/realtime.js";
import * as loadWriterModule from "../src/lib/loadWriter.js";
import { disarmVanish, vanishNext } from "./vanish.js";

beforeEach(resetDb);

async function dispatcherAuth(email = "d@x.com") {
  const disp = await prisma.dispatcher.create({ data: { email, passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

async function seed(opts: { trailerType?: string; driverHos?: boolean; hazmat?: string | null; tag?: string } = {}) {
  const tag = opts.tag ?? "";
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const driver = await prisma.driver.create({
    data: {
      email: `drv${tag}@x.com`, passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      ...(opts.driverHos === false
        ? {}
        : { hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } } }),
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: `1207${tag}`, status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: `RF-1${tag}`, type: opts.trailerType ?? "Reefer", status: "active" },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", hazmatClass: opts.hazmat ?? null,
      revenueCents: 30000, fscCents: 4000, status: "open",
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

it("commits a feasible assignment: 201, persists Assignment + Rate, flips load status", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });

  expect(res.status).toBe(201);
  expect(res.body.assignment.loadId).toBe(load.id);
  expect(res.body.economics.marginCents).toBeDefined();
  expect(res.body.plan.deadheadMi).toBeCloseTo(0, 1);

  const persisted = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  expect(persisted?.status).toBe("assigned");
  const rate = await prisma.rate.findUnique({ where: { loadId: load.id } });
  expect(rate).not.toBeNull();
  const updated = await prisma.load.findUnique({ where: { id: load.id } });
  expect(updated?.status).toBe("assigned");
  // Honesty: the commit's planning decrement must never stamp importedAt —
  // freshness belongs to real ELD/import data only.
  const hos = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(hos?.importedAt).toBeNull();
});

it("blocks a commit when the tractor's inspection expired, and warns when it expires mid-trip", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  await prisma.tractor.update({
    where: { id: tractor.id },
    data: { inspectionExpiresAt: new Date(Date.now() - 3600_000) },
  });

  const blocked = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(blocked.status).toBe(422);
  const block = blocked.body.conflicts.find((c: { kind: string }) => c.kind === "inspection");
  expect(block.severity).toBe("block");
  expect(block.detail).toContain("before departure");

  // Expiring during the trip: commit succeeds but the warn is persisted for the feed.
  await prisma.tractor.update({
    where: { id: tractor.id },
    data: { inspectionExpiresAt: new Date(Date.now() + 90 * 60_000) },
  });
  const ok = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(ok.status).toBe(201);
  const persisted = await prisma.dispatchConflict.findMany({ where: { loadId: load.id, kind: "inspection" } });
  expect(persisted).toHaveLength(1);
  expect(persisted[0].severity).toBe("warn");
});

it("walks the lifecycle: start -> in_progress, deliver -> completed; HOS stays consumed; driver freed", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  const id = commit.body.assignment.id as string;
  const hosAfterCommit = await prisma.hosState.findUnique({ where: { driverId: driver.id } });

  const start = await request(app).post(`/api/dispatcher/assignments/${id}/status`)
    .set("authorization", auth).send({ status: "in_progress" });
  expect(start.status).toBe(200);
  expect(start.body.assignment.startedAt).toBeTruthy();
  expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("in_progress");

  // In-progress trips can't be unassigned — only completed forward.
  const un = await request(app).delete(`/api/dispatcher/assignments/${id}`).set("authorization", auth);
  expect(un.status).toBe(409);

  const done = await request(app).post(`/api/dispatcher/assignments/${id}/status`)
    .set("authorization", auth).send({ status: "completed" });
  expect(done.status).toBe(200);
  expect(done.body.assignment.completedAt).toBeTruthy();
  expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("delivered");

  // HOS is NOT restored — those hours were genuinely driven.
  const hosAfterDone = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(hosAfterDone?.driveRemainingMin).toBe(hosAfterCommit?.driveRemainingMin);

  // The driver is free again: a second load in the same window commits cleanly.
  const load2 = await prisma.load.create({
    data: {
      orgId: load.orgId, requiredEquip: "Reefer", revenueCents: 20000, status: "open",
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
  const second = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load2.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(second.status).toBe(201);

  // Backward transitions are refused.
  const backwards = await request(app).post(`/api/dispatcher/assignments/${id}/status`)
    .set("authorization", auth).send({ status: "in_progress" });
  expect(backwards.status).toBe(409);
});

it("refuses to commit another org's driver or equipment (404, no HOS touched)", async () => {
  const auth = await dispatcherAuth();
  const { load, tractor, trailer } = await seed();
  const rival = await prisma.org.create({ data: { name: "Rival" } });
  const rivalDriver = await prisma.driver.create({
    data: {
      email: "rival@x.com", passwordHash: "x", name: "Rival Driver", orgId: rival.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: rivalDriver.id, tractorId: tractor.id, trailerId: trailer.id });

  expect(res.status).toBe(404);
  expect(await prisma.assignment.count()).toBe(0);
  const hos = await prisma.hosState.findUnique({ where: { driverId: rivalDriver.id } });
  expect(hos?.driveRemainingMin).toBe(660);
});

it("unassign restores HOS exactly from the pre-commit snapshot, break counter included", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  // Non-trivial starting clocks so an arithmetic restore would drift.
  await prisma.hosState.update({
    where: { driverId: driver.id },
    data: { driveRemainingMin: 500, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 460 },
  });

  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);

  const un = await request(app)
    .delete(`/api/dispatcher/assignments/${commit.body.assignment.id}`)
    .set("authorization", auth);
  expect(un.status).toBe(200);

  const hos = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(hos?.driveRemainingMin).toBe(500);
  expect(hos?.windowRemainingMin).toBe(700);
  expect(hos?.cycleRemainingMin).toBe(3000);
  expect(hos?.minutesSinceBreak).toBe(460);
});

it("a tendered assignment (not just an assigned one) can be deleted through DELETE /assignments/:id, with HOS restored exactly", async () => {
  // Cockpit S2a Task 7, Ruling 9: DELETE used to guard `status !== "assigned"`,
  // which made a tendered load LESS cancellable than a committed one — exactly
  // backwards, since a tender is an offer the driver hasn't even accepted yet.
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  // Non-trivial starting clocks so an arithmetic restore would drift.
  await prisma.hosState.update({
    where: { driverId: driver.id },
    data: { driveRemainingMin: 500, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 460 },
  });

  const tender = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });
  expect(tender.status).toBe(201);
  expect(tender.body.assignment.status).toBe("tendered");

  const del = await request(app)
    .delete(`/api/dispatcher/assignments/${tender.body.assignment.id}`)
    .set("authorization", auth);
  expect(del.status).toBe(200);
  expect(await prisma.assignment.findUnique({ where: { id: tender.body.assignment.id } })).toBeNull();
  expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("open");

  const hos = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(hos?.driveRemainingMin).toBe(500);
  expect(hos?.windowRemainingMin).toBe(700);
  expect(hos?.cycleRemainingMin).toBe(3000);
  expect(hos?.minutesSinceBreak).toBe(460);
});

it("records empty-miles-saved vs. the median feasible alternative at commit", async () => {
  const auth = await dispatcherAuth();
  const { org, load, driver, tractor, trailer } = await seed();
  // A feasible alternative sitting in Wichita (~170 road-mi from the KC pickup):
  // choosing Jake (deadhead ~0) should bank roughly that many saved miles.
  await prisma.driver.create({
    data: {
      email: "far@x.com", passwordHash: "x", name: "Far Driver", orgId: org.id,
      hazmatEndorsed: true, lastLat: 37.6872, lastLng: -97.3301,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(res.status).toBe(201);

  const persisted = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  expect(persisted?.savedMi).toBeGreaterThan(100);

  const kpis = await request(app).get("/api/dispatcher/kpis").set("authorization", auth);
  expect(kpis.body.economics.emptyMilesSavedMi).toBeCloseTo(persisted!.savedMi, 1);
});

it("empty-miles-saved ignores unknown-HOS drivers — no credit from fictional availability", async () => {
  const auth = await dispatcherAuth();
  const { org, load, driver, tractor, trailer } = await seed();
  // A far-away "alternative" with NO HosState row: feasibility is assumed,
  // so it must not count toward the savings median.
  await prisma.driver.create({
    data: {
      email: "ghost@x.com", passwordHash: "x", name: "No-HOS Driver", orgId: org.id,
      hazmatEndorsed: true, lastLat: 37.6872, lastLng: -97.3301,
    },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(res.status).toBe(201);
  const persisted = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  expect(persisted?.savedMi).toBe(0);
});

it("empty-miles-saved is zero when the chosen driver was the only feasible option", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(res.status).toBe(201);

  const persisted = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  expect(persisted?.savedMi).toBe(0);
});

it("rejects a hard conflict (wrong equipment) with 422 and does not commit", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ trailerType: "DryVan" });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });

  expect(res.status).toBe(422);
  expect(res.body.feasible).toBe(false);
  expect(res.body.conflicts.map((c: { kind: string }) => c.kind)).toContain("equipment");
  expect(await prisma.assignment.findUnique({ where: { loadId: load.id } })).toBeNull();
});

it("commits despite a hard conflict when force=true, marking it forced", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ trailerType: "DryVan" });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, force: true });

  expect(res.status).toBe(201);
  expect(res.body.forced).toBe(true);
  expect(await prisma.assignment.findUnique({ where: { loadId: load.id } })).not.toBeNull();
});

it("is idempotent-guarded: a second assignment for the same load is 409", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const body = { loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id };

  await request(app).post("/api/dispatcher/assignments").set("authorization", auth).send(body);
  const second = await request(app).post("/api/dispatcher/assignments").set("authorization", auth).send(body);
  expect(second.status).toBe(409);
});

it("attaches a warn (not a block) when the driver's HOS was never imported", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ driverHos: false });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });

  expect(res.status).toBe(201); // full-hours assumption -> still feasible
  const hosWarn = res.body.conflicts.find((c: { kind: string; severity: string }) => c.kind === "hos" && c.severity === "warn");
  expect(hosWarn).toBeDefined();
});

it("commit decrements the driver's HOS clocks by the planned minutes", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(res.status).toBe(201);

  const hos = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  const plan = res.body.plan as { driveMin: number; onDutyMin: number };
  expect(hos?.driveRemainingMin).toBe(660 - Math.round(plan.driveMin));
  expect(hos?.windowRemainingMin).toBe(840 - Math.round(plan.onDutyMin));
  expect(hos?.cycleRemainingMin).toBe(4200 - Math.round(plan.onDutyMin));
  expect(hos?.minutesSinceBreak).toBe(Math.round(plan.driveMin)); // no break triggered
});

it("commit persists the deadhead leg when the driver repositions", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  // Move the driver away from the pickup so deadhead > 0.
  await prisma.driver.update({ where: { id: driver.id }, data: { lastLat: 41.5868, lastLng: -93.625 } });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(res.status).toBe(201);

  const legs = await prisma.deadheadLeg.findMany({ where: { assignmentId: res.body.assignment.id } });
  expect(legs).toHaveLength(1);
  expect(legs[0].miles).toBeGreaterThan(100);
  expect(legs[0].costCents).toBeGreaterThan(0);
  expect(legs[0].toLat).toBeCloseTo(KC.lat, 3);
});

it("dryRun previews verdict + economics without writing anything", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ trailerType: "DryVan" }); // blocked pairing

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.feasible).toBe(false);
  expect(res.body.economics.marginCents).toBeDefined();
  expect(res.body.conflicts.map((c: { kind: string }) => c.kind)).toContain("equipment");
  // nothing persisted
  expect(await prisma.assignment.findUnique({ where: { loadId: load.id } })).toBeNull();
  expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("open");
});

it("404s an unknown load and requires auth", async () => {
  const auth = await dispatcherAuth();
  const missing = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: "nope", driverId: "x", tractorId: "y", trailerId: "z" });
  expect(missing.status).toBe(404);

  const noAuth = await request(app).post("/api/dispatcher/assignments")
    .send({ loadId: "a", driverId: "b", tractorId: "c", trailerId: "d" });
  expect(noAuth.status).toBe(401);
});

// --- load_changed fires on every board_update-retired path (A4 Task 9) ------
// This used to pin board_update carrying assignmentId on unassign and on every
// lifecycle transition — the key a board rendered its lane bars under. Both
// sites retired board_update in favor of load_changed (A4 Task 9): a lifecycle
// move and an unassign really are changes to the Load record, so the writer's
// own version tick is what announces them now. load_changed carries no
// assignmentId — a board keys off the load's own id and version, not the leg
// that moved it — so this test now pins loadId + version instead.

it("load_changed fires with the load's own version on unassign and on every lifecycle transition", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  const assignmentId = commit.body.assignment.id as string;

  const spy = vi.spyOn(realtime, "emitToDispatchers");
  const changes = () => spy.mock.calls.filter((c) => c[1] === "load_changed").map((c) => c[2] as Record<string, unknown>);

  expect((await request(app).post(`/api/dispatcher/assignments/${assignmentId}/status`)
    .set("authorization", auth).send({ status: "in_progress" })).status).toBe(200);
  expect(changes()).toHaveLength(1);
  let fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
  expect(changes()[0]).toMatchObject({ loadId: load.id, version: fresh.version, fields: ["status"] });

  expect((await request(app).post(`/api/dispatcher/assignments/${assignmentId}/status`)
    .set("authorization", auth).send({ status: "completed" })).status).toBe(200);
  fresh = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
  expect(changes()[1]).toMatchObject({ loadId: load.id, version: fresh.version, fields: ["status"] });

  // Unassign needs its own committed fixture — the one above is completed and
  // no longer unassignable.
  spy.mockClear();
  const auth2 = await dispatcherAuth("d2@x.com");
  const two = await seed({ tag: "2" });
  const commit2 = await request(app).post("/api/dispatcher/assignments").set("authorization", auth2)
    .send({ loadId: two.load.id, driverId: two.driver.id, tractorId: two.tractor.id, trailerId: two.trailer.id });
  expect(commit2.status).toBe(201);
  spy.mockClear();

  expect((await request(app).delete(`/api/dispatcher/assignments/${commit2.body.assignment.id}`)
    .set("authorization", auth2)).status).toBe(200);
  // The row is deleted by now, but the LOAD it freed is not — naming that
  // load and the version it landed on is exactly how a board knows what moved.
  expect(changes()).toHaveLength(1);
  const twoFresh = await prisma.load.findUniqueOrThrow({ where: { id: two.load.id } });
  expect(changes()[0]).toMatchObject({ loadId: two.load.id, version: twoFresh.version, fields: ["status"] });
  expect(twoFresh.status).toBe("open");
});

// --- One set, two call sites (final review, M7) -----------------------------
// DELETE's inline `!== "assigned" && !== "tendered"` and the replan's
// REPLANNABLE_STATUSES were two spellings of "has not started rolling yet";
// they are now one PRE_ROLL_STATUSES. The replan side of that guard already
// had a 409 test (tests/assignment-plan.test.ts, "refuses to replan a rolling
// truck"); the DELETE side had none, so widening the shared constant would now
// have gone unnoticed on this half of it.

it("refuses to unassign a rolling truck: DELETE on an in_progress assignment is 409 and deletes nothing", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  const id = commit.body.assignment.id as string;
  expect((await request(app).post(`/api/dispatcher/assignments/${id}/status`)
    .set("authorization", auth).send({ status: "in_progress" })).status).toBe(200);

  const res = await request(app).delete(`/api/dispatcher/assignments/${id}`).set("authorization", auth);

  expect(await prisma.assignment.findUnique({ where: { id } })).not.toBeNull();
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("cannot unassign a in_progress assignment");
  // The hours stay consumed: they were genuinely driven.
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driver.id } });
  expect(hos.driveRemainingMin).toBeLessThan(660);
});

// --- P2025 on the COMMIT path too (final review follow-up) ------------------
// PATCH /plan's catch and this one are near-identical twins, and they had
// already drifted: P2025 was mapped on the replan and not here. An unmapped
// rejection is not a 500 — Express 4 does not await handlers, so the promise
// rejects into the void and NO HTTP RESPONSE IS EVER SENT. Both now go through
// one shared respondToWriteConflict(); the `gone` message differs on purpose,
// because on a commit there is no Assignment yet for anything to delete — what
// vanishes is the Load (tx.load.update) or the driver's HosState.
//
// The injection is tests/vanish.ts's shared one-shot middleware.

it("answers 409 — not silence — when the load is deleted out from under a commit (P2025)", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();

  vanishNext("Load", "update");
  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("The load or driver this commit depends on was removed — refresh the board");

  // The aborted transaction left nothing behind: no half-written Assignment,
  // and the driver was not charged for a leg that never committed.
  expect(await prisma.assignment.findUnique({ where: { loadId: load.id } })).toBeNull();
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driver.id } });
  expect(hos.driveRemainingMin).toBe(660);
}, 20_000);

// --- DELETE /assignments/:id's transaction was unmapped too -----------------
// Pre-existing: unassign() has always run in a bare Serializable transaction
// with no catch. Same race as the cancel path — the driver declines the tender
// while the dispatcher presses Unassign — and the same symptom: no response at
// all, because Express 4 does not await handlers.

it("answers 409 — not silence — when the assignment vanishes mid-unassign (P2025)", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });
  expect(commit.status).toBe(201);

  vanishNext("Assignment", "delete");
  const res = await request(app).delete(`/api/dispatcher/assignments/${commit.body.assignment.id}`)
    .set("authorization", auth);
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe(
    "This assignment was already removed — the driver may have declined it. Refresh the board.",
  );

  // Rolled back whole: the HOS restore inside the same transaction did not
  // land on its own, which would have handed the driver back hours for a leg
  // they are still committed to.
  const row = await prisma.assignment.findUniqueOrThrow({ where: { id: commit.body.assignment.id } });
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driver.id } });
  expect(hos.driveRemainingMin).toBe(row.hosDriveBefore! - row.driveMin);
}, 20_000);

// --- F5: an unrecognised error must never leave a handler silent -----------
// Express 4 does not await async handlers, so an uncaught throw out of any of
// these transactions used to answer with nothing at all, forever. One
// representative route is enough (the fix is the identical terminal fallback
// in all six of this file's transactions); the lifecycle transition is the
// simplest to force since it always calls applyStatusChange directly.

it("answers 500 — not silence — when the status writer rejects with an unrecognised error", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  const id = commit.body.assignment.id as string;

  const spy = vi.spyOn(loadWriterModule, "applyStatusChange").mockRejectedValueOnce(new Error("boom"));
  const res = await request(app).post(`/api/dispatcher/assignments/${id}/status`)
    .set("authorization", auth).send({ status: "in_progress" });
  spy.mockRestore();

  expect(res.status).toBe(500);
  expect(res.body).toMatchObject({ error: "INTERNAL" });
});

it("refuses to assign a load someone is editing on Their Board", async () => {
  const auth = await dispatcherAuth();
  const { org, load, driver, tractor, trailer } = await seed();
  await prisma.loadLock.create({
    data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(0);
});

// --- F6: the version moves for every Load write ----------------------------
//
// Assigning and the lifecycle transitions write the LOAD's status, and used
// to leave `version` where it was. A board rendered before the assignment
// still carried that version, so §7.4's backstop waved its write through and
// the cell landed on top of a load that had moved under it.
it("bumps the load's version on assign and on each lifecycle transition", async () => {
  const auth = await dispatcherAuth("f6@x.com");
  const { load, driver, tractor, trailer } = await seed({ tag: "-f6" });
  expect(load.version).toBe(0);

  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(1);

  await request(app).post(`/api/dispatcher/assignments/${commit.body.assignment.id}/status`)
    .set("authorization", auth).send({ status: "in_progress" }).expect(200);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version).toBe(2);

  await request(app).post(`/api/dispatcher/assignments/${commit.body.assignment.id}/status`)
    .set("authorization", auth).send({ status: "completed" }).expect(200);
  const final = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
  expect(final.version).toBe(3);
  expect(final.status).toBe("delivered");
}, 20_000);

// --- Plan A3: assigning writes the load's status through the one writer ----
it("assigning writes the status through the writer: one trace row naming the assignment, one version tick", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });

  expect(res.status).toBe(201);
  const after = await prisma.load.findUnique({ where: { id: load.id } });
  expect([after?.status, after?.version]).toEqual(["assigned", 1]);
  const rows = await prisma.loadChange.findMany({ where: { loadId: load.id, field: "status" } });
  expect(rows).toHaveLength(1);
  expect([rows[0].before, rows[0].after, rows[0].source]).toEqual(["open", "assigned", "loadboard"]);
  expect(rows[0].note).toMatch(/assignment/);
});
