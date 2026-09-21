import { describe, expect, it } from 'vitest'
import { type BoardConfig, brickWidth, daysInWindow, hourWidth, timeToX, xToTime } from './geometry'

// One UTC day, 08:00-20:00 (12h), 1200px wide -> 100px/hour.
const cfg: BoardConfig = {
  fromDate: new Date('2026-08-21T00:00:00.000Z'),
  toDate: new Date('2026-08-21T00:00:00.000Z'),
  dayStartHour: 8,
  dayEndHour: 20,
  boardWidthPx: 1200,
}

describe('board geometry', () => {
  it('counts inclusive days', () => {
    expect(daysInWindow(cfg)).toBe(1)
    expect(daysInWindow({ ...cfg, toDate: new Date('2026-08-23T00:00:00.000Z') })).toBe(3)
  })

  it('computes hour width', () => {
    expect(hourWidth(cfg)).toBe(100)
  })

  it('maps day-start to x=0 and places 12:00 at 4 hours in', () => {
    expect(timeToX(new Date('2026-08-21T08:00:00.000Z'), cfg)).toBe(0)
    expect(timeToX(new Date('2026-08-21T12:00:00.000Z'), cfg)).toBe(400)
  })

  it('clamps out-of-window times to the board edges', () => {
    expect(timeToX(new Date('2026-08-21T06:00:00.000Z'), cfg)).toBe(0)
    expect(timeToX(new Date('2026-08-21T23:00:00.000Z'), cfg)).toBe(1200)
  })

  it('xToTime inverts timeToX and snaps to 15 minutes', () => {
    expect(xToTime(400, cfg).toISOString()).toBe('2026-08-21T12:00:00.000Z')
    expect(xToTime(425, cfg).toISOString()).toBe('2026-08-21T12:15:00.000Z')
  })

  it('brickWidth spans start->end with a quarter-hour floor', () => {
    expect(brickWidth(new Date('2026-08-21T08:00:00.000Z'), new Date('2026-08-21T11:00:00.000Z'), cfg)).toBe(300)
    expect(brickWidth(new Date('2026-08-21T08:00:00.000Z'), new Date('2026-08-21T08:00:00.000Z'), cfg)).toBe(25)
  })
})
