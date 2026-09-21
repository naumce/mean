import { describe, expect, it } from 'vitest'
import type { BoardLoad } from '../../stores/loadboard'
import { connectors } from './deadhead'
import type { CockpitConfig } from './geometry'

const cfg: CockpitConfig = { tz: 'America/Chicago', day0: '2026-08-28', days: 3, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 }
const iso = (ms: number) => new Date(ms).toISOString()
const leg = (id: string, origin: string, destination: string, startMs: number, endMs: number, deadheadMi: number, stops?: BoardLoad['stops']): BoardLoad => ({
  id, reference: id, status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin, destination, stops,
  assignment: { id: 'a' + id, driverId: 'd1', status: 'assigned', plannedStart: iso(startMs), plannedEnd: iso(endMs), marginCents: 0, deadheadMi, loadedMi: 100 },
})

describe('deadhead connectors', () => {
  it('draws a connector only where consecutive legs do not chain, using the server deadhead when present', () => {
    const a = leg('A', 'Kansas City', 'Chicago', Date.UTC(2026, 7, 28, 19), Date.UTC(2026, 7, 29, 14), 0)
    const b = leg('B', 'Indianapolis', 'Columbus', Date.UTC(2026, 7, 30, 12), Date.UTC(2026, 7, 30, 16), 198)
    const c = leg('C', 'Columbus', 'Pittsburgh', Date.UTC(2026, 7, 30, 17), Date.UTC(2026, 7, 30, 21), 0)
    const out = connectors([c, a, b], cfg)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ fromLoadId: 'A', toLoadId: 'B', miles: 198, fromCity: 'Chicago', toCity: 'Indianapolis' })
    expect(out[0].x2).toBeGreaterThan(out[0].x1)
  })

  it('falls back to haversine × 1.2 between the stop coordinates, else null miles', () => {
    const a = leg('A', 'Kansas City', 'Chicago', Date.UTC(2026, 7, 28, 19), Date.UTC(2026, 7, 29, 14), 0,
      [{ sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: 39.1, lng: -94.58, dwellMin: 60, windowStart: null, windowEnd: null },
       { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: 41.88, lng: -87.63, dwellMin: 60, windowStart: null, windowEnd: null }])
    const b = leg('B', 'Indianapolis', 'Columbus', Date.UTC(2026, 7, 30, 12), Date.UTC(2026, 7, 30, 16), 0,
      [{ sequence: 1, type: 'pickup', address: 'Indianapolis, IN', lat: 39.77, lng: -86.15, dwellMin: 60, windowStart: null, windowEnd: null },
       { sequence: 2, type: 'delivery', address: 'Columbus, OH', lat: 39.96, lng: -82.99, dwellMin: 60, windowStart: null, windowEnd: null }])
    const [conn] = connectors([a, b], cfg)
    expect(conn.miles).toBeGreaterThan(190)
    expect(conn.miles).toBeLessThan(210)
    const [noCoords] = connectors([leg('A', 'X', 'Y', Date.UTC(2026, 7, 28, 19), Date.UTC(2026, 7, 28, 21), 0), leg('B', 'Z', 'W', Date.UTC(2026, 7, 29, 12), Date.UTC(2026, 7, 29, 16), 0)], cfg)
    expect(noCoords.miles).toBeNull()
  })

  it('skips pairs outside the window or too close to draw', () => {
    const a = leg('A', 'X', 'Y', Date.UTC(2026, 7, 20, 19), Date.UTC(2026, 7, 20, 21), 0)
    const b = leg('B', 'Z', 'W', Date.UTC(2026, 7, 21, 12), Date.UTC(2026, 7, 21, 16), 5)
    expect(connectors([a, b], cfg)).toEqual([])

    // Same-day, non-chaining legs whose end/start are 3 minutes apart (12:00 -> 12:03 CDT, both
    // inside the window). At pxPerHour 22, 3 min = 3/60 * 22 = 1.1px, under the 2px proximity
    // guard, so no connector should be drawn even though the cities don't chain.
    const close1 = leg('C', 'X', 'Y', Date.UTC(2026, 7, 28, 15), Date.UTC(2026, 7, 28, 17), 0) // ends 12:00 CDT
    const close2 = leg('D', 'Z', 'W', Date.UTC(2026, 7, 28, 17, 3), Date.UTC(2026, 7, 28, 19), 0) // starts 12:03 CDT
    expect(connectors([close1, close2], cfg)).toEqual([])
  })
})
