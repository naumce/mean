import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, createDispatcher, loginDispatcher, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { __resetLocks } from "../src/lib/locks.js";
import * as realtime from "../src/realtime.js";

// helpers.ts's createDispatcher() defaults passwordHash to the literal "x",
// which loginDispatcher (real bcrypt.compare via the login route) can never
// match — every dispatcher that needs to log in here must set a real hash.
const PASS = "pass123";
const passwordHash = () => hashPassword(PASS);
let driverSeq = 0;

describe("lane locks", () => {
  beforeEach(async () => {
    await resetDb();
    __resetLocks();
    driverSeq = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Two-org fixture copied from tests/dispatcher-org-scope.test.ts's
  // scopedAuth(), not reinvented — same shape, local to this file. Returns
  // the org too: since S2a Task 3's fix round 2, POST/DELETE /locks resolve
  // laneId to a real Driver and 404 it outside the caller's org, so tests
  // need a driver that's actually IN the org they're locking through.
  async function scopedOrg(orgName: string) {
    const org = await prisma.org.create({ data: { name: orgName } });
    const disp = await prisma.dispatcher.create({
      data: { email: `disp-${orgName}@x.com`, passwordHash: "x", name: orgName, orgId: org.id },
    });
    return { org, auth: { Authorization: `Bearer ${signDispatcherAccess(disp.id)}` } };
  }

  // A real Driver row — required now that the lock routes resolve laneId
  // against Prisma rather than accepting any string. orgId omitted = an
  // orgless/legacy driver (Driver.orgId is nullable).
  async function makeDriver(orgId: string | null = null) {
    driverSeq += 1;
    return prisma.driver.create({
      data: { email: `drv${driverSeq}@x.com`, passwordHash: "x", name: `Driver ${driverSeq}`, orgId },
    });
  }

  it("grants, reports, and releases a lane", async () => {
    const { org } = await scopedOrg("Acme");
    const driver = await makeDriver(org.id);
    await createDispatcher({ email: "a@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("a@f.com", PASS);
    const auth = { Authorization: `Bearer ${token}` };

    const got = await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: driver.id });
    expect(got.status).toBe(200);
    expect(got.body.lock).toMatchObject({ laneId: driver.id });

    const list = await request(app).get("/api/dispatcher/locks").set(auth);
    expect(list.body.locks).toHaveLength(1);

    expect((await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(auth)).status).toBe(204);
    expect((await request(app).get("/api/dispatcher/locks").set(auth)).body.locks).toHaveLength(0);
  });

  it("refuses a lane held by another dispatcher with 409 ENTITY_ALREADY_LOCKED and names the holder", async () => {
    const driver = await makeDriver();
    await createDispatcher({ email: "a@f.com", name: "Ann", passwordHash: await passwordHash() });
    await createDispatcher({ email: "b@f.com", name: "Bo", passwordHash: await passwordHash() });
    const a = await loginDispatcher("a@f.com", PASS);
    const b = await loginDispatcher("b@f.com", PASS);

    await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${a.token}` }).send({ laneId: driver.id });
    const res = await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${b.token}` }).send({ laneId: driver.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ENTITY_ALREADY_LOCKED");
    expect(res.body.lock.name).toBe("Ann"); // the toast must be able to say who
  });

  it("re-POSTing your own lane is a heartbeat, not a conflict", async () => {
    const driver = await makeDriver();
    await createDispatcher({ email: "a@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("a@f.com", PASS);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: driver.id });
    expect((await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: driver.id })).status).toBe(200);
  });

  it("does not release another dispatcher's lane", async () => {
    const driver = await makeDriver();
    await createDispatcher({ email: "a@f.com", passwordHash: await passwordHash() });
    await createDispatcher({ email: "b@f.com", passwordHash: await passwordHash() });
    const a = await loginDispatcher("a@f.com", PASS);
    const b = await loginDispatcher("b@f.com", PASS);
    await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${a.token}` }).send({ laneId: driver.id });
    expect((await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set({ Authorization: `Bearer ${b.token}` })).status).toBe(409);
  });

  it("does not show one org's locks to another", async () => {
    const { org: orgA, auth: authA } = await scopedOrg("Alpha");
    const { auth: authB } = await scopedOrg("Beta");
    const driverA = await makeDriver(orgA.id);

    const acquired = await request(app).post("/api/dispatcher/locks").set(authA).send({ laneId: driverA.id });
    expect(acquired.status).toBe(200);

    expect((await request(app).get("/api/dispatcher/locks").set(authA)).body.locks).toHaveLength(1);
    expect((await request(app).get("/api/dispatcher/locks").set(authB)).body.locks).toEqual([]);
  });

  it("a scoped dispatcher and an unscoped (legacy) one collide on the same lane — 409, not 200", async () => {
    // This is the bug that motivated re-keying the lock table by laneId alone:
    // orgWhere() returns {} for legacy/unscoped dispatchers, so they can
    // genuinely reach every org's drivers, including one a scoped dispatcher
    // is already holding. A table bucketed by org let both callers land in
    // different buckets and both get 200 — two dispatchers each believing
    // they exclusively hold the same lane, which is the pessimistic lock
    // failing at the one thing it exists to do. Checked in both acquisition
    // orders since the bug was order-independent.
    const { org, auth: scoped } = await scopedOrg("Gamma");
    const driver = await makeDriver(org.id);
    await createDispatcher({ email: "legacy@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("legacy@f.com", PASS);
    const unscoped = { Authorization: `Bearer ${token}` };

    // Scoped acquires first; unscoped's attempt on the same lane must be refused.
    const scopedFirst = await request(app).post("/api/dispatcher/locks").set(scoped).send({ laneId: driver.id });
    expect(scopedFirst.status).toBe(200);
    const unscopedBlocked = await request(app).post("/api/dispatcher/locks").set(unscoped).send({ laneId: driver.id });
    expect(unscopedBlocked.status).toBe(409);
    expect(unscopedBlocked.body.error).toBe("ENTITY_ALREADY_LOCKED");

    expect((await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(scoped)).status).toBe(204);

    // Reverse order: unscoped acquires first; scoped's attempt must be refused.
    const unscopedFirst = await request(app).post("/api/dispatcher/locks").set(unscoped).send({ laneId: driver.id });
    expect(unscopedFirst.status).toBe(200);
    const scopedBlocked = await request(app).post("/api/dispatcher/locks").set(scoped).send({ laneId: driver.id });
    expect(scopedBlocked.status).toBe(409);
    expect(scopedBlocked.body.error).toBe("ENTITY_ALREADY_LOCKED");
  });

  it("an unscoped (legacy) dispatcher can still lock any org's driver — the bypass survives the ownership check", async () => {
    // Fix round 2's ownership check must not narrow middleware/orgScope.ts's
    // documented "unscoped dispatcher sees everything" stance. Locking a
    // driver that belongs to a real (unrelated) org proves the bypass, not
    // just the narrower "orgless driver" case.
    const { org } = await scopedOrg("Delta");
    const driver = await makeDriver(org.id);
    await createDispatcher({ email: "legacy2@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("legacy2@f.com", PASS);
    const unscoped = { Authorization: `Bearer ${token}` };

    const res = await request(app).post("/api/dispatcher/locks").set(unscoped).send({ laneId: driver.id });
    expect(res.status).toBe(200);
    expect(res.body.lock).toMatchObject({ laneId: driver.id });
  });

  it("DELETE /locks/:laneId 404s a driver outside the caller's org", async () => {
    const { auth: authA } = await scopedOrg("Epsilon");
    const { org: orgB } = await scopedOrg("Zeta");
    const driverB = await makeDriver(orgB.id);

    const res = await request(app).delete(`/api/dispatcher/locks/${driverB.id}`).set(authA);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Driver not found");
  });

  it("rejects an unauthenticated caller", async () => {
    expect((await request(app).post("/api/dispatcher/locks").send({ laneId: "x" })).status).toBe(401);
  });

  it("does not emit a second lane_lock event for a heartbeat re-POST", async () => {
    const driver = await makeDriver();
    await createDispatcher({ email: "a@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("a@f.com", PASS);
    const auth = { Authorization: `Bearer ${token}` };
    const spy = vi.spyOn(realtime, "emitToDispatchers");

    const first = await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: driver.id });
    expect(first.status).toBe(200);
    const lockEmitsAfterFirst = spy.mock.calls.filter((c) => c[1] === "lane_lock");
    expect(lockEmitsAfterFirst).toHaveLength(1);

    const heartbeat = await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: driver.id });
    expect(heartbeat.status).toBe(200);
    const lockEmitsAfterHeartbeat = spy.mock.calls.filter((c) => c[1] === "lane_lock");
    // Still just the one emit from the first POST — the heartbeat must not
    // have called emitToDispatchers("lane_lock", ...) again.
    expect(lockEmitsAfterHeartbeat).toHaveLength(1);
  });

  // --- Lock VISIBILITY follows the lane, not the holder (final review, I5) ---
  // An unscoped (legacy) dispatcher's lock is ENFORCED against a scoped org --
  // guardLane is global by laneId, as the collision test above proves -- but it
  // used to be INVISIBLE to that org, because the lock carried the HOLDER's
  // orgId (null) and snapshot() filters on `l.orgId === scope`. Org A's board
  // therefore rendered the lane free, the dispatcher dragged, was refused by a
  // holder the board could not name, and the prescribed "refresh on 409"
  // re-fetched a board that STILL showed it free: a retry loop with no exit.
  // The lock now carries the LANE's org, so it is visible to exactly the people
  // it constrains.

  it("a legacy dispatcher's lock on org A's driver is VISIBLE on org A's board", async () => {
    const { org, auth: scoped } = await scopedOrg("Iota");
    const driver = await makeDriver(org.id);
    await createDispatcher({ email: "legacy3@f.com", name: "Legacy Len", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("legacy3@f.com", PASS);
    const unscoped = { Authorization: `Bearer ${token}` };

    expect((await request(app).post("/api/dispatcher/locks").set(unscoped).send({ laneId: driver.id })).status).toBe(200);

    const board = await request(app).get("/api/dispatcher/locks").set(scoped);
    expect(board.body.locks).toHaveLength(1);
    expect(board.body.locks[0]).toMatchObject({ laneId: driver.id, name: "Legacy Len", orgId: org.id });

    // ...and it is genuinely the same lock that refuses them, so the board they
    // refresh after a 409 now explains the 409.
    const refused = await request(app).post("/api/dispatcher/locks").set(scoped).send({ laneId: driver.id });
    expect(refused.status).toBe(409);
    expect(refused.body.lock.name).toBe("Legacy Len");
  });

  it("the lane_lock / lane_unlock broadcasts go to the LANE's org, not the holder's", async () => {
    // Same defect on the push channel: a snapshot the scoped board can fetch is
    // no use if the live event that should have told it never arrives.
    const { org } = await scopedOrg("Kappa");
    const driver = await makeDriver(org.id);
    await createDispatcher({ email: "legacy4@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("legacy4@f.com", PASS);
    const unscoped = { Authorization: `Bearer ${token}` };
    const spy = vi.spyOn(realtime, "emitToDispatchers");

    await request(app).post("/api/dispatcher/locks").set(unscoped).send({ laneId: driver.id });
    await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(unscoped);

    const lock = spy.mock.calls.find((c) => c[1] === "lane_lock");
    const unlock = spy.mock.calls.find((c) => c[1] === "lane_unlock");
    // emitToDispatchers(null, ...) reaches ONLY unscoped sockets -- every
    // dispatcher in org A would have been left out of both.
    expect(lock?.[0]).toBe(org.id);
    expect(unlock?.[0]).toBe(org.id);
  });

  it("an ORGLESS driver's lane stays out of every scoped org's board", async () => {
    // The other direction of the same rule: keying visibility to the lane must
    // not start showing a scoped org a lane it cannot reach. A driver with no
    // org is nobody's, and no scoped dispatcher can lock or mutate that lane.
    const { auth: scoped } = await scopedOrg("Lambda");
    const orphan = await makeDriver(null);
    await createDispatcher({ email: "legacy5@f.com", passwordHash: await passwordHash() });
    const { token } = await loginDispatcher("legacy5@f.com", PASS);
    const unscoped = { Authorization: `Bearer ${token}` };

    expect((await request(app).post("/api/dispatcher/locks").set(unscoped).send({ laneId: orphan.id })).status).toBe(200);

    expect((await request(app).get("/api/dispatcher/locks").set(scoped)).body.locks).toEqual([]);
    expect((await request(app).get("/api/dispatcher/locks").set(unscoped)).body.locks).toHaveLength(1);
  });

  // --- The refused DELETE names the holder (final review, M4) ----------------

  it("DELETE on another dispatcher's lane 409s WITH the holder, not a bare error", async () => {
    // The 409 body was `{ error }` alone, so the client toast that renders
    // `Locked by ${lock.name}` printed "Locked by undefined" -- on the one
    // endpoint the client calls automatically on drawer-close and route-leave,
    // where the dispatcher has no idea what they did wrong. Every other
    // ENTITY_ALREADY_LOCKED in the codebase carries the holder.
    const driver = await makeDriver();
    await createDispatcher({ email: "ann@f.com", name: "Ann", passwordHash: await passwordHash() });
    await createDispatcher({ email: "bo@f.com", name: "Bo", passwordHash: await passwordHash() });
    const ann = await loginDispatcher("ann@f.com", PASS);
    const bo = await loginDispatcher("bo@f.com", PASS);

    await request(app).post("/api/dispatcher/locks").set({ Authorization: `Bearer ${ann.token}` }).send({ laneId: driver.id });
    const res = await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set({ Authorization: `Bearer ${bo.token}` });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ENTITY_ALREADY_LOCKED");
    expect(res.body.lock).toBeDefined();
    expect(res.body.lock.name).toBe("Ann");
    expect(res.body.lock.laneId).toBe(driver.id);
    expect(res.body.lock.dispatcherId).toBe(ann.dispatcher.id);

    // The refusal left the lock alone -- a 409 that also released it would be
    // worse than the missing name.
    expect((await request(app).get("/api/dispatcher/locks").set({ Authorization: `Bearer ${ann.token}` })).body.locks)
      .toHaveLength(1);
  });

  it("DELETE on a lane nobody holds is 204 — the client's triple cleanup must be idempotent", () => {
    // The route-level half of M6. The portal releases a lane on drawer-close,
    // on unmount AND on route-leave; all three fire for one drawer, in an
    // order nobody controls. If the second and third got a 409 the dispatcher
    // would see "locked by someone else" toasts for a lane they just let go of
    // themselves.
    return (async () => {
      const { org, auth } = await scopedOrg("Mu");
      const driver = await makeDriver(org.id);

      // Never locked at all.
      expect((await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(auth)).status).toBe(204);

      // Locked, then released three times over — the real client sequence.
      expect((await request(app).post("/api/dispatcher/locks").set(auth).send({ laneId: driver.id })).status).toBe(200);
      for (let i = 0; i < 3; i++) {
        expect((await request(app).delete(`/api/dispatcher/locks/${driver.id}`).set(auth)).status).toBe(204);
      }
    })();
  });
});
