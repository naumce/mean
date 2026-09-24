import type { Assignment, Prisma } from "@prisma/client";
import { applyStatusChange } from "./loadWriter.js";
import type { Actor, ChangeSource } from "./loadWriter.js";

// The assigned -> in_progress -> completed transaction, extracted from
// POST /assignments/:id/status (dispatcherAssignments.ts) so the AI Dispatch
// Foundation simulation (src/lib/simulation/engine.ts) can drive the exact
// same lifecycle a dispatcher's Start/Deliver buttons do — one transition,
// one place it is written, whether a human or the simulation's clock called
// it. The route still owns the lane/lock guards, the LIFECYCLE precondition
// check, the write-conflict -> HTTP mapping, and the realtime emits; this
// function is only the part that used to live inside its
// `prisma.$transaction(async (tx) => {...})` callback.

/** The fields a caller must already have loaded to transition an assignment
 *  — a structural subset of the route's own `prisma.assignment.findUnique`
 *  result, so the simulation's own (differently-shaped) query satisfies it
 *  without carrying fields neither caller needs. */
export interface AssignmentForTransition {
  id: string;
  driverId: string;
  loadId: string;
  trailerId: string | null;
  startedAt: Date | null;
  load: {
    orgId: string;
    stops: { type: string; lat: number | null; lng: number | null }[];
  };
}

export interface TransitionOptions {
  actor: Actor;
  /** "loadboard" for the dispatcher's own Start/Deliver buttons; "system"
   *  for the simulation's clock (see engine.ts's header comment). */
  source: ChangeSource;
  /** The moment this transition is recorded at — the route's real
   *  wall-clock `new Date()`, or the simulation's fictional `simNowMs`. */
  now: Date;
}

export interface TransitionResult {
  assignment: Assignment;
  loadVersion: number;
}

/**
 * Moves one assignment to `next` ("in_progress" or "completed"), mirrors the
 * Load's status through the one writer (applyStatusChange), and — on
 * completion — stamps the trailer's last-known position from the load's
 * delivery stop. Must run inside the caller's own `tx`; every check that
 * decides WHETHER this transition is legal (the LIFECYCLE table, lane/load
 * locks) already ran before the caller opened the transaction.
 */
export async function transitionAssignment(
  tx: Prisma.TransactionClient,
  assignment: AssignmentForTransition,
  next: "in_progress" | "completed",
  { actor, source, now }: TransitionOptions,
): Promise<TransitionResult> {
  const nextAssignment = await tx.assignment.update({
    where: { id: assignment.id },
    data: {
      status: next,
      ...(next === "in_progress" ? { startedAt: now } : {}),
      ...(next === "completed" ? { completedAt: now, ...(assignment.startedAt ? {} : { startedAt: now }) } : {}),
    },
  });
  // F6/plan A3: the load's status moves through the one writer, same as
  // every other Load write.
  const loadVersion = (
    await applyStatusChange(tx, {
      loadId: assignment.loadId,
      orgId: assignment.load.orgId,
      actor,
      source,
      status: next === "completed" ? "delivered" : "in_progress",
      note: `assignment ${assignment.id} → ${next}`,
    })
  ).version;

  // Trailer position (T2 Task 6): on completion, stamp the trailer's
  // last-known position from the load's delivery stop (the last
  // delivery-typed stop, else the last stop by sequence), plus lastSeenAt.
  // A stop that was never geocoded writes NOTHING — absent must never be
  // recorded as measured.
  if (next === "completed" && assignment.trailerId) {
    const stops = assignment.load.stops;
    const finalStop = [...stops].reverse().find((s) => s.type === "delivery") ?? stops[stops.length - 1];
    if (finalStop?.lat != null && finalStop?.lng != null) {
      await tx.trailer.update({
        where: { id: assignment.trailerId },
        data: { lastLat: finalStop.lat, lastLng: finalStop.lng, lastSeenAt: now },
      });
    }
  }

  return { assignment: nextAssignment, loadVersion };
}
