import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import * as realtime from "../src/realtime.js";
import * as assignmentActions from "../src/lib/assignmentActions.js";
import { LoadLocked } from "../src/lib/loadLocks.js";
import { disarmVanish, vanishNext } from "./vanish.js";

// Cockpit S2a final review, C1 (CRITICAL): cancelling a TENDERED load used to
// leave the tender standing.
//
// POST /loads/:id/cancel has always permitted `status === "tendered"` — code
// written when "tendered" was an unreachable Load.status, so the arm canceled
// nothing but open loads. Task 6 made it reachable, and a tendered load has a
// live Assignment behind it. The handler flipped the Load to "canceled" and
// walked away, leaving:
//   - the driver's provisionally-consumed HOS consumed, for freight that no
//     longer exists, feeding every later feasibility decision in their cycle;
//   - the leg occupying their lane in every ACTIVE_STATUSES query;
//   - an Accept button live on their phone that flips the canceled load back
//     to "assigned" and puts them on the road with no dispatcher action.
//
// The HOS assertions below compare against the Assignment's own
// hos*Before snapshot columns — the values the server itself persisted at
// tender time — never a number recomputed here, so a handler that restores
// the wrong hours cannot agree with the test by making the same mistake.

beforeEach(async () => {
  await resetDb();
  __resetLocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

let seq = 0;

// Fixture shape copied from tests/tender-commit.test.ts's seed() — same
// geometry (driver parked on the pickup), not reinvented.
async function seed() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: `disp${seq}@x.com`, passwordHash: "x", name: "Dispatcher", orgId: org.id },
  });
  const driver = await prisma.driver.create({
    data: {
      email: `drv${seq}@x.com`, passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: `T-${seq}`, status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: `RF-${seq}`, type: "Reefer", status: "active" },
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
  return {
    org, driver, tractor, trailer, load,
    auth: `Bearer ${signDispatcherAccess(dispatcher.id)}`,
    driverAuth: `Bearer ${signAccess(driver.id)}`,
  };
}

/** Tenders through the REAL commit route, never by writing an Assignment row
 *  directly, so the hos*Before snapshot columns are populated exactly the way
 *  production populates them. */
async function tender(s: Awaited<ReturnType<typeof seed>>) {
  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", s.auth)
    .send({ loadId: s.load.id, driverId: s.driver.id, tractorId: s.tractor.id, trailerId: s.trailer.id, tender: true });
  expect(res.status).toBe(201);
  expect(res.body.assignment.status).toBe("tendered");
  return res.body.assignment as { id: string };
}

it("cancelling a TENDERED load unassigns it: the Assignment is gone, HOS is restored exactly, and the load stays canceled", async () => {
  const s = await seed();
  const tendered = await tender(s);

  // The fixture is only meaningful if the tender actually charged the driver.
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id: tendered.id } });
  const hosWhileTendered = await prisma.hosState.findUniqueOrThrow({ where: { driverId: s.driver.id } });
  expect(before.driveMin).toBeGreaterThan(0);
  expect(hosWhileTendered.driveRemainingMin).toBe(before.hosDriveBefore! - before.driveMin);

  const res = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);
  expect(res.status).toBe(200);

  // The tender is GONE. Asserted first: this is the leak, and it must be the
  // assertion that names the bug rather than a status code further down.
  expect(await prisma.assignment.findUnique({ where: { loadId: s.load.id } })).toBeNull();

  // ...and the hours came back, to the minute, from the persisted snapshot.
  const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: s.driver.id } });
  expect(hos.driveRemainingMin).toBe(before.hosDriveBefore);
  expect(hos.windowRemainingMin).toBe(before.hosWindowBefore);
  expect(hos.cycleRemainingMin).toBe(before.hosCycleBefore);
  expect(hos.minutesSinceBreak).toBe(before.hosBreakBefore);
  // Genuinely moved — the assertions above would also hold for a zero-minute leg.
  expect(hos.driveRemainingMin).toBeGreaterThan(hosWhileTendered.driveRemainingMin);

  // unassign() frees the load back to "open" on its way past; the cancel must
  // still win. A transaction that ran them in the wrong order would leave
  // canceled freight sitting on the backlog.
  const load = await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } });
  expect(load.status).toBe("canceled");
  expect(res.body.status).toBe("canceled");
});

it("the driver cannot resurrect a canceled load: accepting the withdrawn tender is 404 and the load stays canceled", async () => {
  const s = await seed();
  const tendered = await tender(s);

  expect((await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth)).status).toBe(200);

  // The live demonstration in the review: 200 here flipped Load.status back to
  // "assigned" and put Jake on the road with a load nobody had assigned him.
  const accept = await request(app).post(`/api/driver/tenders/${tendered.id}/accept`).set("authorization", s.driverAuth);
  expect(accept.status).toBe(404);

  const load = await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } });
  expect(load.status).toBe("canceled");
});

