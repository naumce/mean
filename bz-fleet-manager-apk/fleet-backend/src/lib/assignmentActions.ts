import { Prisma } from "@prisma/client";
import type { Assignment } from "@prisma/client";
import { prisma } from "../db.js";
import { emitToDriver } from "../realtime.js";
import type { HosRow } from "../domain/dispatch/mapper.js";
import { applyStatusChange, type Actor } from "./loadWriter.js";
import { emitLoadChanged } from "./loadEvents.js";
import { SYSTEM_ACTOR } from "./actor.js";

// Shared assignment-lifecycle logic (Cockpit S2a). Extracted out of
// routes/dispatcherAssignments.ts so the dispatcher's tender accept/decline
// (Task 7) and the driver's own accept/decline of the SAME tender (Task 9)
// call the exact same code — a route file must never import from another
// route file, and a second copy of the HOS restore arithmetic is the single
// thing this plan has worked hardest to avoid. Callers own auth, tenancy /
// ownership resolution, lane locking (dispatcher-only), and the `tendered`
// status precondition (still 409'd by each caller so the two routes can word
// their own error) — everything here assumes that's already been checked and
// performs only the state transition + the realtime fan-out.

/** The clocks `current` would show if `assignment` had never been committed.
 *
 *  Pure, and the ONLY copy of this arithmetic. `restoreHos` below writes it to
 *  the database; PATCH /assignments/:id/plan needs the same numbers as an
 *  *input* to the engine — before it writes anything — so that a replan
 *  evaluates against hours the move itself is about to hand back. Two copies of
 *  this would be two chances to disagree about how much of a leg a driver owes. */
export function restoredClocks(current: HosRow, assignment: Assignment): HosRow {
  const hasSnapshot =
    assignment.hosDriveBefore != null &&
    assignment.hosWindowBefore != null &&
    assignment.hosCycleBefore != null &&
    assignment.hosBreakBefore != null;
  if (hasSnapshot) {
    // Exact pre-commit values — a perfect no-op restore, immune to the
    // commit-time clamps and the break-counter reset.
    return {
      driveRemainingMin: assignment.hosDriveBefore!,
      windowRemainingMin: assignment.hosWindowBefore!,
      cycleRemainingMin: assignment.hosCycleBefore!,
      minutesSinceBreak: assignment.hosBreakBefore!,
    };
  }
  // Legacy rows without snapshots: arithmetic restore (best effort). A leg
  // that took a break consumed the counter irrecoverably, so it is left as-is
  // rather than guessed at.
  return {
    driveRemainingMin: Math.min(660, current.driveRemainingMin + assignment.driveMin),
    windowRemainingMin: Math.min(840, current.windowRemainingMin + assignment.onDutyMin),
    cycleRemainingMin: Math.min(4200, current.cycleRemainingMin + assignment.onDutyMin),
    minutesSinceBreak: assignment.tookBreak
      ? current.minutesSinceBreak
      : Math.max(0, current.minutesSinceBreak - assignment.driveMin),
  };
}

export async function restoreHos(tx: Prisma.TransactionClient, assignment: Assignment): Promise<void> {
  const hos = await tx.hosState.findUnique({ where: { driverId: assignment.driverId } });
  if (!hos) return;
  await tx.hosState.update({
    where: { driverId: assignment.driverId },
    data: { ...restoredClocks(hos, assignment), updatedAt: new Date() },
  });
}

// --- "What vanished?" messages for lib/writeConflict.ts ----------------------
// Each transaction below can fail with P2025 when a row it was going to touch
// has been deleted underneath it, and the caller must answer the request with
// something the person on the other end can act on. The strings live HERE,
// next to the transactions whose failure they describe, rather than at the
// four route call sites (two dispatcher, two driver) that would otherwise each
// carry their own wording of the same event.

/** unassign()'s transaction: the Assignment (and its Load) may already be gone
 *  — most often because the driver declined the tender first. Used by DELETE
 *  /assignments/:id. */
export const UNASSIGN_GONE =
  "This assignment was already removed — the driver may have declined it. Refresh the board.";

/** acceptTender()'s transaction: the offer was withdrawn (unassigned, replanned
 *  away, or its load canceled) between reading it and answering it. Reaches a
 *  DRIVER's phone as well as a dispatcher's screen, so it is worded for both. */
export const TENDER_ACCEPT_GONE =
  "This tender is no longer available — it was withdrawn or already answered.";

