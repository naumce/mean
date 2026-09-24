import { prisma } from "../db.js";
import { rankOrgDrivers, type OrgRanking } from "./rankDrivers.js";
import { toLoadInput, toTractorInput, toTrailerInput } from "../domain/dispatch/mapper.js";
import type { CandidateContext, CandidateContextInput } from "./candidateContext.js";

// Extracted from dispatcherSuggest.ts (AI Dispatch Foundation, Task 5): the
// ⚡Suggest panel's whole pipeline (load -> toLoadInput -> a representative
// available tractor/trailer from the org pool -> rankOrgDrivers -> rows incl.
// `unmappable` as infeasible rows), pulled out of the route so
// dispatchTools/dispatch.ts's findFeasibleDrivers/getDispatchCandidateDetails
// can call the identical pipeline instead of a second copy of it. The route
// itself (dispatcherSuggest.ts) is now a thin wrapper around this function.
// Equipment auto-pick and the "no tractor"/"no trailer" notes are unchanged
// from the pre-extraction route — see its own header comment for why.

export interface SuggestCandidateRow {
  driverId: string;
  driverName: string | null;
  feasible: boolean;
  score: number | null;
  deadheadMi: number;
  loadedMi: number;
  etaMs: number;
  marginCents: number;
  marginPct: number;
  blockedReason?: string;
  warnings: string[];
  hosKnown?: boolean;
  /** Availability/HOS/lane/metrics/preferences/qualifications — attached by
   *  rankOrgDrivers when this pipeline passes it a `contextInput` (Task 6).
   *  Absent on the `unmappable` rows below: a driver who never became a
   *  Candidate at all (no known position) has nothing to build context from
   *  either. */
  context?: CandidateContext;
}

export interface SuggestResult {
  loadId: string;
  requiredEquip: string;
  tractorId: string | null;
  trailerId: string | null;
  candidates: SuggestCandidateRow[];
  note?: string;
}

function unmappableRowsOf(unmappable: OrgRanking["unmappable"]): SuggestCandidateRow[] {
  return unmappable.map((u) => ({
    driverId: u.driverId,
    driverName: u.driverName,
    feasible: false,
    score: null,
    deadheadMi: 0,
    loadedMi: 0,
    etaMs: 0,
    marginCents: 0,
    marginPct: 0,
    blockedReason: u.reason,
    warnings: [],
  }));
}

/**
 * The load -> ranked-driver pipeline behind `GET /suggest`, as a plain
 * function: null when the load does not exist or belongs to another org
 * (the route maps that to 404; a tool caller gets the same null every other
 * dispatchTools function returns for a missing/cross-org entity). `nowMs`
 * feeds `rankOrgDrivers`'s `availableAt` exactly as the route's `Date.now()`
 * call did — parameterised only so a caller (test or tool) can fix it.
 */
export async function suggestForLoad(
  orgId: string,
  loadId: string,
  nowMs: number = Date.now(),
): Promise<SuggestResult | null> {
  const load = await prisma.load.findUnique({
    where: { id: loadId },
    include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } },
  });
  if (!load || load.orgId !== orgId) return null;

  const loadInput = toLoadInput(load);

  // Context enrichment (Task 6): the same stops, in the flatter shape
  // buildCandidateContext needs (address text for lane labels/city parsing,
  // alongside the lat/lng toLoadInput already turned into GeoPoints above) —
  // never fed back into the engine, only attached to rows after suggest()
  // has already run.
  const contextInput: CandidateContextInput = {
    requiredEquip: load.requiredEquip,
    stops: load.stops.map((s) => ({ type: s.type, address: s.address, lat: s.lat, lng: s.lng })),
    nowMs,
  };

  // Representative available equipment from the org pool.
  const [tractor, trailer] = await Promise.all([
    prisma.tractor.findFirst({ where: { orgId: load.orgId, status: "active" } }),
    prisma.trailer.findFirst({
      where: { orgId: load.orgId, type: load.requiredEquip, status: { in: ["active", "idle"] } },
    }),
  ]);
  if (!tractor) {
    return {
      loadId: load.id,
      requiredEquip: load.requiredEquip,
      tractorId: null,
      trailerId: null,
      candidates: [],
      note: "No available tractor in the pool",
    };
  }
  if (!trailer) {
    return {
      loadId: load.id,
      requiredEquip: load.requiredEquip,
      tractorId: null,
      trailerId: null,
      candidates: [],
      note: `No available ${load.requiredEquip} trailer in the pool`,
    };
  }

  const ranking = await rankOrgDrivers(
    load.orgId, loadInput, toTractorInput(tractor), toTrailerInput(trailer), nowMs, undefined, contextInput,
  );

  return {
    loadId: load.id,
    requiredEquip: load.requiredEquip,
    tractorId: tractor.id,
    trailerId: trailer.id,
    candidates: [...ranking.ranked, ...unmappableRowsOf(ranking.unmappable)],
  };
}
