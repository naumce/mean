import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  acquireLoadLock, assertWritable, heldBy, LOAD_LOCK_TTL_MS, LoadLocked, LockTargetGone, releaseAllLoadLocksFor, releaseLoadLock, snapshotLoadLocks, sweepLoadLocks,
} from "../src/lib/loadLocks.js";
import { resetDb } from "./helpers.js";

// Rows, not process memory (spec §5.3): a paste takes every target inside the
// transaction that writes them, and a restart forgets nothing a dispatcher
// still holds. The TTL is the guarantee; release is the optimisation.
async function setup() {
  const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
  const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME" } });
  const maria = { dispatcherId: "disp-maria", dispatcherName: "Maria" };
  const jake = { dispatcherId: "disp-jake", dispatcherName: "Jake" };
  return { org, load, maria, jake };
}

describe("load locks — the table", () => {
  beforeEach(resetDb);

  it("grants a free load, extends the same holder, and refuses another holder naming the first", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    const first = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(first).toMatchObject({ ok: true, fresh: true, lock: { loadId: load.id, by: "Maria", since: t0, expiresAt: t0 + LOAD_LOCK_TTL_MS } });
    const again = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0 + 20_000);
    expect(again).toMatchObject({ ok: true, fresh: false, lock: { since: t0, expiresAt: t0 + 20_000 + LOAD_LOCK_TTL_MS } });
    const other = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0 + 30_000);
    expect(other).toMatchObject({ ok: false, lock: { by: "Maria", dispatcherId: "disp-maria" } });
    expect(await heldBy(prisma, load.id, t0 + 30_000)).toMatchObject({ by: "Maria" });
  });

  it("is held at exactly its expiry and free one millisecond later — then anyone may take it fresh", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(await heldBy(prisma, load.id, t0 + LOAD_LOCK_TTL_MS)).not.toBeNull();
    expect(await heldBy(prisma, load.id, t0 + LOAD_LOCK_TTL_MS + 1)).toBeNull();
    const r = await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0 + LOAD_LOCK_TTL_MS + 1);
    expect(r).toMatchObject({ ok: true, fresh: true, lock: { by: "Jake", since: t0 + LOAD_LOCK_TTL_MS + 1 } });
  });

  it("releases only for the holder; releasing a free or expired lock is a success", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    expect(await releaseLoadLock(prisma, load.id, maria.dispatcherId, t0)).toBe(true);
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0 + 1)).toBe(false);
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0 + LOAD_LOCK_TTL_MS + 1)).toBe(true);
    expect(await prisma.loadLock.count()).toBe(0);
  });

  it("assertWritable: the holder passes, another dispatcher and a system writer are refused with the holder", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    await expect(assertWritable(prisma, load.id, null, t0)).resolves.toBeUndefined();
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    await expect(assertWritable(prisma, load.id, maria.dispatcherId, t0 + 1)).resolves.toBeUndefined();
    await expect(assertWritable(prisma, load.id, jake.dispatcherId, t0 + 1)).rejects.toBeInstanceOf(LoadLocked);
    await expect(assertWritable(prisma, load.id, null, t0 + 1)).rejects.toMatchObject({ lock: { by: "Maria" } });
  });

  it("sweeps expired rows, snapshots one org's live locks, and releases everything a dispatcher held", async () => {
    const { org, load, maria, jake } = await setup();
    const other = await prisma.org.create({ data: { name: "Other", timezone: "UTC" } });
    const theirs = await prisma.load.create({ data: { orgId: other.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "THEIRS" } });
    const second = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, customerName: "ACME 2" } });
    const t0 = 1_760_000_000_000;
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    await acquireLoadLock(prisma, { loadId: second.id, orgId: org.id, ...maria }, t0);
    await acquireLoadLock(prisma, { loadId: theirs.id, orgId: other.id, ...jake }, t0 - LOAD_LOCK_TTL_MS - 5);
    expect((await snapshotLoadLocks(org.id, t0 + 1)).map((l) => l.loadId).sort()).toEqual([load.id, second.id].sort());
    expect(await snapshotLoadLocks(other.id, t0 + 1)).toEqual([]);
    expect(await sweepLoadLocks(t0 + 1)).toBe(1);
    expect((await releaseAllLoadLocksFor(maria.dispatcherId)).map((r) => r.loadId).sort()).toEqual([load.id, second.id].sort());
    expect(await prisma.loadLock.count()).toBe(0);
  });

  it("goes away with its load", async () => {
    const { org, load, maria } = await setup();
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria });
    await prisma.load.delete({ where: { id: load.id } });
    expect(await prisma.loadLock.count()).toBe(0);
  });

  // Fix round 1: acquireLoadLock's fresh-acquire branch used to be a plain
  // `upsert` (INSERT … ON CONFLICT DO UPDATE), which never throws P2002 — two
  // dispatchers racing a free load both got { ok: true, fresh: true }. These
  // three tests pin the atomic behaviour that replaced it.

  it("exactly one of two simultaneous first acquires wins", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    const [a, b] = await Promise.all([
      acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0),
      acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, lock: { by: winners[0]!.lock.by } });
    expect(await prisma.loadLock.count()).toBe(1);
  });

  it("a stale release never removes another dispatcher's live lock", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0);
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0 + 1)).toBe(false);
    expect(await heldBy(prisma, load.id, t0 + 1)).toMatchObject({ by: "Maria" });
  });

  it("re-taking an expired lock is atomic", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, dispatcherId: "disp-gone", dispatcherName: "Gone" }, t0 - LOAD_LOCK_TTL_MS - 5);
    const [a, b] = await Promise.all([
      acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0),
      acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, lock: { by: winners[0]!.lock.by } });
    expect(await prisma.loadLock.count()).toBe(1);
  });

  // R9 (final wave): releaseLoadLock's answer comes from the DELETE, not from
  // the read that preceded it. Both branches of `count === 0` are covered.

  it("releasing a row that is already gone succeeds", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    // Expired: the guarded delete matches it, so this is the ordinary "gone"
    // path — the row is removed and the answer is a success.
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...maria }, t0 - LOAD_LOCK_TTL_MS - 5);
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0)).toBe(true);
    expect(await prisma.loadLock.count()).toBe(0);
    // And releasing nothing at all is still a success (blur/unmount/leave).
    expect(await releaseLoadLock(prisma, load.id, jake.dispatcherId, t0)).toBe(true);
  });

  it("answers false when a third dispatcher took the expired row in the gap, and leaves their lock alone", async () => {
    const { org, load, maria, jake } = await setup();
    const t0 = 1_760_000_000_000;
    // Jake's lock is EXPIRED at t0, so Maria's release passes the pre-read
    // guard and heads for the delete...
    await acquireLoadLock(prisma, { loadId: load.id, orgId: org.id, ...jake }, t0 - LOAD_LOCK_TTL_MS - 5);
    // ...and in that gap a third dispatcher takes it, live. Staged on the
    // client the call is handed (a thin wrapper over the real one, never a
    // stub of the database) because that IS the race: with one consistent
    // read the pre-read guard would always have caught it first, which is
    // exactly why trusting the read alone was wrong. The DELETE below is the
    // real, unmodified guarded delete — it simply now matches nothing.
    const racing = {
      loadLock: {
        findUnique: (args: Parameters<typeof prisma.loadLock.findUnique>[0]) => prisma.loadLock.findUnique(args),
        deleteMany: async (args: Parameters<typeof prisma.loadLock.deleteMany>[0]) => {
          await prisma.loadLock.update({ where: { loadId: load.id }, data: { dispatcherId: "disp-nina", dispatcherName: "Nina", expiresAt: new Date(t0 + LOAD_LOCK_TTL_MS) } });
          return prisma.loadLock.deleteMany(args);
        },
      },
    } as unknown as typeof prisma;
    expect(await releaseLoadLock(racing, load.id, maria.dispatcherId, t0)).toBe(false);
    expect(await heldBy(prisma, load.id, t0)).toMatchObject({ by: "Nina" });
  });

  it("throws LockTargetGone when the load vanished before the lock could be taken", async () => {
    const { org, load, maria } = await setup();
    const goneId = load.id;
    await prisma.load.delete({ where: { id: goneId } });
    await expect(acquireLoadLock(prisma, { loadId: goneId, orgId: org.id, ...maria })).rejects.toBeInstanceOf(LockTargetGone);
  });
});
