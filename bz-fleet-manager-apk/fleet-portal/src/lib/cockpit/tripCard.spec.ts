import { describe, expect, it } from 'vitest'
import type { BoardLoad, LoadboardLane } from '../../stores/loadboard'
import { buildTripSummary, durationLabel, PING_FRESH_MS } from './tripCard'

// The trip card is what a dispatcher reads before phoning a driver. Every test
// below is about a value that would be WRONG rather than merely missing if the
// null handling slipped — "0h to break" for a driver whose hours were never
// imported is the one that puts a truck into a violation.

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)

const load = (over: Partial<BoardLoad> = {}): BoardLoad =>
  ({
    id: 'load-1',
    reference: 'L-90411',
    status: 'in_progress',
    origin: 'Memphis',
    destination: 'Kansas City',
    stops: [
      { sequence: 1, type: 'pickup', address: 'Memphis, TN 38103', lat: 35.15, lng: -90.05, dwellMin: 60, windowStart: null, windowEnd: null },
      { sequence: 2, type: 'delivery', address: 'Kansas City, MO 64106', lat: 39.1, lng: -94.58, dwellMin: 60, windowStart: null, windowEnd: null },
    ],
    assignment: {
      id: 'a1',
      driverId: 'd1',
      status: 'in_progress',
      plannedStart: new Date(NOW - 2 * HOUR).toISOString(),
      plannedEnd: new Date(NOW + 4 * HOUR).toISOString(),
    },
    ...over,
  }) as unknown as BoardLoad

const lane = (over: Partial<LoadboardLane> = {}): LoadboardLane =>
  ({ id: 'd1', name: 'Tyrone Banks', hosKnown: true, minutesSinceBreak: 400, driveRemainingMin: 300, ...over }) as unknown as LoadboardLane

describe('buildTripSummary', () => {
  it('summarises a rolling trip with its next stop and countdown', () => {
    const t = buildTripSummary(load(), lane(), NOW - 5 * 60_000, NOW)!
    expect(t.loadRef).toBe('L-90411')
    expect(t.driverName).toBe('Tyrone Banks')
    expect(t.origin).toBe('Memphis')
    expect(t.destination).toBe('Kansas City')
    expect(t.nextStop).not.toBeNull()
    expect(t.nextStop!.etaMs).toBeGreaterThan(NOW)
  })

  it('strips the ZIP from a stop label but keeps the state', () => {
    const t = buildTripSummary(load(), lane(), NOW, NOW)!
    expect(t.nextStop!.label).toBe('Kansas City, MO')
  })

  it('marks the ETA approximate — it interpolates a window, it is not routed', () => {
    // The map now draws real roads, which makes it tempting to present the
    // arrival as measured too. stopEtas still has no road network, no traffic
    // and no inserted HOS break, so the hedge stays until the ETA itself is
    // routed.
    const t = buildTripSummary(load(), lane(), NOW, NOW)!
    expect(t.nextStop!.etaApprox).toBe(true)
  })

  it('reports HOS as UNKNOWN, never as zero, when hours were never imported', () => {
    // The defect this guards: a dispatcher reading "0h to break" for a driver
    // with no imported clock, and routing them straight into a violation.
    const t = buildTripSummary(load(), lane({ hosKnown: false }), NOW, NOW)!
    expect(t.minutesToBreak).toBeNull()
    expect(t.driveRemainingMin).toBeNull()
  })

  it('counts down to the break from imported minutes', () => {
    const t = buildTripSummary(load(), lane({ minutesSinceBreak: 400 }), NOW, NOW)!
    expect(t.minutesToBreak).toBe(80) // 480 - 400
  })

  it('never reports a negative break clock for an already-overdue driver', () => {
    const t = buildTripSummary(load(), lane({ minutesSinceBreak: 600 }), NOW, NOW)!
    expect(t.minutesToBreak).toBe(0)
  })

  it('calls a position stale past the freshness window, and never-pinged when absent', () => {
    const fresh = buildTripSummary(load(), lane(), NOW - 60_000, NOW)!
    expect(fresh.positionStale).toBe(false)

    const stale = buildTripSummary(load(), lane(), NOW - PING_FRESH_MS - 1, NOW)!
    expect(stale.positionStale).toBe(true)

    const never = buildTripSummary(load(), lane(), null, NOW)!
    expect(never.pingAgeMs).toBeNull()
    // No ping at all is stale in the only sense that matters: we cannot claim
    // to know where this truck is.
    expect(never.positionStale).toBe(true)
  })

  it('has no next stop once every arrival is in the past', () => {
    const done = load({
      assignment: {
        id: 'a1', driverId: 'd1', status: 'in_progress',
        plannedStart: new Date(NOW - 10 * HOUR).toISOString(),
        plannedEnd: new Date(NOW - 2 * HOUR).toISOString(),
      },
    } as Partial<BoardLoad>)
    const t = buildTripSummary(done, lane(), NOW, NOW)!
    // Not a negative countdown, and not a fabricated future arrival.
    expect(t.nextStop).toBeNull()
  })

  it('returns null for a load that is not a trip', () => {
    expect(buildTripSummary(load({ assignment: null } as Partial<BoardLoad>), lane(), NOW, NOW)).toBeNull()
    expect(buildTripSummary(load({ stops: [] } as Partial<BoardLoad>), lane(), NOW, NOW)).toBeNull()
  })

  it('survives a missing lane rather than throwing', () => {
    // A driver whose lane has not loaded yet must not blank the whole map.
    const t = buildTripSummary(load(), undefined, NOW, NOW)!
    expect(t.driverName).toBe('Unknown driver')
    expect(t.minutesToBreak).toBeNull()
  })
})

describe('durationLabel', () => {
  it('formats hours and minutes without a stray zero', () => {
    expect(durationLabel(26 * 60_000)).toBe('26m')
    expect(durationLabel(80 * 60_000)).toBe('1h 20m')
    expect(durationLabel(120 * 60_000)).toBe('2h')
  })

  it('clamps negatives to zero rather than rendering "-5m"', () => {
    expect(durationLabel(-5 * 60_000)).toBe('0m')
  })
})
