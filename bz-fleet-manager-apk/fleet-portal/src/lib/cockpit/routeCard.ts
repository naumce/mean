// What a dispatcher gets for clicking the ROUTE rather than the truck.
//
// The truck marker answers "how is this driver right now" — ETA, hours, last
// ping (see tripCard.ts). The line answers a different question: "what is this
// run, end to end." Miles, how far in, where the mandatory breaks land, where
// to buy fuel, what it pays. Those facts already exist — the break engine, the
// fuel engine and the router all produce them — but until now they were only
// reachable through a modal a dispatcher had to know to open. The route is the
// biggest click target on the map; this is what it should have been saying.
//
// Global Constraint 1 governs every field here: absent must never render as
// measured. A run with no fetched break plan, no mileage, or no rate reports
// null and the card says so in words. Zero is a measurement.

import { haversineMi } from '../geo'
import { splitAtProgress, type LngLat } from './mapGeometry'
import type { BreakPlanEntry, FuelPlanBody, StopDetention } from '../api'
import type { BoardLoad } from '../../stores/loadboard'

/** Miles along a polyline, summed leg by leg.
 *
 *  Summed rather than measured end-to-end on purpose: the reason to draw
 *  provider geometry at all is that a road is longer than the straight line
 *  between its ends. A chord would under-state every route, and drag cost per
 *  mile down with it. Null — never 0 — for a path too short to have a length. */
export function pathMiles(path: LngLat[]): number | null {
  if (!path || path.length < 2) return null
  let mi = 0
  for (let i = 1; i < path.length; i += 1) {
    const [aLng, aLat] = path[i - 1]
    const [bLng, bLat] = path[i]
    mi += haversineMi(aLat, aLng, bLat, bLng)
  }
  return mi
}

/** One mandatory HOS break, with the best place found to take it. */
export interface RouteBreakLine {
  atMs: number
  /** 'routed' means the point sits on real geometry; 'estimated' means it was
   *  interpolated. Carried through so the card can label it rather than imply
   *  a precision the plan never claimed. */
  precision: 'routed' | 'estimated'
  /** Whether the rest-stop registry covers this area at all. `false` with a
   *  null `best` means "we have no data here" — NOT "there is nowhere to
   *  stop", which is a different and much more dangerous claim. */
  hasCoverage: boolean
  best: { name: string; kind: string; detourMi: number; spaces: number | null } | null
}

export interface RouteCardInput {
  load: BoardLoad
  /** The same coordinates the map actually drew, so the card's mileage and the
   *  line on screen can never disagree. */
  path: LngLat[]
  /** True when `path` is provider road geometry; false when it is a drawn arc.
   *  The card states this outright — "truck-legal road" is the product's
   *  strongest claim and must never be asserted over a guess. */
  onRoad: boolean
  /** Elapsed share, 0..1, the same `progressShare` the map splits the line on. */
  progress: number
  /** null = never fetched. `{ known: false }` = the engine ran and could not
   *  plan. Two different facts; see the spec. */
  breakPlan: { entries: BreakPlanEntry[]; known: boolean } | null
  fuelPlan: FuelPlanBody | null
  detention: StopDetention[]
}

export interface RouteCard {
  loadId: string
  loadRef: string
  origin: string
  destination: string
  status: string
  onRoad: boolean
  totalMi: number | null
  drivenMi: number | null
  remainingMi: number | null
  progressPct: number | null
  equipment: string
  weightLbs: number | null
  hazmat: string | null
  revenueCents: number
  /** Null whenever mileage is unknown: revenue divided by no miles is not a
   *  rate, it is Infinity wearing one. */
  ratePerMiCents: number | null
  breaks: { known: boolean; lines: RouteBreakLine[] } | null
  fuel: FuelPlanBody | null
  detention: StopDetention[]
}

/** The rest option a driver would actually take: least detour off the route.
 *  The server returns them ranked, but ranking is its concern and could change;
 *  the card picks by the property it displays so the two can never disagree. */
function bestOption(e: BreakPlanEntry): RouteBreakLine['best'] {
  if (!e.options.length) return null
  const best = e.options.reduce((a, b) => (b.detourMi < a.detourMi ? b : a))
  return { name: best.name, kind: best.kind, detourMi: best.detourMi, spaces: best.spaces }
}

export function buildRouteCard(input: RouteCardInput): RouteCard {
  const { load, path, onRoad, progress, breakPlan, fuelPlan, detention } = input
  const totalMi = pathMiles(path)

  // Split on the same share the map splits the drawn line on, then measure each
  // half — rather than multiplying the total by `progress`. The halves are what
  // the dispatcher is looking at, and measuring them keeps the number under the
  // cursor and the number in the card the same number.
  const t = Math.min(1, Math.max(0, progress))
  let drivenMi: number | null = null
  let remainingMi: number | null = null
  if (totalMi !== null) {
    const { done, remaining } = splitAtProgress(path, t)
    drivenMi = pathMiles(done) ?? 0
    remainingMi = pathMiles(remaining) ?? 0
    // splitAtProgress interpolates the cut point, so the halves sum to the
    // whole to within float error. Pin the remainder to the measured total so
    // a card can never show two halves that do not add up.
    remainingMi = Math.max(0, totalMi - drivenMi)
  }

  return {
    loadId: load.id,
    loadRef: load.reference,
    origin: load.origin,
    destination: load.destination,
    status: load.status,
    onRoad,
    totalMi,
    drivenMi,
    remainingMi,
    progressPct: totalMi === null ? null : Math.round(t * 100),
    equipment: load.requiredEquip,
    weightLbs: load.weightLbs ?? null,
    hazmat: load.hazmatClass ?? null,
    revenueCents: load.revenueCents,
    ratePerMiCents: totalMi && totalMi > 0 ? load.revenueCents / totalMi : null,
    breaks: breakPlan
      ? {
          known: breakPlan.known,
          lines: breakPlan.entries.map((e) => ({
            atMs: e.atMs,
            precision: e.precision,
            hasCoverage: e.hasCoverage,
            best: bestOption(e),
          })),
        }
      : null,
    fuel: fuelPlan,
    detention,
  }
}
