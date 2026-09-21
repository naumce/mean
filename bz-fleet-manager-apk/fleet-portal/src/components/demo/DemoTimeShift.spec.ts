import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DemoTimeShift from './DemoTimeShift.vue'

vi.mock('../../lib/api', () => ({ fetchDemoShiftPlan: vi.fn(), runDemoShift: vi.fn() }))
const { fetchDemoShiftPlan, runDemoShift } = await import('../../lib/api')
const probe = vi.mocked(fetchDemoShiftPlan)
const run = vi.mocked(runDemoShift)

// This control rewrites every date in the database. Most of what matters is
// that it never appears where it must not, and never claims to have moved
// something it did not.

const mountIt = async () => {
  const w = mount(DemoTimeShift)
  await flushPromises()
  return w
}

beforeEach(() => {
  probe.mockReset()
  run.mockReset()
})

describe('DemoTimeShift', () => {
  it('renders NOTHING when the server is not in demo mode', async () => {
    // The probe returning null is a 404 — a normal server. Showing a button
    // that rewrites timestamps on one would be the worst kind of dead control.
    probe.mockResolvedValue(null)
    const w = await mountIt()
    expect(w.find('[data-testid="demo-time-shift"]').exists()).toBe(false)
  })

  it('says how far behind the scenario is', async () => {
    probe.mockResolvedValue({ shifted: true, days: 4, reason: null })
    const w = await mountIt()
    expect(w.find('[data-testid="demo-stale"]').text()).toContain('4 days')
    expect(w.find('[data-testid="demo-shift-button"]').attributes('disabled')).toBeUndefined()
  })

  it('disables the button when there is nothing to move, and says why', async () => {
    // Offering an action that turns out to be a no-op reads as a broken button.
    probe.mockResolvedValue({ shifted: false, days: 0, reason: 'Already current — the scenario is less than a day old.' })
    const w = await mountIt()
    expect(w.find('[data-testid="demo-current"]').text()).toMatch(/already current/i)
    expect(w.find('[data-testid="demo-shift-button"]').attributes('disabled')).toBeDefined()
  })

  it('gets the singular right for one day', async () => {
    probe.mockResolvedValue({ shifted: true, days: 1, reason: null })
    const w = await mountIt()
    expect(w.find('[data-testid="demo-stale"]').text()).toContain('1 day')
    expect(w.find('[data-testid="demo-stale"]').text()).not.toContain('1 days')
  })

  it('reports what actually moved, not what was asked for', async () => {
    probe.mockResolvedValue({ shifted: true, days: 3, reason: null })
    const w = await mountIt()
    // The server is the authority on how far it went — it may refuse between
    // the probe and the press.
    run.mockResolvedValue({ shifted: false, days: 0, reason: 'Already current — the scenario is less than a day old.' })
    await w.find('[data-testid="demo-shift-button"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="demo-shift-result"]').text()).toMatch(/already current/i)
    expect(w.find('[data-testid="demo-shift-result"]').text()).not.toMatch(/moved 3/i)
  })

  it('surfaces a failure instead of implying the data moved', async () => {
    probe.mockResolvedValue({ shifted: true, days: 2, reason: null })
    const w = await mountIt()
    run.mockRejectedValue(new Error('boom'))
    await w.find('[data-testid="demo-shift-button"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="demo-shift-result"]').text()).toMatch(/could not move/i)
  })

  it('confirms the move before reloading', async () => {
    probe.mockResolvedValue({ shifted: true, days: 5, reason: null })
    const w = await mountIt()
    run.mockResolvedValue({ shifted: true, days: 5, reason: null })
    await w.find('[data-testid="demo-shift-button"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="demo-shift-result"]').text()).toContain('Moved 5 days')
  })
})
