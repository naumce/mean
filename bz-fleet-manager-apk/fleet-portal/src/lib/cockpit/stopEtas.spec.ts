import { describe, expect, it } from 'vitest'
import { stopEtas } from './stopEtas'

const START = Date.UTC(2026, 7, 28, 12, 0)
const MIN = 60_000

describe('stopEtas', () => {
  it('weights the middle stop by real distance and dwell, not by stop count', () => {
    // Three stops on the same meridian, so each hop is exactly R * Δlat in radians:
    //   R = 3958.7613 mi, 1° = 0.0174532925 rad -> 69.09321 mi per degree.
    //   hop 1 (lat 0 -> 1):   69.09321 mi -> /50 mph * 60 =  82.9118 min
    //   hop 2 (lat 1 -> 11): 690.9321 mi -> /50 mph * 60 = 829.1185 min
    // Cost of arriving at a stop = dwell served at the previous stop + that hop:
    //   c0 = 0
    //   c1 = 60 +  82.9118 =  142.9118
    //   c2 = c1 + 60 + 829.1185 = 1032.0303
    // Share for the middle stop = 142.9118 / 1032.0303 = 0.1384763
    // Over a 1000-minute window that is 138.476 min in, where even spacing
    // (the old behaviour) would have said 500.
    const stops = [
      { lat: 0, lng: 0, dwellMin: 60 },
      { lat: 1, lng: 0, dwellMin: 60 },
      { lat: 11, lng: 0, dwellMin: 60 },
    ]
    const end = START + 1000 * MIN
    const etas = stopEtas(stops, START, end)
    expect(etas).toHaveLength(3)
    expect(etas[0]).toBe(START)
    expect(etas[2]).toBe(end)
    expect((etas[1] - START) / MIN).toBeCloseTo(138.476, 2)
    // The point of the fix: nowhere near the halfway mark.
    expect((etas[1] - START) / MIN).toBeLessThan(200)
  })

  it('falls back to even spacing when a stop has no coordinates', () => {
    const stops = [
      { lat: 0, lng: 0, dwellMin: 60 },
      { lat: null, lng: null, dwellMin: 60 },
      { lat: 11, lng: 0, dwellMin: 60 },
    ]
    const end = START + 1000 * MIN
    expect(stopEtas(stops, START, end).map((m) => (m - START) / MIN)).toEqual([0, 500, 1000])
  })

  it('falls back to even spacing when there is no work to weight by (co-located, no dwell)', () => {
    const stops = [
      { lat: 5, lng: -90, dwellMin: 0 },
      { lat: 5, lng: -90, dwellMin: 0 },
      { lat: 5, lng: -90, dwellMin: 0 },
    ]
    const end = START + 600 * MIN
    expect(stopEtas(stops, START, end).map((m) => (m - START) / MIN)).toEqual([0, 300, 600])
  })

  it('handles degenerate stop lists', () => {
    expect(stopEtas([], START, START + MIN)).toEqual([])
    expect(stopEtas([{ lat: 1, lng: 1, dwellMin: 30 }], START, START + MIN)).toEqual([START])
  })

  it('treats a missing dwell as zero rather than throwing', () => {
    // Same geometry as the weighted case with dwell removed:
    //   c1 = 82.9118, c2 = 912.0303 -> share 0.0909...
    const stops = [{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 11, lng: 0 }]
    const etas = stopEtas(stops, START, START + 1000 * MIN)
    expect((etas[1] - START) / MIN).toBeCloseTo(90.909, 2)
  })
})
