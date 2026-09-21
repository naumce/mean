import { describe, expect, it } from 'vitest'
import { complianceStatus, isExpired } from './compliance'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 3_600_000

describe('complianceStatus', () => {
  it('labels untracked clocks honestly — never green by omission', () => {
    expect(complianceStatus(null, NOW)).toEqual({ level: 'untracked', label: 'not tracked' })
    expect(complianceStatus(undefined, NOW)).toEqual({ level: 'untracked', label: 'not tracked' })
  })

  it('tiers expired / approaching / healthy', () => {
    expect(complianceStatus(new Date(NOW - DAY).toISOString(), NOW).level).toBe('expired')
    expect(complianceStatus(new Date(NOW - DAY).toISOString(), NOW).label).toContain('expired 2026-08-21')
    const soon = complianceStatus(new Date(NOW + 10 * DAY).toISOString(), NOW)
    expect(soon.level).toBe('soon')
    expect(soon.label).toContain('10d left')
    expect(complianceStatus(new Date(NOW + 90 * DAY).toISOString(), NOW)).toEqual({ level: 'ok', label: '2026-11-20' })
  })
})

describe('isExpired', () => {
  const at = new Date(NOW).toISOString()

  it('agrees with complianceStatus at the exact expiry instant — nothing has expired yet', () => {
    // The bug this pins: the pill, the brick and the lane header each rolled
    // their own `Date.parse(x) <= nowMs`, so at nowMs === expiry they said
    // EXPIRED while the chip beside them still said "soon".
    expect(isExpired(at, NOW)).toBe(false)
    expect(complianceStatus(at, NOW).level).toBe('soon')
    expect(isExpired(at, NOW + 1)).toBe(true)
    expect(complianceStatus(at, NOW + 1).level).toBe('expired')
  })

  it('never calls an untracked or unparseable clock expired', () => {
    expect(isExpired(null, NOW)).toBe(false)
    expect(isExpired(undefined, NOW)).toBe(false)
    expect(isExpired('not-a-date', NOW)).toBe(false)
  })

  it('matches complianceStatus across the tiers', () => {
    for (const offset of [-10 * DAY, -1, 0, 1, 10 * DAY, 90 * DAY]) {
      const iso = new Date(NOW + offset).toISOString()
      expect(isExpired(iso, NOW), String(offset)).toBe(complianceStatus(iso, NOW).level === 'expired')
    }
  })
})
