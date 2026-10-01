/** The display label for a load's LOAD# column: the first non-empty value
 *  among the load's own board number, its order reference, then its
 *  external id — many loads (seeded/imported) never got a board number, and
 *  showing a raw database id instead of any value the load actually carries
 *  would be a live-data bug, not an intentional fallback. Precedence is
 *  fixed; do not reorder it.
 *
 *  Shared by agentsOverview.ts (`loads[].boardLoadNo`, `dispatch.activity.
 *  running.loadNo`) and agentTimeline.ts (GET /loads/:id/agent's
 *  `boardLoadNo`) so every surface that names a load answers the same label
 *  for it — never a second source of truth for "what do we call this load". */
export function displayLoadNo(load: { boardLoadNo: string | null; orderRef: string | null; externalId: string | null }): string | null {
  const candidates = [load.boardLoadNo, load.orderRef, load.externalId];
  return candidates.find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? null;
}
