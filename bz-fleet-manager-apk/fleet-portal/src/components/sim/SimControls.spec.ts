import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/auth'
import { useSimStore } from '../../stores/sim'
import SimControls from './SimControls.vue'
import type { SimState } from '../../lib/api'

vi.mock('../../stores/sim', () => ({ useSimStore: vi.fn() }))
const mockedUseSimStore = vi.mocked(useSimStore)

function sampleState(overrides: Partial<SimState> = {}): SimState {
  return { running: false, speed: 1, simMinutesAdvanced: 30, simNowMs: Date.now(), lastTickAt: null, drivers: [], ...overrides }
}

function createSimStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    state: sampleState(),
    busy: false,
    error: null,
    lastTickAt: null,
    probe: vi.fn(),
    tick: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    setDriverMode: vi.fn(),
    ...overrides,
  }
}

function mountWithStub(overrides: Record<string, unknown> = {}) {
  const store = createSimStoreStub(overrides)
  mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
  const wrapper = mount(SimControls)
  return { wrapper, store }
}

describe('SimControls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedUseSimStore.mockReset()
    useAuthStore().setSession({
      token: 't',
      dispatcher: { id: 'd1', name: 'Dee', email: 'd@x.com', orgId: 'o1' },
      org: { id: 'o1', name: 'Acme', timezone: 'America/Chicago' },
      plan: { tier: 'tower' },
    })
  })

  it('renders nothing when available is false', () => {
    const { wrapper } = mountWithStub({ available: false })
    expect(wrapper.find('[data-testid="sim-controls"]').exists()).toBe(false)
  })

  it('renders the bar and probes on mount when available is not false', () => {
    const { wrapper, store } = mountWithStub()
    expect(wrapper.find('[data-testid="sim-controls"]').exists()).toBe(true)
    expect(store.probe).toHaveBeenCalled()
  })

  it('shows the advanced-minutes label and the stopped/running badge', () => {
    const stopped = mountWithStub({ state: sampleState({ running: false, simMinutesAdvanced: 45 }) })
    expect(stopped.wrapper.find('[data-testid="sim-now"]').text()).toContain('+45 min')
    expect(stopped.wrapper.find('[data-testid="sim-run-badge"]').text()).toBe('stopped')

    const running = mountWithStub({ state: sampleState({ running: true, speed: 5 }) })
    expect(running.wrapper.find('[data-testid="sim-run-badge"]').text()).toBe('running · 5x')
  })

  it('never crashes when state is missing expected numeric fields', () => {
    const { wrapper } = mountWithStub({ state: {} })
    expect(wrapper.find('[data-testid="sim-now"]').text()).toContain('—')
    expect(wrapper.find('[data-testid="sim-now"]').text()).toContain('+0 min')
  })

  it('tick buttons call sim.tick with the right minutes', async () => {
    const { wrapper, store } = mountWithStub()
    await wrapper.find('[data-testid="sim-tick-15"]').trigger('click')
    await wrapper.find('[data-testid="sim-tick-60"]').trigger('click')
    await wrapper.find('[data-testid="sim-tick-240"]').trigger('click')
    expect(store.tick).toHaveBeenNthCalledWith(1, 15)
    expect(store.tick).toHaveBeenNthCalledWith(2, 60)
    expect(store.tick).toHaveBeenNthCalledWith(3, 240)
  })

  it('the Start/Stop button calls start(speed) when stopped and stop() when running', async () => {
    const { wrapper, store } = mountWithStub({ state: sampleState({ running: false }) })
    expect(wrapper.find('[data-testid="sim-toggle-run"]').text()).toBe('Start')
    await wrapper.find('[data-testid="sim-toggle-run"]').trigger('click')
    expect(store.start).toHaveBeenCalledWith(1)

    const runningWrapper = mountWithStub({ state: sampleState({ running: true }) })
    expect(runningWrapper.wrapper.find('[data-testid="sim-toggle-run"]').text()).toBe('Stop')
    await runningWrapper.wrapper.find('[data-testid="sim-toggle-run"]').trigger('click')
    expect(runningWrapper.store.stop).toHaveBeenCalled()
  })

  it('disables every action button while busy', () => {
    const { wrapper } = mountWithStub({ busy: true })
    for (const testid of ['sim-tick-15', 'sim-tick-60', 'sim-tick-240', 'sim-toggle-run', 'sim-reset']) {
      expect(wrapper.find(`[data-testid="${testid}"]`).attributes('disabled')).toBeDefined()
    }
  })

  describe('reset world', () => {
    it('does nothing when the confirmation is declined', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { wrapper, store } = mountWithStub()
      await wrapper.find('[data-testid="sim-reset"]').trigger('click')
      expect(store.reset).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="sim-reseeding"]').exists()).toBe(false)
    })

    it('calls reset() and shows "reseeding…" once confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { wrapper, store } = mountWithStub({ reset: vi.fn(() => new Promise(() => {})) })
      await wrapper.find('[data-testid="sim-reset"]').trigger('click')
      expect(store.reset).toHaveBeenCalled()
      expect(wrapper.find('[data-testid="sim-reseeding"]').exists()).toBe(true)
    })
  })
})
