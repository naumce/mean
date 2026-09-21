import type { Request, Response } from "express";
import { get, type Lock } from "./locks.js";

// The assignment-mutation guard (Cockpit S2a, Task 4). A lane is the driver's
// row on the board: today every assignment mutation names a driver directly,
// so the lane id IS the driver id.

/** A lane is the driver's row on the board, so the lane id is the driver id.
 *  Tractor/trailer groupings lock the driver currently paired to that unit
 *  (S3 adds that resolution); today every mutation names a driver directly. */
export function laneIdForDriver(driverId: string): string {
  return driverId;
}

/** Carries the lock that refused the mutation so the route layer can surface
 *  who holds it (`409 { error: "ENTITY_ALREADY_LOCKED", lock }`). */
export class LockedError extends Error {
  constructor(readonly lock: Lock) {
    super("ENTITY_ALREADY_LOCKED");
  }
}

/** Throws when someone else holds the lane. The holder is never blocked from
 *  their own lane — that is the whole point of taking the lock.
 *
 *  lib/locks.ts's table is keyed by laneId alone (no org bucket — see that
 *  file's header for why the earlier bucketed design was a correctness bug),
 *  so this needs no org/scope argument at all: a lane has exactly one lock,
 *  table-wide, and this checks it directly. */
export function assertNotLockedByOther(laneId: string, dispatcherId: string): void {
  const held = get(laneId);
  if (held && held.dispatcherId !== dispatcherId) throw new LockedError(held);
}

/** Refuses the mutation with 409 `{ error: "ENTITY_ALREADY_LOCKED", lock }`
 *  when another dispatcher holds the driver's lane; returns `true` when the
 *  caller may proceed. Must run before any write and before a transaction
 *  opens — a guard that runs after either is not a guard. The holder of the
 *  lane is never blocked from their own lane.
 *
 *  Callers must establish the DRIVER's tenancy first: the lock table is
 *  global by laneId, so guarding a lane named by a raw request body turns
 *  the guard into a cross-tenant oracle (a 409 carrying the holder's name vs
 *  a 404 tells an outsider whether another org's lane is held). See the note
 *  on POST /assignments.
 *
 *  Lives here, not in a route file, because two routers need it and the
 *  callees it wraps already live here: dispatcherAssignments.ts and
 *  dispatcherDrivers.ts previously carried byte-identical private copies. */
export function guardLane(req: Request, res: Response, driverId: string): boolean {
  try {
    assertNotLockedByOther(laneIdForDriver(driverId), req.auth!.dispatcherId!);
    return true;
  } catch (err) {
    if (err instanceof LockedError) {
      res.status(409).json({ error: "ENTITY_ALREADY_LOCKED", lock: err.lock });
      return false;
    }
    throw err;
  }
}
