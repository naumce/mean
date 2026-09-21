import { describe, expect, it } from 'vitest'
import { hosFreshness } from './hosFreshness'

const NOW = Date.parse('2026-08-21T12:00:00.000Z')

describe('hosFreshness', () => {
  it('treats missing or unparsable stamps as stale with an honest label', () => {
    expect(hosFreshness(null, NOW)).toEqual({ label: 'HOS age unknown', stale: true })
    expect(hosFreshness(undefined, NOW)).toEqual({ label: 'HOS age unknown', stale: true })
    expect(hosFreshness('garbage', NOW)).toEqual({ label: 'HOS age unknown', stale: true })
  })

  it('labels fresh data in minutes then hours', () => {
    expect(hosFreshness('2026-08-21T11:45:00.000Z', NOW)).toEqual({ label: 'HOS as of 15m ago', stale: false })
    expect(hosFreshness('2026-08-21T09:00:00.000Z', NOW)).toEqual({ label: 'HOS as of 3h ago', stale: false })
  })

  it('flags anything a day or older as stale', () => {
    expect(hosFreshness('2026-08-20T11:00:00.000Z', NOW)).toEqual({ label: 'HOS as of 1d ago', stale: true })
    expect(hosFreshness('2026-08-14T12:00:00.000Z', NOW)).toEqual({ label: 'HOS as of 7d ago', stale: true })
  })
})
