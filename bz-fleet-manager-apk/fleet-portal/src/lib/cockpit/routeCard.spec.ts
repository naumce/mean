import { describe, expect, it } from 'vitest'
import { buildRouteCard, pathMiles } from './routeCard'
import type { BoardLoad } from '../../stores/loadboard'
import type { BreakPlanEntry, FuelPlanBody } from '../api'

// Clicking a route asks a different question than clicking the truck. The truck
// answers "how is this driver right now"; the line answers "what is this run,
// end to end". Every test here guards a case where the card would state
// something it does not know — the one failure that turns a plan a dispatcher
// relays to a driver into a wrong instruction.

const load = (over: Partial<BoardLoad> = {}): BoardLoad =>
  ({
    id: 'l1',
    reference: 'W-0042',
    status: 'in_progress',
    requiredEquip: 'dry_van',
    hazmatClass: null,
    revenueCents: 245_000,
    stopCount: 2,
    origin: 'Omaha, NE',
    destination: 'Springfield, MO',
    weightLbs: 42_000,
    assignment: null,
    ...over,
  }) as BoardLoad

// One degree of latitude is 69.09321 mi (the figure stopEtas.spec.ts pins).
const NORTH_SOUTH: [number, number][] = [
  [-95, 41],
  [-95, 42],
]

describe('pathMiles', () => {
  it('sums real distance along the polyline', () => {
    expect(pathMiles(NORTH_SOUTH)).toBeCloseTo(69.09, 1)
  })

  it('follows the BENDS rather than the chord', () => {
    // The whole point of drawing provider geometry is that a road is longer
    // than the straight line. A card that measured the chord would under-state
    // every route and quietly under-state cost per mile with it.
    const dogleg: [number, number][] = [
      [-95, 41],
      [-94, 41],
      [-94, 42],
    ]
    const chord = pathMiles([[-95, 41], [-94, 42]])!
    expect(pathMiles(dogleg)!).toBeGreaterThan(chord)
  })

  it('refuses a degenerate path rather than reporting zero miles', () => {
    // Zero is a measurement. "We do not know" is not.
    expect(pathMiles([])).toBeNull()
    expect(pathMiles([[-95, 41]])).toBeNull()
  })
})

describe('buildRouteCard', () => {
  const card = (over: Parameters<typeof buildRouteCard>[0] extends never ? never : Partial<Parameters<typeof buildRouteCard>[0]> = {}) =>
    buildRouteCard({ load: load(), path: NORTH_SOUTH, onRoad: true, progress: 0, breakPlan: null, fuelPlan: null, detention: [], ...over })

  it('reports a real road route as ON ROAD, and an arc as an estimate', () => {
    // This is the product's strongest claim — that the line is a truck-legal
    // road and not a drawn guess. Conflating the two would let the card assert
    // it about a route nobody routed.
    expect(card({ onRoad: true }).onRoad).toBe(true)
    expect(card({ onRoad: false }).onRoad).toBe(false)
  })

  it('splits miles into driven and remaining at the progress share', () => {
    const c = card({ progress: 0.5 })
    expect(c.totalMi).toBeCloseTo(69.09, 1)
    expect(c.drivenMi).toBeCloseTo(34.55, 1)
    expect(c.remainingMi).toBeCloseTo(34.55, 1)
    expect(c.progressPct).toBe(50)
  })

  it('never lets driven and remaining drift from the total', () => {
    const c = card({ progress: 0.37 })
    expect(c.drivenMi! + c.remainingMi!).toBeCloseTo(c.totalMi!, 4)
  })

  it('computes rate per mile, and refuses it when miles are unknown', () => {
    expect(card().ratePerMiCents).toBeCloseTo(245_000 / 69.09, 0)
    // No drawable path means no mileage — and $2,450 / 0 mi is not a rate,
    // it is Infinity dressed as one.
    const c = card({ path: [] })
    expect(c.totalMi).toBeNull()
    expect(c.ratePerMiCents).toBeNull()
  })

  it('keeps "no plan fetched" distinct from "the engine could not plan"', () => {
    // Two different facts. Collapsing them tells a dispatcher there are no
    // breaks on a run whose break plan simply has not loaded yet.
    expect(card({ breakPlan: null }).breaks).toBeNull()
    const empty: { entries: BreakPlanEntry[]; known: boolean } = { entries: [], known: false }
    expect(card({ breakPlan: empty }).breaks).toEqual({ known: false, lines: [] })
  })

  it('carries each break with its best rest option, and admits when there is none', () => {
    const entries: BreakPlanEntry[] = [
      {
        atMs: 1,
        at: { lat: 41.5, lng: -95 },
        precision: 'routed',
        hasCoverage: true,
        options: [
          { id: 'r2', name: 'Farther', kind: 'rest_area', lat: 41, lng: -95, spaces: null, detourMi: 9, offRouteMi: 4 },
          { id: 'r1', name: 'Iowa 80', kind: 'truck_stop', lat: 41, lng: -95, spaces: 900, detourMi: 3, offRouteMi: 1 },
        ],
      },
      { atMs: 2, at: null, precision: 'estimated', hasCoverage: false, options: [] },
    ]
    const c = card({ breakPlan: { entries, known: true } })!
    expect(c.breaks!.lines[0].best?.name).toBe('Iowa 80') // the LEAST detour, not the first listed
    expect(c.breaks!.lines[0].best?.detourMi).toBe(3)
    // No coverage is not "no rest stop exists" — the registry simply has
    // nothing there, and the card must say so rather than show a blank.
    expect(c.breaks!.lines[1].best).toBeNull()
    expect(c.breaks!.lines[1].hasCoverage).toBe(false)
  })

  it('passes an unpriced or unweighed load through as unknown, never zero', () => {
    const c = card({ load: load({ weightLbs: null, hazmatClass: null }) })
    expect(c.weightLbs).toBeNull()
    expect(c.hazmat).toBeNull()
  })

  it('carries the fuel plan only when the engine actually knew something', () => {
    const fuel = { burn: { deadheadGal: 0, loadedGal: 90, totalGal: 90, mpgUsed: null }, advice: null, ifta: { byState: [], unattributedGal: 0 }, known: false } as unknown as FuelPlanBody
    expect(card({ fuelPlan: null }).fuel).toBeNull()
    expect(card({ fuelPlan: fuel }).fuel!.known).toBe(false)
  })

  it('clamps a progress share outside 0..1 instead of inventing negative miles', () => {
    expect(card({ progress: -1 }).drivenMi).toBe(0)
    expect(card({ progress: 5 }).remainingMi).toBe(0)
  })
})
