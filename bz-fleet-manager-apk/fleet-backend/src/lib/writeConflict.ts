import type { Response } from "express";
import { Prisma } from "@prisma/client";

// The one mapping from "a transactional write failed" to the HTTP answer the
// client can act on. Lives in lib/ because THIRTEEN call sites across FIVE
// route files need it (dispatcherAssignments.ts x6, dispatcherLoads.ts x2,
// driver.ts x3, dispatcherFleet.ts, dispatcherAuth.ts — several of them
// reaching lib/assignmentActions.ts's shared accept/decline/unassign) — well
// past the second-file trigger this codebase uses to decide that shared logic
// stops being module-private. Every prisma.$transaction in src/ is now mapped
// except lib/loadIngest.ts's, which holds no `res` and records per-row
// failures instead; see the note there.
//
// Why it is shared rather than written per handler: an UNMAPPED rejection is
// not a 500. Express 4 does not await route handlers, so the promise rejects
// into the void and NO HTTP RESPONSE IS EVER SENT — the dispatcher's button
// spins until their client gives up, and on the cancel path the load has
// meanwhile been freed back to "open" and is bookable by anyone. Four of the
// six transactions shipped with no mapping at all, and the two that had one
// had already drifted apart (P2025 was added to the replan and not the
// commit). Two hand-synchronised copies of a rule is the defect class this
// slice spent its whole final wave removing; six would have been worse.

/** In-transaction re-check failure: surfaces as a 409, never a 500.
 *
 *  Thrown inside a transaction body when a pre-check that ran on an older
 *  snapshot no longer holds (the load got assigned, the driver got
 *  double-booked). Carries its own already-dispatcher-readable message. */
export class CommitConflict extends Error {}

/** The answer to "a concurrent write beat you" — P2034/P2002 and the raw
 *  Postgres 40P01/40001 below all mean the same thing to the client, and must
 *  say the same thing. */
const CONCURRENT_WRITE = "A concurrent commit touched this driver or load — retry";

/** Postgres SQLSTATEs Prisma does NOT map to a code of its own.
 *
 *  40P01 = deadlock detected, 40001 = serialization failure. Prisma raises
 *  these as `PrismaClientUnknownRequestError` wrapping a ConnectorError:
 *  `err.code` is undefined and the SQLSTATE appears only inside the message
 *  text, so no `instanceof PrismaClientKnownRequestError` branch can ever see
 *  one. That is exactly how a real deadlock on POST /assignments used to fall
 *  through to `throw err` and leave the request with no response at all —
 *  see tests/write-conflict-deadlock.test.ts, which induces a genuine
 *  Postgres deadlock rather than fabricating an error of the right shape.
 *
 *  Deadlock is reachable here by design, not by accident: the commit
 *  transaction writes Assignment -> Rate -> Load -> ... -> HosState and
 *  lib/assignmentActions.ts's unassign() writes the same rows in the opposite
 *  order, so two dispatchers on the same driver and load take the same locks
 *  inverted. Mapping it makes the symptom survivable; the lock ordering is
 *  the cause and is tracked separately.
 *
 *  Matched with word boundaries rather than a bare substring so a digit run
 *  inside an id cannot be mistaken for a SQLSTATE. */
const CONNECTOR_RETRY_SQLSTATE = /(?:^|[^0-9A-Za-z])(?:40P01|40001)(?:[^0-9A-Za-z]|$)/;

/** Maps a transactional write failure onto the 409 the client can act on.
 *  Returns true when it has answered the request; false when the error is
 *  none of ours and must keep propagating to the error handler.
 *
 *  `gone` is a REQUIRED parameter rather than a shared string, because it is
 *  the one thing that legitimately differs between call sites: "what can
 *  actually vanish here?" has a different answer on a commit (no Assignment
 *  exists yet — the Load or the driver's HosState went), a replan or an
 *  unassign (the Assignment, deleted by the driver's own tender decline), a
 *  cancel (either), and a tender accept/decline (the offer itself). Making it
 *  required forces the next handler that opens a transaction to answer that
 *  question rather than inherit a message which does not describe it. */
export function respondToWriteConflict(res: Response, err: unknown, gone: string): boolean {
  if (err instanceof CommitConflict) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034 = serialization failure, P2002 = unique(loadId) race — both mean a
    // concurrent write won; the client should re-preview and retry.
    if (err.code === "P2034" || err.code === "P2002") {
      res.status(409).json({ error: CONCURRENT_WRITE });
      return true;
    }
    // P2025 = a row the transaction went to update or delete is gone.
    if (err.code === "P2025") {
      res.status(409).json({ error: gone });
      return true;
    }
  }
  // Same class of event as P2034, different wrapper type — see
  // CONNECTOR_RETRY_SQLSTATE above. The transaction rolled back whole, so the
  // client's correct move is identical: re-preview and retry.
  if (err instanceof Prisma.PrismaClientUnknownRequestError && CONNECTOR_RETRY_SQLSTATE.test(err.message)) {
    res.status(409).json({ error: CONCURRENT_WRITE });
    return true;
  }
  return false;
}
