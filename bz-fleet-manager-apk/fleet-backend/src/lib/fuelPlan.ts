// Assembles the fuel section of a verdict (T4 Fuel and Stops, Task 7): how
// much diesel the plan burns, where to buy it, and how the gallons split
// across states for IFTA. Fuel raises NO conflicts of its own — there is no
// such thing as a plan too expensive to be legal (a dispatcher taking a
// costly lane has reasons this module does not model) — so this file only
// ever returns a `FuelPlanBody` to sit ALONGSIDE the existing conflicts
// array; it never pushes into it.
//
// mpg is resolved by the CALLER via rateConfigForDriver/resolveRateConfig
// (T1 Task 3) — the driver's CARRIER cost model, not the org's — and handed
// in already resolved, so this file makes exactly one query of its own: the
// latest fuel price per distinct state the plan touches, in one round trip
// (never one query per stop).

import { prisma } from "../db.js";
import {
  attributeGallons,
  fuelAdvice,
  fuelBurn,
  type AttributionLeg,
  type FuelAdvice,
  type FuelBurn,
  type IftaAttribution,
  type PricedStop,
} from "../domain/dispatch/index.js";
import type { DispatchPlan, GeoPoint } from "../domain/dispatch/types.js";
import { stateOf } from "./stateOf.js";

export interface FuelPlanBody {
  burn: FuelBurn;
  advice: FuelAdvice | null;
  ifta: IftaAttribution;
  /** false when mpg was unusable or no price was found for any stop */
  known: boolean;
}

/** The minimal shape this module needs from a stop: enough for stateOf and
 *  for a human label. Structural (like domain/dispatch/mapper.ts's *Row
 *  types) so it is testable without a real Prisma row, and so a raw
 *  LoadStop straight off `prisma.load.findUnique({ include: { stops } })`
 *  satisfies it with no mapping step. */
export interface FuelPlanStop {
  sequence: number;
  address: string;
  lat: number | null;
  lng: number | null;
}

/** Only the plan fields this module actually reads. Pick<>, not the full
 *  DispatchPlan, so a caller (or a test) can hand in exactly what it has
 *  without constructing breaks/onDutyMin/etc. it doesn't need. */
export type FuelPlanInput = Pick<DispatchPlan, "deadheadMi" | "loadedMi" | "legs">;

/** Latest FuelPrice (effectiveOn <= today) per state, for every state in
 *  `states`, in ONE query — never a query per stop in a loop. Rows are
 *  ordered so the FIRST row seen per state in the reduce below is its most
 *  recent effective-on-or-before-today price; identical "latest <= today"
 *  rule as dispatcherFuelPrices.ts's single-state GET resolver, just batched
 *  across every state this plan touches instead of one at a time. */
async function latestPricesByState(
  orgId: string,
  states: readonly string[],
): Promise<Map<string, number>> {
  if (states.length === 0) return new Map();
  const now = new Date();
  const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const rows = await prisma.fuelPrice.findMany({
    where: { orgId, state: { in: [...states] }, effectiveOn: { lte: todayUtcMidnight } },
    orderBy: [{ state: "asc" }, { effectiveOn: "desc" }],
    select: { state: true, centsPerGal: true },
  });

  const byState = new Map<string, number>();
  for (const row of rows) {
    if (!byState.has(row.state)) byState.set(row.state, row.centsPerGal);
  }
  return byState;
}

/**
 * Build the fuel section of a verdict.
 *
 * `driverLocation` must be the SAME point evaluate() used for the deadhead
 * origin (driverMap.input.location at the call site) — the deadhead leg's
 * `fromState` is read off it, never off a second position.
 *
 * `stops` must be the load's stops in the shape they come off Prisma
 * (address + lat/lng + sequence); this function sorts them by sequence
 * itself, matching the engine's own ordering (evaluate.ts, mapper.ts).
 *
 * `mpg` is the resolved carrier/org cost model's mpg (rateConfigForDriver) —
 * NOT re-resolved here, so this module never becomes a second place that
 * decides carrier-vs-org (Global Constraint: one definition per concept).
 */
export async function buildFuelPlan(
  orgId: string,
  driverLocation: GeoPoint,
  plan: FuelPlanInput,
  stops: readonly FuelPlanStop[],
  mpg: number,
): Promise<FuelPlanBody> {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const stopStates = ordered.map((s) => stateOf(s));

  const distinctStates = [...new Set(stopStates.filter((s): s is string => s !== null))];
  const prices = await latestPricesByState(orgId, distinctStates);

  const burn = fuelBurn({ deadheadMi: plan.deadheadMi, loadedMi: plan.loadedMi }, mpg);

  // One AttributionLeg per plan leg. States come off the SAME resolved stop
  // states (plus the driver's own position for the deadhead leg); miles are
  // taken verbatim from plan.legs — the engine already walked these, so this
  // file must never re-derive a distance (Global Constraint 2).
  const legByIndex = new Map(plan.legs.map((leg) => [leg.index, leg]));
  const attributionLegs: AttributionLeg[] = plan.legs.map((leg) => {
    if (leg.index === -1) {
      return { fromState: stateOf(driverLocation), toState: stopStates[0] ?? null, miles: leg.miles };
    }
    return {
      fromState: stopStates[leg.index] ?? null,
      toState: stopStates[leg.index + 1] ?? null,
      miles: leg.miles,
    };
  });
  const ifta = attributeGallons(burn, attributionLegs);

  // Priced stops: a stop is only a fuel-buy candidate (either the "buy here"
  // or the "vs" comparison) when it has BOTH a resolved state AND a price
  // for that state. Missing either drops it from the candidate set entirely
  // — never priced at 0 (Global Constraint 1: absent must never render as
  // measured).
  const pricedStops: PricedStop[] = [];
  ordered.forEach((stop, i) => {
    const state = stopStates[i];
    if (state === null) return;
    const centsPerGal = prices.get(state);
    if (centsPerGal === undefined) return;
    // Gallons still ahead of this stop: the leg DEPARTING it (index === i),
    // divided by mpg. The plan's LAST stop has no outgoing leg (the trip
    // ends there); fuelAdvice never reads gallonsFromHere off the last stop
    // (it is only ever the "vs" target there, never the buy point), so 0 is
    // inert in that case, not a claim.
    const outgoingLeg = legByIndex.get(i);
    const gallonsFromHere =
      burn.mpgUsed !== null && outgoingLeg ? outgoingLeg.milesRemaining / burn.mpgUsed : 0;
    pricedStops.push({ sequence: stop.sequence, label: stop.address, state, centsPerGal, gallonsFromHere });
  });

  const advice = fuelAdvice(burn, pricedStops);
  // false when mpg was unusable OR no price was found for any stop at all —
  // "some stops priced, some not" still counts as known (the advice/ifta
  // just work with what's known), matching FuelPlanBody's own doc comment.
  const known = burn.mpgUsed !== null && pricedStops.length > 0;

  return { burn, advice, ifta, known };
}
