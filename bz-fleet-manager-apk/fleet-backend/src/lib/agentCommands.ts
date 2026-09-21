import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export interface QueueCommandInput {
  loadId: string;
  kind: string;
  payload?: unknown;
  actorName: string;
}

/** Writes an AgentCommand row (spec §17.3) — extracted from
 *  dispatcherNightShift.ts's POST /loads/:id/agent/commands (Task 10) so the
 *  dispatcher's own route and the token-authenticated deep link
 *  (routes/nightShiftLink.ts) share one write path. `actorName` names who
 *  queued it: the dispatcher's own name (actorOf(req)) for the dispatcher
 *  route, or the literal `"link"` for a deep-link supervisor with no
 *  dispatcher session to name. */
export async function queueCommand(input: QueueCommandInput) {
  return prisma.agentCommand.create({
    data: {
      loadId: input.loadId,
      kind: input.kind,
      actorName: input.actorName,
      // Omitted key, not an explicit null: a command with no payload at all
      // (e.g. `stop`) must persist as the column's own NULL, not a written
      // JSON null — same "absent vs. measured" distinction the rest of this
      // codebase holds everywhere else (Global Constraint 1).
      ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
    },
  });
}
