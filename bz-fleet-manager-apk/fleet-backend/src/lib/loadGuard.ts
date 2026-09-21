import type { Request, Response } from "express";
import { prisma } from "../db.js";
import { heldBy } from "./loadLocks.js";

/** The Cockpit's half of spec §7.3: assign, replan, unassign and the load
 *  editor refuse a load another dispatcher is editing on Their Board, the
 *  same way guardLane refuses a lane another dispatcher holds. Answers the
 *  409 itself and returns false, so a route reads `if (!(await guardLoad(…))) return;`. */
export async function guardLoad(req: Request, res: Response, loadId: string): Promise<boolean> {
  const held = await heldBy(prisma, loadId);
  if (held && held.dispatcherId !== req.auth?.dispatcherId) {
    res.status(409).json({ error: "LOAD_LOCKED", lock: held, message: `${held.by} is editing this load` });
    return false;
  }
  return true;
}
