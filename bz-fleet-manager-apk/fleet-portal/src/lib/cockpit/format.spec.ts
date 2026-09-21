import { describe, expect, it } from 'vitest'
import { ageLabel, avatarColor, cityOf, fmtClock, fmtDT, fmtDayShort, hrsLabel, initials } from './format'

const TZ = 'America/Chicago'
const NOW = Date.UTC(2026, 7, 28, 19, 32)

describe('cockpit format helpers', () => {
  it('labels', () => {
    expect(hrsLabel(495)).toBe('8h 15m')
    expect(hrsLabel(0)).toBe('0h 00m')
    expect(hrsLabel(null)).toBe('—')
    expect(initials('Jake Morrow')).toBe('JM')
    expect(initials('Priya')).toBe('P')
    expect(cityOf('Kansas City, MO DC #4')).toBe('Kansas City')
    expect(cityOf(null)).toBe('')
  })

  it('avatar colours are stable per id and within the palette', () => {
    expect(avatarColor('d1')).toBe(avatarColor('d1'))
    expect(['emerald', 'cyan', 'amber', 'violet', 'blue', 'slate', 'purple', 'red']).toContain(avatarColor('anything'))
  })

  it('formats org-tz clocks and dates', () => {
    expect(fmtClock(NOW, TZ)).toBe('14:32')
    expect(fmtDayShort(NOW, TZ)).toBe('FRI 28')
    expect(fmtDT(NOW, TZ)).toBe('Aug 28 @ 14:32')
  })

  it('ages', () => {
    expect(ageLabel(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe('4m')
    expect(ageLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h')
    expect(ageLabel(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d')
    expect(ageLabel(new Date(NOW - 10_000).toISOString(), NOW)).toBe('now')
    expect(ageLabel(null, NOW)).toBe('—')
  })
})
