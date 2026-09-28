import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DemoStatusLine from './DemoStatusLine.vue'
import type { DemoSimInfo, DemoStage } from '../../types/demo'

const RUNNING: DemoSimInfo = { running: true, speed: 5, simNowMs: 1000 }
const STOPPED: DemoSimInfo = { running: false, speed: null, simNowMs: 1000 }
const NOW = Date.parse('2026-09-28T12:00:00.000Z')

function render(
  stage: DemoStage,
  waitingOn: string | null,
  sim: DemoSimInfo = RUNNING,
  extra: { holdStartedAt?: string | null; nowMs?: number } = {},
) {
  return mount(DemoStatusLine, {
    props: { stage, waitingOn, sim, holdStartedAt: extra.holdStartedAt ?? null, nowMs: extra.nowMs ?? NOW },
  })
}

function textOf(
  stage: DemoStage,
  waitingOn: string | null,
  sim: DemoSimInfo = RUNNING,
  extra: { holdStartedAt?: string | null; nowMs?: number } = {},
): string | null {
  const line = render(stage, waitingOn, sim, extra).find('[data-testid="demo-status-line"]')
  return line.exists() ? line.text() : null
}

describe('DemoStatusLine', () => {
  it('shows the plain dock-hold sentence while delivering with no holdStartedAt yet', () => {
    expect(textOf('delivering', 'skip_arrival')).toBe('Holding at the dock so Night Shift records the arrival')
  })

  describe('the dock-hold countdown (fix round 1, Important #3)', () => {
    it('counts down from 7:00 against the real 7-minute cap, using the passed-in "now"', () => {
      // 90s elapsed -> 420 - 90 = 330s = 5:30 left.
      const holdStartedAt = new Date(NOW - 90_000).toISOString()
      expect(textOf('delivering', 'skip_arrival', RUNNING, { holdStartedAt, nowMs: NOW })).toBe(
        'Holding at the dock so Night Shift records the arrival (5:30 left)',
      )
    })

    it('recomputes from a fresh "now" on the next poll — holdStartedAt itself never changes', () => {
      const holdStartedAt = new Date(NOW - 90_000).toISOString()
      // A later poll, 30s further on: 330 - 30 = 300s = 5:00 left.
      expect(textOf('delivering', 'skip_arrival', RUNNING, { holdStartedAt, nowMs: NOW + 30_000 })).toBe(
        'Holding at the dock so Night Shift records the arrival (5:00 left)',
      )
    })

    it('pads single-digit seconds and never shows a negative countdown past the cap', () => {
      const holdStartedAt = new Date(NOW - 415_000).toISOString() // 415s elapsed -> 5s left
      expect(textOf('delivering', 'skip_arrival', RUNNING, { holdStartedAt, nowMs: NOW })).toBe(
        'Holding at the dock so Night Shift records the arrival (0:05 left)',
      )
      const overdue = new Date(NOW - 500_000).toISOString() // past the 420s cap
      expect(textOf('delivering', 'skip_arrival', RUNNING, { holdStartedAt: overdue, nowMs: NOW })).toBe(
        'Holding at the dock so Night Shift records the arrival (0:00 left)',
      )
    })
  })

  it('renders nothing once delivered — nothing left to wait on', () => {
    expect(textOf('delivered', null)).toBeNull()
  })

  it('renders nothing on the error stage — the error banner owns that message', () => {
    expect(textOf('error', null)).toBeNull()
  })

  it('stays silent whenever a human action is already the card\'s own button (waitingOn non-null)', () => {
    expect(textOf('uncovered', 'ask_ai')).toBeNull()
    expect(textOf('awaiting_approval', 'approve')).toBeNull()
    expect(textOf('awaiting_driver_reply', 'driver_reply')).toBeNull()
    expect(textOf('awaiting_customer_update', 'customer_update')).toBeNull()
    expect(textOf('customer_updated', 'resolve')).toBeNull()
  })

  it('names what AI is doing while a recommendation is in progress', () => {
    expect(textOf('ai_recommendation', null)).toBe('Deciding who should run this load')
  })

  it('says the truck is moving while in transit and the simulation is running', () => {
    expect(textOf('in_transit', null, RUNNING)).toBe('Truck moving — Night Shift is watching for trouble')
  })

  it('falls back to the generic waiting sentence in transit when the sim is not running', () => {
    expect(textOf('in_transit', null, STOPPED)).toBe("Waiting for Night Shift's next check — up to 60 seconds")
  })

  it('shows the generic waiting sentence for every other automatic stage', () => {
    expect(textOf('breakdown_detected', null)).toBe("Waiting for Night Shift's next check — up to 60 seconds")
    expect(textOf('resolved', null)).toBe("Waiting for Night Shift's next check — up to 60 seconds")
  })
})
