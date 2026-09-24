import { suggestForLoad, type SuggestResult, type SuggestCandidateRow } from "../suggestForLoad.js";

// dispatchTools/dispatch.ts (AI Dispatch Foundation, Task 5): both functions
// here are thin wrappers over lib/suggestForLoad.ts's own pipeline (itself
// extracted from the /suggest route in this same task). Task 6 is what
// actually enriches rankOrgDrivers/suggestForLoad with richer candidate
// context — this file only exposes what exists today as a tool boundary;
// being thin wrappers, both functions pick up that richer context for free
// once suggestForLoad carries it, with no change needed here.

/** Every org driver ranked for this load (feasible candidates scored,
 *  infeasible ones with a reason) — suggestForLoad verbatim; null when the
 *  load does not exist or belongs to another org. */
export async function findFeasibleDrivers(orgId: string, loadId: string): Promise<SuggestResult | null> {
  return suggestForLoad(orgId, loadId);
}

export interface DispatchCandidateDetails {
  loadId: string;
  driverId: string;
  candidate: SuggestCandidateRow;
}

/** One specific driver's row out of findFeasibleDrivers' candidates; null
 *  when the load does not exist/belongs to another org, OR when that driver
 *  is not among its candidates (e.g. an id from a different org's fleet). */
export async function getDispatchCandidateDetails(
  orgId: string,
  loadId: string,
  driverId: string,
): Promise<DispatchCandidateDetails | null> {
  const result = await suggestForLoad(orgId, loadId);
  if (!result) return null;
  const candidate = result.candidates.find((c) => c.driverId === driverId);
  if (!candidate) return null;
  return { loadId, driverId, candidate };
}