it("the canceled tender's driver is freed: a fresh load over the same window is now feasible", async () => {
  const s = await seed();
  await tender(s);
  await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);

  // Same driver, same equipment, same default window as the withdrawn tender:
  // the only thing that can refuse this is the canceled leg still occupying
  // the lane in the ACTIVE_STATUSES overlap query.
  const replacement = await prisma.load.create({
    data: {
      orgId: s.org.id, requiredEquip: "Reefer", revenueCents: 25000, fscCents: 3000, status: "open",
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

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", s.auth)
    .send({ loadId: replacement.id, driverId: s.driver.id, tractorId: s.tractor.id, trailerId: s.trailer.id });

  expect((res.body.conflicts ?? []).filter((c: { kind: string }) => c.kind === "overlap")).toEqual([]);
  expect(res.status).toBe(201);
});

it("cancelling a tendered load tells the driver's app and the org's boards", async () => {
  const s = await seed();
  const tendered = await tender(s);
  const toDriver = vi.spyOn(realtime, "emitToDriver");
  const toBoards = vi.spyOn(realtime, "emitToDispatchers");

  expect((await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth)).status).toBe(200);

  // The driver's app is holding an offer with an Accept button. Silence here
  // leaves it live on their phone until they next cold-start the app.
  expect(toDriver.mock.calls).toHaveLength(1);
  const [driverId, event, payload] = toDriver.mock.calls[0] as [string, string, Record<string, unknown>];
  expect(driverId).toBe(s.driver.id);
  expect(event).toBe("trip_unassignment");
  expect(payload.loadId).toBe(s.load.id);

  // A4 Task 9: board_update retired here — the load moved through the one
  // writer (unassign back to "open", then to "canceled" in the same
  // transaction), and load_changed carries the version that move landed on.
  // It names neither the assignment nor the driver (that's the trip_*
  // event's job above); a board keys off the load's own id and version.
  const changed = toBoards.mock.calls.filter((c) => c[1] === "load_changed");
  expect(changed).toHaveLength(1);
  const fresh = await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } });
  expect(changed[0]![2]).toMatchObject({ loadId: s.load.id, version: fresh.version, fields: ["status"] });
  expect(fresh.status).toBe("canceled");
  // The assignment tendered above is exactly the one this cancel had to undo.
  expect(await prisma.assignment.findUnique({ where: { id: tendered.id } })).toBeNull();
});

it("cancelling a plain OPEN load still works and stays silent towards the driver channel", async () => {
  const s = await seed();
  const toDriver = vi.spyOn(realtime, "emitToDriver");

  const res = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);

  expect(res.status).toBe(200);
  expect(res.body.status).toBe("canceled");
  // No assignment ever existed, so no driver is holding anything to withdraw.
  expect(toDriver).not.toHaveBeenCalled();
});

// --- The refusal tells you the right button (final review, wording nit) -----
// Every 409 from cancel and edit used to end "unassign it before …". That is
// true only for an ASSIGNED load: a tendered one is withdrawn, and a rolling
// or delivered one cannot be unassigned at all (DELETE /assignments refuses
// anything past PRE_ROLL_STATUSES), so the instruction sent dispatchers to a
// button that would 409 them a second time.

it("editing a TENDERED load says to withdraw the tender, not to unassign", async () => {
  const s = await seed();
  await tender(s);

  const res = await request(app).patch(`/api/dispatcher/loads/${s.load.id}`)
    .set("authorization", s.auth).send({ revenueCents: 45000 });

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("load is tendered; withdraw the tender first");
  expect(res.body.error).not.toContain("unassign");

  // ...and the edit really was refused.
  expect((await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } })).revenueCents).toBe(30000);
});

it("cancelling a ROLLING load does not tell the dispatcher to unassign it — DELETE /assignments would refuse that too", async () => {
  const s = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", s.auth)
    .send({ loadId: s.load.id, driverId: s.driver.id, tractorId: s.tractor.id, trailerId: s.trailer.id });
  expect(commit.status).toBe(201);
  expect((await request(app).post(`/api/dispatcher/assignments/${commit.body.assignment.id}/status`)
    .set("authorization", s.auth).send({ status: "in_progress" })).status).toBe(200);

  const res = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("load is in_progress; a rolling or delivered load can no longer be changed");
  expect(res.body.error).not.toContain("unassign");
});

