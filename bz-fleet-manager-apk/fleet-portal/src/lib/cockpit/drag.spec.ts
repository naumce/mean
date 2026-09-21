import { describe, expect, it } from 'vitest'
import { laneAtY, proposeDrop, proposeMove, proposeResize, snapMs, SNAP_MIN } from './drag'
import type { CockpitConfig } from './geometry'

const TZ = 'America/Chicago'
// 3-day window, 22 px/h — the board's default preset.
const cfg: CockpitConfig = { tz: TZ, day0: '2026-08-31', days: 3, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 }
const at = (iso: string) => Date.parse(iso)

describe('snapMs', () => {
  it('snaps to the nearest quarter hour', () => {
    expect(snapMs(at('2026-08-31T14:07:00Z'), TZ)).toBe(at('2026-08-31T14:00:00Z'))
    expect(snapMs(at('2026-08-31T14:08:00Z'), TZ)).toBe(at('2026-08-31T14:15:00Z'))
  })
  it('snaps to wall-clock quarters, not UTC quarters', () => {
    // Every US zone is a whole number of half-hours from UTC, so this holds
    // today; the test exists so a future half-hour zone (or a change to
    // SNAP_MIN) fails loudly instead of drifting the board by minutes.
    expect(snapMs(at('2026-08-31T14:07:00Z'), 'Asia/Kolkata')).toBe(at('2026-08-31T14:00:00Z'))
  })
})

describe('proposeMove', () => {
  it('translates pixels into time at the current zoom', () => {
    const s = at('2026-08-31T15:00:00Z'), e = at('2026-08-31T19:00:00Z')
    const p = proposeMove(s, e, 22, cfg)          // 22px = 1h at 22px/h
    expect(p.startMs).toBe(at('2026-08-31T16:00:00Z'))
    expect(p.endMs).toBe(at('2026-08-31T20:00:00Z')) // duration preserved
  })
  it('preserves duration exactly across a DST boundary', () => {
    // 2026-11-01 is the US fall-back. A leg dragged across it must keep its
    // 4h duration in elapsed time, not gain an hour of wall clock.
    const s = at('2026-11-01T04:00:00Z'), e = at('2026-11-01T08:00:00Z')
    const p = proposeMove(s, e, 44, cfg)
    expect(p.endMs - p.startMs).toBe(e - s)
  })
  it('is a no-op for a zero drag', () => {
    const s = at('2026-08-31T15:00:00Z'), e = at('2026-08-31T19:00:00Z')
    expect(proposeMove(s, e, 0, cfg)).toEqual({ startMs: s, endMs: e })
  })
})

describe('proposeResize', () => {
  const s = at('2026-08-31T15:00:00Z'), e = at('2026-08-31T19:00:00Z')
  it('right edge moves the end only', () => {
    const p = proposeResize(s, e, 44, 'r', cfg)!
    expect(p.startMs).toBe(s)
    expect(p.endMs).toBe(at('2026-08-31T21:00:00Z'))
  })
  it('left edge moves the start only', () => {
    const p = proposeResize(s, e, -22, 'l', cfg)!
    expect(p.startMs).toBe(at('2026-08-31T14:00:00Z'))
    expect(p.endMs).toBe(e)
  })
  it('refuses to invert the leg', () => {
    // Dragging the right edge left past the start must return null, not a
    // negative-duration proposal the server would have to reject.
    expect(proposeResize(s, e, -22 * 5, 'r', cfg)).toBeNull()
  })
  it('refuses to collapse below one snap unit', () => {
    const oneSnapPx = (SNAP_MIN / 60) * cfg.pxPerHour
    expect(proposeResize(s, e, -(4 * 22) + oneSnapPx, 'r', cfg)).not.toBeNull()
    expect(proposeResize(s, e, -(4 * 22), 'r', cfg)).toBeNull()
  })
})

describe('proposeDrop', () => {
  it('delegates to xToTime — a named pass-through, not a second rounding', () => {
    // x=0 is day0's dayStartHour (06:00 local); 06:00 CDT == 11:00Z in August.
    expect(proposeDrop(0, cfg)).toBe(at('2026-08-31T11:00:00Z'))
    // One pxPerHour further in is exactly one wall-clock hour later.
    expect(proposeDrop(cfg.pxPerHour, cfg)).toBe(at('2026-08-31T12:00:00Z'))
  })
})

describe('laneAtY', () => {
  const lanes = [
    { id: 'a', top: 0, height: 100 },
    { id: 'b', top: 100, height: 100 },
  ]
  it('finds the lane under the pointer', () => {
    expect(laneAtY(50, lanes)).toBe('a')
    expect(laneAtY(150, lanes)).toBe('b')
  })
  it('puts a boundary pixel in the lower lane, consistently', () => {
    expect(laneAtY(100, lanes)).toBe('b')
  })
  it('returns null outside every lane rather than guessing the nearest', () => {
    expect(laneAtY(-5, lanes)).toBeNull()
    expect(laneAtY(500, lanes)).toBeNull()
  })
})