/** declineTender()'s transaction: same race, other button. */
export const TENDER_DECLINE_GONE =
  "This tender is no longer available — it was withdrawn or already answered.";

// Cancels an assignment outright: restore HOS (via restoreHos above), drop
// the rows scoped to this specific commit (DeadheadLeg, Rate), delete the
// assignment, and free the load back to "open". Conflicts stay — they're
// audit history for the alerts feed, untouched by either DELETE
// /assignments/:id or tender decline.
export async function unassign(
  tx: Prisma.TransactionClient, assignment: Assignment, actor: Actor, opts?: { bypassLock?: boolean },
): Promise<{ loadId: string; version: number }> {
  await restoreHos(tx, assignment);
  await tx.deadheadLeg.deleteMany({ where: { assignmentId: assignment.id } });
  await tx.rate.deleteMany({ where: { loadId: assignment.loadId } });
  // F6/plan A3: the load's status now moves through the one writer, same as
  // every other Load write — one LoadChange row, one version tick.
  const { version } = await applyStatusChange(tx, {
    loadId: assignment.loadId, orgId: assignment.orgId, actor, source: "loadboard",
    status: "open", note: `assignment ${assignment.id} unassigned`,
    bypassLock: opts?.bypassLock === true,
  });
  await tx.assignment.delete({ where: { id: assignment.id } });
  // A4 Task 1: handed back so DELETE /assignments/:id can emit `load_changed`
  // without a second read — declineTender and the loadboard cancel path don't
  // need it and are free to ignore it.
  return { loadId: assignment.loadId, version };
}

// Accept: relabel the offer as a committed assignment. The HOS was already
// decremented when the tender was created (ACTIVE_STATUSES treats "tendered"
// as busy) — accepting must NEVER touch the driver's clocks again, or the
// hours would be double-charged.
export async function acceptTender(
  assignment: Assignment, actor: Actor, opts?: { bypassLock?: boolean },
): Promise<Assignment> {
  let loadVersion = 0;
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.assignment.update({
      where: { id: assignment.id },
      data: { status: "assigned", tenderedAt: null },
    });
    // F6/plan A3: same writer as every other Load write.
    loadVersion = (await applyStatusChange(tx, {
      loadId: assignment.loadId, orgId: assignment.orgId, actor, source: "loadboard",
      status: "assigned", note: `tender ${assignment.id} accepted`,
      bypassLock: opts?.bypassLock === true,
    })).version;
    return next;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  emitToDriver(assignment.driverId, "trip_assignment", { loadId: assignment.loadId, assignmentId: assignment.id });
  // A4 Task 9: board_update retired here — the load's status move to
  // "assigned" is announced by load_changed instead (the writer's own
  // return value, not a second read, same convention as every other site).
  emitLoadChanged(assignment.orgId, { loadId: assignment.loadId, version: loadVersion, fields: ["status"] });
  return updated;
}

// Decline: the offer is withdrawn entirely — same cancellation as an
// unassign (restore HOS, free the load, delete the row), plus an audit
// DispatchConflict for the alerts feed so dispatchers see why the load came
// back to the board.
export async function declineTender(assignment: Assignment, reason?: string): Promise<void> {
  let unassigned: { loadId: string; version: number } = { loadId: assignment.loadId, version: 0 };
  await prisma.$transaction(async (tx) => {
    // No request here (reached from both the dispatcher's and the driver's
    // own decline route) — a system source, same as any other lifecycle path
    // with no dispatcher behind it. Fix round 1: bypassLock, so a decline
    // never hangs behind a dispatcher's Cockpit edit lock on this load.
    unassigned = await unassign(tx, assignment, SYSTEM_ACTOR("lifecycle"), { bypassLock: true });
    await tx.dispatchConflict.create({
      data: {
        orgId: assignment.orgId,
        loadId: assignment.loadId,
        driverId: assignment.driverId,
        kind: "tender_declined",
        severity: "warn",
        detail: reason ? `Tender declined: ${reason}` : "Tender declined",
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  emitToDriver(assignment.driverId, "trip_unassignment", { loadId: assignment.loadId });
  // A4 Task 9: board_update retired here — the load moved back to "open"
  // through unassign()'s one writer, same as DELETE /assignments/:id, and
  // load_changed is that writer's own return value (no second read).
  emitLoadChanged(assignment.orgId, { loadId: unassigned.loadId, version: unassigned.version, fields: ["status"] });
}