it("cancelling an ASSIGNED load still says to unassign — the one status that message was ever right for", async () => {
  const s = await seed();
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", s.auth)
    .send({ loadId: s.load.id, driverId: s.driver.id, tractorId: s.tractor.id, trailerId: s.trailer.id });
  expect(commit.status).toBe(201);

  const res = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);

  expect(res.status).toBe(409);
  expect(res.body.error).toBe("load is assigned; unassign it first");
});

// --- The cancel transaction must answer when it loses a race ----------------
// A regression the C1 fix itself introduced: wrapping cancel in a sixth
// Serializable transaction without the write-conflict mapping the rest of this
// wave established as mandatory. The race needs no exotic timing — it is the
// dispatcher pressing Cancel as the driver taps Reject. The decline deletes
// the Assignment first, this transaction's tx.assignment.delete raises P2025,
// and with nothing mapping it Express 4 sends no response at all.
//
// The second assertion is the one that makes this urgent rather than untidy:
// unassign() has already freed the load back to "open", so the freight the
// broker just pulled is on the backlog and bookable while the dispatcher is
// still watching a spinner. A 409 they can act on is the whole difference.

it("answers 409 — not silence — when the tender is answered mid-cancel (P2025)", async () => {
  const s = await seed();
  await tender(s);

  vanishNext("Assignment", "delete");
  const res = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);
  disarmVanish();

  expect(res.status).toBe(409);
  expect(res.body.error).toBe(
    "This load's tender was answered while you were canceling — refresh the board and cancel again",
  );

  // The transaction rolled back cleanly: the load is NOT sitting on the
  // backlog as "open" with its tender half-dismantled.
  const load = await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } });
  expect(load.status).toBe("tendered");
  expect(await prisma.assignment.findUnique({ where: { loadId: s.load.id } })).not.toBeNull();

  // ...and the retry the message asks for actually works.
  const retry = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);
  expect(retry.status).toBe(200);
  expect((await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } })).status).toBe("canceled");
}, 20_000);

// --- Fix round 1: a never-hang net for a LoadLocked from deep inside unassign
//
// unassign()'s status write now passes bypassLock:true here (a cancellation
// must never hang behind another dispatcher's Cockpit edit lock), so
// assertWritable is never actually consulted on this path today — this test
// forces the one failure mode the cancel route still has to answer cleanly
// if that ever changes: a LoadLocked bubbling up from unassign() must map to
// a clean 409, never a hang (Express 4 does not await handlers) and never a
// bare 500.

it("cancel maps a LoadLocked from unassign to a clean 409 — a never-hang net, not a hang or a 500", async () => {
  const s = await seed();
  await tender(s);

  const fakeLock = {
    loadId: s.load.id, orgId: s.org.id, dispatcherId: "disp-maria", by: "Maria",
    since: Date.now(), expiresAt: Date.now() + 60_000,
  };
  const spy = vi.spyOn(assignmentActions, "unassign").mockRejectedValueOnce(new LoadLocked(fakeLock));

  const res = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);
  spy.mockRestore();

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
  // The transaction rolled back whole: the tender is still standing, not
  // half-torn-down by a write that landed before the throw.
  expect((await prisma.load.findUniqueOrThrow({ where: { id: s.load.id } })).status).toBe("tendered");
  expect(await prisma.assignment.findUnique({ where: { loadId: s.load.id } })).not.toBeNull();
});

it("editing a CANCELED load says to reopen it, not that it is already canceled", async () => {
  // nextStepFor("canceled") served two paths and described only one. "It is
  // already canceled" answers a dispatcher who pressed Cancel; a dispatcher
  // who pressed Edit needs the button that actually exists for them, and
  // POST /loads/:id/reopen is it.
  const s = await seed();
  expect((await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth)).status).toBe(200);

  const edit = await request(app).patch(`/api/dispatcher/loads/${s.load.id}`)
    .set("authorization", s.auth).send({ revenueCents: 45000 });
  expect(edit.status).toBe(409);
  expect(edit.body.error).toBe("load is canceled; reopen it first");

  // The cancel path keeps its own, still-correct answer.
  const again = await request(app).post(`/api/dispatcher/loads/${s.load.id}/cancel`).set("authorization", s.auth);
  expect(again.status).toBe(409);
  expect(again.body.error).toBe("load is canceled; it is already canceled");

  // And the advice is true: reopen, then the edit goes through.
  expect((await request(app).post(`/api/dispatcher/loads/${s.load.id}/reopen`).set("authorization", s.auth)).status).toBe(200);
  expect((await request(app).patch(`/api/dispatcher/loads/${s.load.id}`)
    .set("authorization", s.auth).send({ revenueCents: 45000 })).status).toBe(200);
});
