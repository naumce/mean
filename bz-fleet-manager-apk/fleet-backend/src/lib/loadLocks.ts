import type { LoadLock, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";

// Load locks (spec §5.3, §7). Same family as the lane locks in lib/locks.ts,
// with one difference on purpose: these are ROWS. A paste takes every target
// inside the transaction that writes them and releases with it; a restart
// forgets nothing a dispatcher still holds. The TTL is the guarantee;
// explicit release and socket-close cleanup are the optimisations.

export const LOAD_LOCK_TTL_MS = 60_000;
export type LockTx = Prisma.TransactionClient | PrismaClient;

export interface LoadLockRow { loadId: string; orgId: string; dispatcherId: string; by: string; since: number; expiresAt: number }
export interface Holder { loadId: string; orgId: string; dispatcherId: string; dispatcherName: string }

/** Thrown by the writer for a load another dispatcher holds; routes answer
 *  409 LOAD_LOCKED with the holder so the badge and the sentence agree. */
export class LoadLocked extends Error {
  constructor(public readonly lock: LoadLockRow) {
    super(`${lock.by} is editing this load`);
  }
}

/** The load a caller tried to lock is not there any more (the FK refused the
 *  row: P2003). Acquiring outside the write transaction — which is what a
 *  paste now does, so a raced P2002 cannot poison it — means the target can
 *  vanish between the ownership check and the lock, and the caller has to be
 *  able to answer 404 rather than a 500. */
export class LockTargetGone extends Error {
  constructor(public readonly loadId: string) {
    super("That load was not found");
  }
}

export const toRow = (l: LoadLock): LoadLockRow => ({
  loadId: l.loadId, orgId: l.orgId, dispatcherId: l.dispatcherId, by: l.dispatcherName, since: l.since.getTime(), expiresAt: l.expiresAt.getTime(),
});

/** Live until strictly past its expiry — at exactly `expiresAt` it is still
 *  held, the same rounding lib/locks.ts chose for lanes and for the same
 *  reason: releasing on the tick it expires lets two people believe they
 *  own it. */
const live = (l: LoadLock, nowMs: number): boolean => nowMs <= l.expiresAt.getTime();

export async function heldBy(tx: LockTx, loadId: string, nowMs = Date.now()): Promise<LoadLockRow | null> {
  const l = await tx.loadLock.findUnique({ where: { loadId } });
  return l && live(l, nowMs) ? toRow(l) : null;
}

/** Take or re-affirm a load. The holder re-affirming keeps `since` (held
 *  continuously) and gets `fresh: false` so callers do not announce it
 *  again; a free or expired lock is a genuine new hold.
 *
 *  Every path below is written so the actual write — not the read that
 *  precedes it — is what decides the winner: `create` races on the unique
 *  `loadId` (Postgres, not us, picks the winner); re-taking an expired row
 *  and re-affirming your own both race on a `updateMany` WHERE that only
 *  matches if the row is still in the state we read it in. A plain
 *  `update`/`upsert` here would silently let two concurrent acquires both
 *  believe they won. */
export async function acquireLoadLock(tx: LockTx, h: Holder, nowMs = Date.now()): Promise<{ ok: true; lock: LoadLockRow; fresh: boolean } | { ok: false; lock: LoadLockRow }> {
  const current = await tx.loadLock.findUnique({ where: { loadId: h.loadId } });
  const expiresAt = new Date(nowMs + LOAD_LOCK_TTL_MS);

  if (!current) {
    try {
      const row = await tx.loadLock.create({
        data: { loadId: h.loadId, orgId: h.orgId, dispatcherId: h.dispatcherId, dispatcherName: h.dispatcherName, since: new Date(nowMs), expiresAt },
      });
      return { ok: true, lock: toRow(row), fresh: true };
    } catch (e) {
      // Two first acquires raced on the unique loadId; the other one won.
      if ((e as { code?: string }).code === "P2002") {
        const winner = await tx.loadLock.findUnique({ where: { loadId: h.loadId } });
        if (winner) return { ok: false, lock: toRow(winner) };
      }
      // The FK refused: the load itself is gone (deleted between the caller's
      // ownership check and this insert). That is a 404 for the caller, not a
      // 500 — see LockTargetGone.
      if ((e as { code?: string }).code === "P2003") throw new LockTargetGone(h.loadId);
      throw e;
    }
  }

  if (!live(current, nowMs)) {
    // Expired: only the write that still finds it expired at write time
    // wins — two simultaneous re-takers race on this WHERE.
    const { count } = await tx.loadLock.updateMany({
      where: { loadId: h.loadId, expiresAt: { lt: new Date(nowMs) } },
      data: { orgId: h.orgId, dispatcherId: h.dispatcherId, dispatcherName: h.dispatcherName, since: new Date(nowMs), expiresAt },
    });
    const row = await tx.loadLock.findUnique({ where: { loadId: h.loadId } });
    if (!row) throw new Error(`loadLock ${h.loadId} vanished mid-acquire`);
    return count === 0 ? { ok: false, lock: toRow(row) } : { ok: true, lock: toRow(row), fresh: true };
  }

  if (current.dispatcherId === h.dispatcherId) {
    // Re-affirm: guard on dispatcherId too, so a lock that changed hands
    // between the read and this write is never silently re-stamped as ours.
    const { count } = await tx.loadLock.updateMany({
      where: { loadId: h.loadId, dispatcherId: h.dispatcherId },
      data: { expiresAt },
    });
    const row = await tx.loadLock.findUnique({ where: { loadId: h.loadId } });
    if (!row) throw new Error(`loadLock ${h.loadId} vanished mid-acquire`);
    return count === 0 ? { ok: false, lock: toRow(row) } : { ok: true, lock: toRow(row), fresh: false };
  }

  return { ok: false, lock: toRow(current) };
}

/** `false` ONLY when someone else holds it live; releasing a free or expired
 *  lock succeeds, so cleanup on blur, unmount and route-leave is idempotent.
 *
 *  The delete itself is self-guarding (same reasoning as acquireLoadLock):
 *  a plain `deleteMany({ where: { loadId } })` after the read-and-decide
 *  above would happily delete a live lock someone else acquired between the
 *  read and the delete. The WHERE below only ever matches a row that is
 *  ours or already expired, so a live lock held by another dispatcher can
 *  never be removed by this call, no matter what the earlier read saw.
 *
 *  R9: and the ANSWER is decided by the delete, not by the read either. When
 *  the guarded delete matches nothing, the row that is there now is not the
 *  row the read saw — a third dispatcher took the expired lock in the gap —
 *  so we re-read and say so (mirrors acquireLoadLock's own
 *  re-read-after-a-guarded-write pattern). Answering `true` there reported a
 *  release that never happened and made DELETE answer 204 where 409 belonged. */
export async function releaseLoadLock(tx: LockTx, loadId: string, dispatcherId: string, nowMs = Date.now()): Promise<boolean> {
  const current = await tx.loadLock.findUnique({ where: { loadId } });
  if (!current) return true;
  if (live(current, nowMs) && current.dispatcherId !== dispatcherId) return false;
  const { count } = await tx.loadLock.deleteMany({ where: { loadId, OR: [{ dispatcherId }, { expiresAt: { lt: new Date(nowMs) } }] } });
  if (count > 0) return true;
  // Nothing matched. Either the row went away by itself (fine — releasing
  // nothing succeeds, which is what makes blur/unmount/route-leave safe), or
  // someone else's live lock now sits where the expired one did.
  const after = await tx.loadLock.findUnique({ where: { loadId } });
  return !(after && live(after, nowMs) && after.dispatcherId !== dispatcherId);
}

/** The writer's gate (spec §7.3): a load someone else holds refuses every
 *  writer — a dispatcher, and a system source (`dispatcherId: null`) too,
 *  because an import landing under an open editor is exactly the lost write
 *  the lock exists to prevent. */
export async function assertWritable(tx: LockTx, loadId: string, dispatcherId: string | null, nowMs = Date.now()): Promise<void> {
  const held = await heldBy(tx, loadId, nowMs);
  if (held && held.dispatcherId !== dispatcherId) throw new LoadLocked(held);
}

/** Socket close: everything this dispatcher held goes, and the caller emits
 *  `load_unlock` per row. Not transactional — it runs outside any request. */
export async function releaseAllLoadLocksFor(dispatcherId: string): Promise<Array<{ loadId: string; orgId: string }>> {
  const rows = await prisma.loadLock.findMany({ where: { dispatcherId }, select: { loadId: true, orgId: true } });
  if (rows.length > 0) await prisma.loadLock.deleteMany({ where: { dispatcherId } });
  return rows;
}

export async function sweepLoadLocks(nowMs = Date.now()): Promise<number> {
  return (await prisma.loadLock.deleteMany({ where: { expiresAt: { lt: new Date(nowMs) } } })).count;
}

export async function snapshotLoadLocks(orgId: string, nowMs = Date.now()): Promise<LoadLockRow[]> {
  const rows = await prisma.loadLock.findMany({ where: { orgId, expiresAt: { gte: new Date(nowMs) } } });
  return rows.map(toRow);
}
