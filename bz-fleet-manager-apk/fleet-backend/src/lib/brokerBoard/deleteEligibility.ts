import type { Prisma, PrismaClient } from "@prisma/client";
import { boardLoadNo } from "../brokerImport.js";

export const DELETABLE_STATUSES = ["open", "archived", "canceled"] as const;

export const REASON_DELIVERED = "Delivered — kept as history";
export const REASON_ASSIGNED = "Assigned to a driver or in progress";
export const REASON_NIGHT_SHIFT = "Night Shift tracked it — kept as history";

// Final review finding 11: `externalId` may carry the internal `board:`
// prefix when a TMS fleet load already owns the sheet's LOAD# — a refusal has
// to name the number the dispatcher typed, never our key. `boardLoadNo`
// returns "" for a null externalId, so `||` (not `??`) falls through.
export const LOAD_LABEL = (l: { externalId: string | null; bolNumber: string | null; orderRef: string | null; id: string }): string =>
  boardLoadNo(l.externalId) || l.bolNumber || l.orderRef || l.id.slice(0, 8);

export interface DeleteVerdict {
  readonly deletable: ReadonlyArray<{ id: string; label: string }>;
  readonly blocked: ReadonlyArray<{ id: string; label: string; reason: string }>;
}

/** Why a load cannot be deleted, or null when it can. Pure. */
export function deleteBlockReason(load: { status: string; assignment: unknown | null }, hasAgentHistory: boolean): string | null {
  if (load.status === "delivered") return REASON_DELIVERED;
  if (load.assignment !== null || !(DELETABLE_STATUSES as readonly string[]).includes(load.status)) return REASON_ASSIGNED;
  if (hasAgentHistory) return REASON_NIGHT_SHIFT;
  return null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Split ids into deletable / blocked, or null when any id is not the org's. */
export async function classifyForDelete(db: Db, orgId: string, ids: string[]): Promise<DeleteVerdict | null> {
  const unique = [...new Set(ids)];
  const loads = await db.load.findMany({ where: { id: { in: unique }, orgId }, include: { assignment: { select: { id: true } } } });
  if (loads.length !== unique.length) return null;
  const trips = await db.agentTrip.findMany({ where: { loadId: { in: unique } }, select: { loadId: true }, distinct: ["loadId"] });
  const withHistory = new Set(trips.map((t) => t.loadId));
  const deletable: { id: string; label: string }[] = [];
  const blocked: { id: string; label: string; reason: string }[] = [];
  for (const l of loads) {
    const reason = deleteBlockReason(l, withHistory.has(l.id));
    if (reason) blocked.push({ id: l.id, label: LOAD_LABEL(l), reason });
    else deletable.push({ id: l.id, label: LOAD_LABEL(l) });
  }
  return { deletable, blocked };
}
