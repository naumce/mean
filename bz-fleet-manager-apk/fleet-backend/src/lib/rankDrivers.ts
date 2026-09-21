import { prisma } from "../db.js";
import { suggest, type Candidate, type SuggestRow } from "../domain/dispatch/suggest.js";
import { DEFAULT_RATE_CONFIG } from "../domain/dispatch/economics.js";
import { toDriverInput } from "../domain/dispatch/mapper.js";
import type { LoadInput, TractorInput, TrailerInput } from "../domain/dispatch/types.js";
import { laneFamiliarity, laneKeyOfLoad } from "./lanes.js";
import { rateConfigsForDrivers } from "./rateConfig.js";
import { ACTIVE_STATUSES } from "./activeStatuses.js";

// Shared driver-ranking core: the ⚡Suggest panel and the commit-time
// empty-miles-saved metric both need "rank every driver in the org for this
// load against this equipment". Extracted from the suggest route verbatim so
// both callers score identically.

export interface OrgRanking {
  ranked: (SuggestRow & { driverName: string | null; warnings: string[]; hosKnown: boolean })[];
  unmappable: { driverId: string; driverName: string | null; reason: string }[];
}

export async function rankOrgDrivers(
  orgId: string,
  loadInput: LoadInput,
  tractorInput: TractorInput,
  trailerInput: TrailerInput,
  availableAt: number,
  /** Assignment to treat as not-yet-existing — the leg a REPLAN is moving.
   *  Without it the driver it currently sits on is busy with the very leg
   *  being taken off them, so they drop out of their own alternatives and the
   *  empty-miles-saved median is computed against a fiction. A commit passes
   *  nothing: there is no row yet to exclude. */
  excludeAssignmentId?: string,
): Promise<OrgRanking> {
  const drivers = await prisma.driver.findMany({
    where: { orgId },
    include: { hos: true },
    orderBy: { name: "asc" },
  });
  const busyRows = await prisma.assignment.findMany({
    where: {
      driverId: { in: drivers.map((d) => d.id) },
      status: { in: [...ACTIVE_STATUSES] },
      ...(excludeAssignmentId ? { NOT: { id: excludeAssignmentId } } : {}),
    },
    select: { driverId: true, plannedStart: true, plannedEnd: true },
  });
  const busyByDriver = new Map<string, { start: number; end: number }[]>();
  for (const b of busyRows) {
    const list = busyByDriver.get(b.driverId) ?? [];
    list.push({ start: b.plannedStart.getTime(), end: b.plannedEnd.getTime() });
    busyByDriver.set(b.driverId, list);
  }

  const nameById = new Map(drivers.map((d) => [d.id, d.name]));
  const hosUnknown = new Set<string>();
  const candidates: Candidate[] = [];
  const unmappable: OrgRanking["unmappable"] = [];

  for (const d of drivers) {
    try {
      const mapped = toDriverInput(d, { availableAt });
      if (!mapped.hosKnown) hosUnknown.add(d.id);
      candidates.push({
        driverId: d.id,
        driver: mapped.input,
        tractor: tractorInput,
        trailer: trailerInput,
        context: { driverBusy: busyByDriver.get(d.id) },
      });
    } catch (err) {
      unmappable.push({
        driverId: d.id,
        driverName: nameById.get(d.id) ?? null,
        reason: err instanceof Error ? err.message : "unmappable driver",
      });
    }
  }

  // Lane familiarity from completed history feeds the scorer's lane weight —
  // a driver who has actually run this lane edges out an otherwise-equal one.
  const familiarity = await laneFamiliarity(orgId, laneKeyOfLoad(loadInput));

  // Per-candidate cost model: each driver is priced at THEIR OWN carrier's
  // rate, falling back field-by-field to the org and then planning defaults
  // — the same resolution the commit path uses (rateConfig.ts), just batched
  // for every candidate in one query instead of N. This is what makes a
  // ranking honest: a carrier that pays more must show a worse margin here,
  // not the org's one shared number for every driver (T1 Task 3b). Every
  // candidate here shares `orgId` (queried above), so a driver with no
  // carrier resolves to the SAME org config that used to be passed in as one
  // shared default — nothing is lost for that case.
  const rateByDriver = await rateConfigsForDrivers(drivers.map((d) => d.id));

  const ranked = suggest(loadInput, candidates, {
    lanePerfScore: (driverId) => familiarity.get(driverId) ?? 0,
    rate: (driverId) => rateByDriver.get(driverId) ?? DEFAULT_RATE_CONFIG,
  }).map((row) => ({
    ...row,
    driverName: nameById.get(row.driverId) ?? null,
    hosKnown: !hosUnknown.has(row.driverId),
    // Surface the unknown-HOS caveat as a warning on the row, not a silent pass.
    warnings: hosUnknown.has(row.driverId)
      ? [...row.warnings, "HOS not imported; feasibility assumes full hours"]
      : row.warnings,
  }));

  return { ranked, unmappable };
}

/** Median deadhead of the feasible alternatives minus the chosen deadhead,
 *  clamped at zero — the honest per-commit "empty miles saved" figure. Zero
 *  when the chosen driver was the only feasible option. Drivers with no
 *  imported HOS are NOT alternatives: their "feasibility" is an assumption,
 *  and the headline ROI number must never rest on fictional availability. */
export function emptyMilesSaved(
  ranking: OrgRanking,
  chosenDriverId: string,
  chosenDeadheadMi: number,
): number {
  const alternatives = ranking.ranked
    .filter((r) => r.feasible && r.hosKnown && r.driverId !== chosenDriverId)
    .map((r) => r.deadheadMi)
    .sort((a, b) => a - b);
  if (alternatives.length === 0) return 0;
  const mid = Math.floor(alternatives.length / 2);
  const median =
    alternatives.length % 2 === 1 ? alternatives[mid] : (alternatives[mid - 1] + alternatives[mid]) / 2;
  return Math.max(0, Math.round((median - chosenDeadheadMi) * 10) / 10);
}
