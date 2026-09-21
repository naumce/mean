import { prisma } from "../db.js";
import type { Actor } from "./loadWriter.js";

/** Who is writing, for the trace (spec §5.2). A route reads the dispatcher
 *  off the token and looks the name up once; a system source names itself. */
export async function actorOf(req: { auth?: { dispatcherId?: string } }): Promise<Actor> {
  const id = req.auth?.dispatcherId ?? null;
  if (!id) return { dispatcherId: null, name: "dispatcher" };
  const d = await prisma.dispatcher.findUnique({ where: { id }, select: { name: true } });
  return { dispatcherId: id, name: d?.name ?? "dispatcher" };
}

export const SYSTEM_ACTOR = (name: string): Actor => ({ dispatcherId: null, name });
