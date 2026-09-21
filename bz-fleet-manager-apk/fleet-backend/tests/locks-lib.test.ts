import { beforeEach, describe, expect, it } from "vitest";
import { __rawSize, __resetLocks, acquire, get, LOCK_TTL_MS, release, releaseAllFor, snapshot, sweep } from "../src/lib/locks.js";

const T0 = 1_800_000_000_000;

describe("lock table", () => {
  beforeEach(() => __resetLocks());

  it("grants a free lane", () => {
    const r = acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(r.ok).toBe(true);
    expect(r.lock).toMatchObject({ laneId: "drv1", orgId: "org1", dispatcherId: "disp1", name: "Ann", since: T0, expiresAt: T0 + LOCK_TTL_MS });
  });

  it("refuses a lane another dispatcher holds, returning who holds it", () => {
    acquire("drv1", "disp1", "Ann", "org1", T0);
    const r = acquire("drv1", "disp2", "Bo", "org1", T0 + 1_000);
    expect(r.ok).toBe(false);
    expect(r.lock.dispatcherId).toBe("disp1");
    expect(r.lock.name).toBe("Ann"); // the 409 body must name the holder
  });

  it("re-acquiring your own lane refreshes the expiry — this is the heartbeat", () => {
    acquire("drv1", "disp1", "Ann", "org1", T0);
    const r = acquire("drv1", "disp1", "Ann", "org1", T0 + 30_000);
    expect(r.ok).toBe(true);
    expect(r.lock.since).toBe(T0);                        // held continuously
    expect(r.lock.expiresAt).toBe(T0 + 30_000 + LOCK_TTL_MS); // but extended
  });

  it("grants a lane whose lock has expired", () => {
    acquire("drv1", "disp1", "Ann", "org1", T0);
    const r = acquire("drv1", "disp2", "Bo", "org1", T0 + LOCK_TTL_MS + 1);
    expect(r.ok).toBe(true);
    expect(r.lock.dispatcherId).toBe("disp2");
  });

  it("treats the exact expiry instant as still held", () => {
    // Boundary discipline: at expiresAt the lock has not yet expired, matching
    // fleet-portal/src/lib/compliance.ts's isExpired convention ("at exactly
    // nowMs === expiry nothing has expired yet").
    acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(acquire("drv1", "disp2", "Bo", "org1", T0 + LOCK_TTL_MS).ok).toBe(false);
  });

  it("locks globally by lane id — a scoped and an unscoped dispatcher collide on the same lane, in either order", () => {
    // This is the bug that made the org-bucketed table unsafe: orgWhere()
    // returns {} for legacy/unscoped dispatchers, so they see (and can act
    // on) every org's lanes. Bucketing the lock table by org meant a scoped
    // holder and an unscoped attacker landed in different buckets and both
    // walked away believing they held the SAME lane. Lane ids are globally
    // unique driver UUIDs, so the lock must be global too — order must not
    // matter.
    const scopedFirst = acquire("drv1", "disp1", "Ann", "orgA", T0);
    expect(scopedFirst.ok).toBe(true);
    const unscopedBlocked = acquire("drv1", "disp9", "Cy", null, T0);
    expect(unscopedBlocked.ok).toBe(false);
    expect(unscopedBlocked.lock.dispatcherId).toBe("disp1");

    __resetLocks();

    const unscopedFirst = acquire("drv2", "disp9", "Cy", null, T0);
    expect(unscopedFirst.ok).toBe(true);
    const scopedBlocked = acquire("drv2", "disp1", "Ann", "orgA", T0);
    expect(scopedBlocked.ok).toBe(false);
    expect(scopedBlocked.lock.dispatcherId).toBe("disp9");
  });

  it("snapshot(scope) filters by the lock's owning org; scope null sees everything", () => {
    acquire("a", "disp1", "Ann", "orgA", T0);
    acquire("b", "disp2", "Bo", "orgB", T0);
    acquire("c", "disp3", "Cy", null, T0); // unscoped/legacy hold
    expect(snapshot("orgA", T0).map((l) => l.laneId)).toEqual(["a"]);
    expect(snapshot("orgB", T0).map((l) => l.laneId)).toEqual(["b"]);
    // null = unscoped legacy caller = sees everything, matching orgWhere()'s
    // documented stance — NOT "only unscoped locks."
    expect(snapshot(null, T0).map((l) => l.laneId).sort()).toEqual(["a", "b", "c"]);
  });

  it("releases only for the holder", () => {
    acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(release("drv1", "disp2", T0)).toBe(false);
    expect(get("drv1", T0)?.dispatcherId).toBe("disp1");
    expect(release("drv1", "disp1", T0)).toBe(true);
    expect(get("drv1", T0)).toBeNull();
  });

  it("get() reports an expired lock as absent without waiting for the sweeper", () => {
    acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(get("drv1", T0 + LOCK_TTL_MS + 1)).toBeNull();
  });

  it("snapshot() omits expired locks", () => {
    acquire("a", "disp1", "Ann", "org1", T0);
    acquire("b", "disp1", "Ann", "org1", T0 + 60_000);
    expect(snapshot("org1", T0 + LOCK_TTL_MS + 1).map((l) => l.laneId)).toEqual(["b"]);
  });

  it("releaseAllFor() drops a disconnected dispatcher's lanes and names them", () => {
    acquire("a", "disp1", "Ann", "org1", T0);
    acquire("b", "disp1", "Ann", "org1", T0);
    acquire("c", "disp2", "Bo", "org1", T0);
    expect(releaseAllFor("disp1").sort()).toEqual(["a", "b"]);
    expect(snapshot("org1", T0).map((l) => l.laneId)).toEqual(["c"]);
  });

  it("sweep() reclaims every expired lane across the whole table, not just the first", () => {
    // A sweeper that only inspects/deletes the table's first entry (in
    // insertion order) is indistinguishable from a correct one on a
    // single-lane test. Seed several lanes with staggered expiries so only a
    // sweeper that walks the WHOLE table can pass this.
    acquire("a", "disp1", "Ann", "org1", T0);              // expires T0+90_000 -> expired at sweep time
    acquire("b", "disp1", "Ann", "org1", T0 + 1_000);      // expires T0+91_000 -> expired at sweep time
    acquire("c", "disp1", "Ann", "org1", T0 + 2_000);      // expires T0+92_000 -> expired at sweep time
    acquire("d", "disp1", "Ann", "org1", T0 + 500_000);    // expires T0+590_000 -> still live at sweep time
    expect(__rawSize()).toBe(4);

    const sweepAt = T0 + LOCK_TTL_MS + 2_500; // past a/b/c's expiry, well before d's
    const removed = sweep(sweepAt);

    expect(removed).toBe(3); // a, b, c — not just the first one inspected
    expect(__rawSize()).toBe(1); // gone from the Map, not just filtered
    expect(get("a", sweepAt)).toBeNull();
    expect(get("b", sweepAt)).toBeNull();
    expect(get("c", sweepAt)).toBeNull();
    expect(get("d", sweepAt)?.laneId).toBe("d"); // the live one survives untouched
  });

  it("distinguishes a new hold from a heartbeat", () => {
    // Narrowed via `.ok &&` before touching `.fresh` — `fresh` only exists on
    // the ok:true branch of acquire()'s return type, so reading `.fresh` off
    // an un-narrowed union call result does not type-check.
    const first = acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(first.ok && first.fresh).toBe(true);
    // same dispatcher, same lane, later — this is the 30 s heartbeat, not news
    const beat = acquire("drv1", "disp1", "Ann", "org1", T0 + 30_000);
    expect(beat.ok && beat.fresh).toBe(false);
    // a different dispatcher taking over an EXPIRED lane is news again
    const after = acquire("drv1", "disp2", "Bo", "org1", T0 + 200_000);
    expect(after.ok && after.fresh).toBe(true);
  });

  // --- release() is IDEMPOTENT (S2a final review, M6) -----------------------
  // release()'s doc comment promises it returns false ONLY when someone else
  // holds the lane, precisely so the client's cleanup on drawer-close, unmount
  // and route-leave -- three paths that routinely fire for one drawer, in any
  // order -- cannot produce a spurious 409 on the second and third. Nothing
  // tested it: every existing case releases a lane the caller is holding, so a
  // variant returning false for a free or expired lane passed both lock
  // suites. The three cases below are the ones that contract is actually
  // about, and none of them has a live holder.

  it("releasing a lane that was NEVER held is a success, not an error", () => {
    expect(release("never-locked", "disp1", T0)).toBe(true);
    expect(__rawSize()).toBe(0);
  });

  it("releasing your own EXPIRED lane succeeds AND clears the remnant from the Map", () => {
    // Asserted through __rawSize(), not snapshot(): snapshot() filters by
    // live() regardless of whether the entry was actually deleted, so it
    // cannot tell a real delete from a decorative one -- the same blind spot
    // that let a no-op sweeper pass, earlier in this plan.
    acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(__rawSize()).toBe(1);

    expect(release("drv1", "disp1", T0 + LOCK_TTL_MS + 1)).toBe(true);
    expect(__rawSize()).toBe(0);
  });

  it("releasing a lane whose lock EXPIRED under ANOTHER dispatcher succeeds — a dead lock has no holder to protect", () => {
    // The discriminating case for the ownership check's ordering: an expired
    // lock must be invisible to it. Refusing here would let one dispatcher's
    // abandoned drawer 409 every other dispatcher's cleanup for the whole
    // process lifetime, since nothing but this call and the sweeper ever
    // removes the entry.
    acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(release("drv1", "disp2", T0 + LOCK_TTL_MS + 1)).toBe(true);
    expect(__rawSize()).toBe(0);
    // ...and it is genuinely free afterwards, not merely reported as released.
    expect(acquire("drv1", "disp2", "Bo", "org1", T0 + LOCK_TTL_MS + 2).ok).toBe(true);
  });

  it("still refuses a LIVE lane held by someone else — idempotency must not become a free-for-all", () => {
    // The other side of the same contract: the three cases above must not have
    // been bought by making release() unconditional.
    acquire("drv1", "disp1", "Ann", "org1", T0);
    expect(release("drv1", "disp2", T0 + LOCK_TTL_MS)).toBe(false); // exact expiry = still held
    expect(get("drv1", T0 + LOCK_TTL_MS)?.dispatcherId).toBe("disp1");
  });
});
