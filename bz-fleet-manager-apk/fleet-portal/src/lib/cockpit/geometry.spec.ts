import { describe, expect, it } from 'vitest'
import {
  addDaysYmd, brickSpan, dayColumns, dayWidth, diffDaysYmd, timeToX, totalWidth, tzOffsetMin,
  wallMinutes, wallYmd, windowRange, xToTime, zonedMidnightMs, type CockpitConfig,
} from './geometry'

const TZ = 'America/Chicago'
// Fri 28 Aug 2026 14:32 CDT (UTC-5)
const NOW = Date.UTC(2026, 7, 28, 19, 32)
const cfg: CockpitConfig = { tz: TZ, day0: '2026-08-28', days: 3, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 }

describe('cockpit geometry (org timezone)', () => {
  it('reads wall-clock parts in the org timezone', () => {
    expect(wallYmd(NOW, TZ)).toBe('2026-08-28')
    expect(wallMinutes(NOW, TZ)).toBe(14 * 60 + 32)
    expect(tzOffsetMin(NOW, TZ)).toBe(-300)
    expect(wallYmd(Date.UTC(2026, 7, 29, 3, 0), TZ)).toBe('2026-08-28') // 22:00 CDT still Friday
  })

  it('computes zoned midnights across the DST change', () => {
    expect(zonedMidnightMs('2026-08-28', TZ)).toBe(Date.UTC(2026, 7, 28, 5))
    expect(zonedMidnightMs('2026-11-01', TZ)).toBe(Date.UTC(2026, 10, 1, 5)) // still CDT at midnight
    expect(zonedMidnightMs('2026-11-02', TZ)).toBe(Date.UTC(2026, 10, 2, 6)) // CST after fall-back
  })

  it('calendar helpers', () => {
    expect(addDaysYmd('2026-08-30', 2)).toBe('2026-09-01')
    expect(diffDaysYmd('2026-08-28', '2026-08-30')).toBe(2)
    expect(diffDaysYmd('2026-08-28', '2026-08-27')).toBe(-1)
  })

  it('maps instants to pixels within the window and null outside it', () => {
    expect(dayWidth(cfg)).toBe(18 * 22)
    expect(totalWidth(cfg)).toBe(18 * 22 * 3)
    expect(timeToX(NOW, cfg)).toBeCloseTo((14.5333 - 6) * 22, 1)
    expect(timeToX(Date.UTC(2026, 7, 29, 11, 0), cfg)).toBe(dayWidth(cfg)) // Sat 06:00 CDT = day 1, hour 0
    expect(timeToX(Date.UTC(2026, 7, 27, 12, 0), cfg)).toBeNull()
    expect(timeToX(Date.UTC(2026, 7, 28, 8, 0), cfg)).toBe(0) // 03:00 CDT clamps to the window start
  })

  it('maps pixels back to snapped instants', () => {
    expect(xToTime(0, cfg)).toBe(Date.UTC(2026, 7, 28, 11, 0)) // Fri 06:00 CDT
    expect(xToTime(5.5, cfg)).toBe(Date.UTC(2026, 7, 28, 11, 15)) // 15-min snap
    expect(xToTime(dayWidth(cfg) + 22, cfg)).toBe(Date.UTC(2026, 7, 29, 12, 0)) // Sat 07:00 CDT
    expect(xToTime(99999, cfg)).toBe(Date.UTC(2026, 7, 31, 5, 0)) // clamps to the last day's end (Sun 24:00)
  })

  it('window range is whole org-days, for the API', () => {
    expect(windowRange(cfg)).toEqual({ fromMs: Date.UTC(2026, 7, 28, 5), toMs: Date.UTC(2026, 7, 31, 5) })
  })

  it('brickSpan clips multi-day legs and drops fully-outside ones', () => {
    // Fri 14:00 -> Sat 09:00 CDT
    const s = brickSpan(Date.UTC(2026, 7, 28, 19), Date.UTC(2026, 7, 29, 14), cfg)!
    expect(s.x).toBeCloseTo(8 * 22, 5)
    expect(s.w).toBeCloseTo(dayWidth(cfg) + 3 * 22 - 8 * 22, 5)
    // Spans the entire window
    expect(brickSpan(Date.UTC(2026, 7, 20), Date.UTC(2026, 8, 20), cfg)).toEqual({ x: 0, w: totalWidth(cfg) })
    // Entirely before
    expect(brickSpan(Date.UTC(2026, 7, 20), Date.UTC(2026, 7, 21), cfg)).toBeNull()
    // Minimum width = half an hour of pixels
    const tiny = brickSpan(NOW, NOW + 60_000, cfg)!
    expect(tiny.w).toBe(11)
  })

  it('day columns carry labels, today and weekend flags', () => {
    const cols = dayColumns(cfg, NOW)
    expect(cols.map((c) => c.label)).toEqual(['FRI 28', 'SAT 29', 'SUN 30'])
    expect(cols[0].isToday).toBe(true)
    expect(cols[1].isWeekend).toBe(true)
    expect(cols[2].x).toBe(2 * dayWidth(cfg))
  })

  describe('xToTime / timeToX across a DST-transition day', () => {
    // The board's visible window (06:00-24:00) starts well after either US
    // transition hour (~2-3 AM), but a wrong midnight anchor still throws off
    // every minute in that window on the transition day itself — this is what
    // sank the earlier ms-arithmetic implementation of xToTime.
    const springCfg: CockpitConfig = { tz: TZ, day0: '2026-03-08', days: 1, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 }
    const fallCfg: CockpitConfig = { tz: TZ, day0: '2026-11-01', days: 1, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 }

    // Quarter-hours (minutes since midnight) covering [startHour, endHour).
    const quarterHours = (startHour: number, endHour: number): number[] => {
      const out: number[] = []
      for (let m = startHour * 60; m < endHour * 60; m += 15) out.push(m)
      return out
    }

    it('round-trips every 15-minute slot in the window on the spring-forward day (2026-03-08, CST->CDT)', () => {
      // By 06:00 the 02:00 CST -> 03:00 CDT jump already happened, so the whole
      // window reads a single, stable UTC-5 offset: local hh:mm = (hh+5):mm UTC.
      for (const m of quarterHours(6, 24)) {
        const hh = Math.floor(m / 60)
        const mm = m % 60
        const t = Date.UTC(2026, 2, 8, hh + 5, mm)
        const expectedX = (m / 60 - springCfg.dayStartHour) * springCfg.pxPerHour
        expect(timeToX(t, springCfg)).toBeCloseTo(expectedX, 6)
        expect(xToTime(timeToX(t, springCfg) as number, springCfg)).toBe(t)
      }
    })

    it('round-trips every 15-minute slot in the window on the fall-back day (2026-11-01, CDT->CST)', () => {
      // By 06:00 the 02:00 CDT -> 01:00 CST jump already happened, so the whole
      // window reads a single, stable UTC-6 offset: local hh:mm = (hh+6):mm UTC.
      for (const m of quarterHours(6, 24)) {
        const hh = Math.floor(m / 60)
        const mm = m % 60
        const t = Date.UTC(2026, 10, 1, hh + 6, mm)
        const expectedX = (m / 60 - fallCfg.dayStartHour) * fallCfg.pxPerHour
        expect(timeToX(t, fallCfg)).toBeCloseTo(expectedX, 6)
        expect(xToTime(timeToX(t, fallCfg) as number, fallCfg)).toBe(t)
      }
    })

    it('round-trips unambiguous wall-clock times straddling the transition hour itself', () => {
      // A window opened wide enough (00:00-24:00) to reach the transition hour,
      // using times that exist exactly once (not the skipped or repeated hour).
      const springFullDay: CockpitConfig = { ...springCfg, dayStartHour: 0 }
      const fallFullDay: CockpitConfig = { ...fallCfg, dayStartHour: 0 }

      const before230amSpring = Date.UTC(2026, 2, 8, 7, 45) // 01:45 CST, pre-jump
      const after230amSpring = Date.UTC(2026, 2, 8, 8, 15) // 03:15 CDT, post-jump
      expect(timeToX(before230amSpring, springFullDay)).toBeCloseTo(1.75 * 22, 6)
      expect(timeToX(after230amSpring, springFullDay)).toBeCloseTo(3.25 * 22, 6)
      expect(xToTime(timeToX(before230amSpring, springFullDay) as number, springFullDay)).toBe(before230amSpring)
      expect(xToTime(timeToX(after230amSpring, springFullDay) as number, springFullDay)).toBe(after230amSpring)

      const beforeRepeatFall = Date.UTC(2026, 10, 1, 5, 45) // 00:45 CDT, before the repeated hour
      const afterRepeatFall = Date.UTC(2026, 10, 1, 8, 15) // 02:15 CST, after the repeated hour
      expect(timeToX(beforeRepeatFall, fallFullDay)).toBeCloseTo(0.75 * 22, 6)
      expect(timeToX(afterRepeatFall, fallFullDay)).toBeCloseTo(2.25 * 22, 6)
      expect(xToTime(timeToX(beforeRepeatFall, fallFullDay) as number, fallFullDay)).toBe(beforeRepeatFall)
      expect(xToTime(timeToX(afterRepeatFall, fallFullDay) as number, fallFullDay)).toBe(afterRepeatFall)
    })
  })

  it('documents the nonexistent-local-time fallback when a spring-forward gap coincides with midnight', () => {
    // Santiago's spring-forward (Southern Hemisphere DST) lands exactly at
    // 00:00, so 2026-09-06 00:00-00:59 never occurs on the local wall clock.
    // zonedMidnightMs has no gap-detection logic (see its doc comment); it
    // deterministically resolves using the pre-transition offset, so the
    // returned instant reads back one DST delta (1h) *earlier* than midnight.
    // This pins that documented, known-imperfect behavior against regressions.
    expect(zonedMidnightMs('2026-09-06', 'America/Santiago')).toBe(Date.UTC(2026, 8, 6, 3))
  })
})
