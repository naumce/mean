import { describe, expect, it } from 'vitest'
import { backlogUrgency, pickupDeadlineMs } from './urgency'

const NOW = Date.parse('2026-08-21T12:00:00.000Z')
const at = (iso: string) => backlogUrgency(iso, NOW)

describe('backlogUrgency', () => {
  it('stays silent without an appointment or beyond the horizon', () => {
    expect(backlogUrgency(null, NOW)).toBeNull()
    expect(backlogUrgency(undefined, NOW)).toBeNull()
    expect(at('2026-08-22T12:00:00.000Z')).toBeNull() // 24h out — no panic
  })

  it('tiers by time left: soon under 12h, now under 4h, missed when past', () => {
    expect(at('2026-08-21T20:00:00.000Z')).toEqual({ level: 'soon', label: 'cover soon · 8h' })
    expect(at('2026-08-21T14:15:00.000Z')).toEqual({ level: 'now', label: 'cover now · 2h 15m' })
    expect(at('2026-08-21T11:00:00.000Z')).toEqual({ level: 'missed', label: 'pickup window missed' })
  })

  it('formats sub-hour remainders as minutes', () => {
    expect(at('2026-08-21T12:40:00.000Z')).toEqual({ level: 'now', label: 'cover now · 40m' })
  })
})

describe('pickupDeadlineMs', () => {
  it('orders tightest first with no-appointment loads last', () => {
    const loads = ['2026-08-21T20:00:00.000Z', null, '2026-08-21T14:00:00.000Z']
    const sorted = [...loads].sort((a, b) => pickupDeadlineMs(a) - pickupDeadlineMs(b))
    expect(sorted).toEqual(['2026-08-21T14:00:00.000Z', '2026-08-21T20:00:00.000Z', null])
  })
})
