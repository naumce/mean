import { haversineMi } from '../geo'
import { PLANNING_SPEED_MPH } from './lanes'

// Stop-by-stop ETAs inside a planned window. Pure: no Date.now(), no DOM.

export interface EtaStop {
  lat?: number | null
  lng?: number | null
  /** Service time at this stop, minutes. */
  dwellMin?: number | null
}

/**
 * Distribute the planned window across a load's stops, weighted by the real
 * work between them: great-circle distance at the planning speed
 * (PLANNING_SPEED_MPH) plus the dwell served at the stop being left. The first
 * stop lands on `startMs` and the last on `endMs` by construction, so this
 * re-shapes a committed window rather than inventing one — a 20-mile first leg
 * followed by a 600-mile second no longer puts the middle stop at the halfway
 * mark.
 *
 * These are interpolations, not routed ETAs (no road network, no traffic, no
 * HOS breaks): render them hedged (the drawer prefixes "~").
 *
 * FALLBACK — even spacing: when fewer than two stops carry coordinates, or the
 * total weight works out to zero (co-located stops with no dwell), there is
 * nothing to weight by and the stops are spaced evenly across the window,
 * which is exactly what this function replaced. The caller cannot tell the two
 * apart, so the hedge applies to both.
 */
export function stopEtas(stops: readonly EtaStop[], startMs: number, endMs: number): number[] {
  const n = stops.length
  if (n === 0) return []
  if (n === 1) return [startMs]
  const span = endMs - startMs
  const even = (): number[] => stops.map((_, i) => startMs + (span * i) / (n - 1))

  const coords = stops.map((s) => (s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null))
  if (coords.some((c) => c === null)) return even()

  // Cost of arriving at stop i = dwell served at stop i-1 + drive i-1 -> i.
  const cumulative: number[] = [0]
  for (let i = 1; i < n; i++) {
    const from = coords[i - 1]!
    const to = coords[i]!
    const driveMin = (haversineMi(from.lat, from.lng, to.lat, to.lng) / PLANNING_SPEED_MPH) * 60
    const dwellMin = Math.max(0, stops[i - 1].dwellMin ?? 0)
    cumulative.push(cumulative[i - 1] + driveMin + dwellMin)
  }
  const total = cumulative[n - 1]
  if (!(total > 0)) return even()
  return cumulative.map((c) => startMs + (span * c) / total)
}
