import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentsView from './AgentsView.vue'
import { useAgentsStore } from '../stores/agents'
import type { AgentsOverview } from '../types/agents'
import type { StatusCopy } from '../stores/agents'

// AI Agents Surface (Task 4): AgentsView is a thin renderer over
// useAgentsStore — the store module is mocked here the same way
// DemoView.spec.ts mocks stores/demo, so this only exercises the view's own
// markup (headlines, the enforcement notice, per-load links, the
// uncertainty marker, loading/error states, and the 15s poll lifecycle).
vi.mock('../stores/agents', () => ({ useAgentsStore: vi.fn() }))
const mockedUseAgentsStore = vi.mocked(useAgentsStore)

const Stub = { template: '<div />' }

async function testRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/cockpit', component: Stub },
      { path: '/ai-lab', component: Stub },
      { path: '/night-shift', component: Stub },
    ],
  })
  await router.push('/agents')
  await router.isReady()
  return router
}

function overview(overrides: Partial<AgentsOverview> = {}): AgentsOverview {
  return {
    generatedAt: '2026-09-30T12:00:00.000Z',
    dispatch: {
      rules: { available: true },
      model: { configured: false, reachable: null, modelPresent: null, model: null, error: null },
      activity: { running: null, queued: 0, lastRun: null },
    },
    nightShift: {
      service: { configured: false, lastActivityAt: null },
      activity: { watching: 0, waitingReply: 0, escalated: 0, held: 0, attention: 0, delivered: 0, off: 0, total: 0, listed: 0 },
      mode: { shadowLoads: 0, liveLoads: 0, livePolicies: 0 },
      enforcement: { customerEmailOn: 'not_enforced', quietHours: 'not_enforced' },
      loads: [],
    },
    ...overrides,
  }
}

function agentsStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    data: overview(),
    loading: false,
    error: null,
    dispatchStatus: { headline: 'Rules available · AI not configured', detail: 'Add a model server.' } as StatusCopy | null,
    nightShiftStatus: { headline: 'Not configured', detail: 'No worker address is set.' } as StatusCopy | null,
    load: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function mountView(storeOverrides: Record<string, unknown> = {}) {
  const store = agentsStoreStub(storeOverrides)
  mockedUseAgentsStore.mockReturnValue(store as unknown as ReturnType<typeof useAgentsStore>)
  const router = await testRouter()
  const wrapper = mount(AgentsView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, store }
}

describe('AgentsView', () => {
  beforeEach(() => {
    mockedUseAgentsStore.mockReset()
    vi.useRealTimers()
  })

  it('renders the h1 and subtext', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.find('h1').text()).toBe('AI Agents')
    expect(wrapper.text()).toContain('What each agent can do right now, and what it is doing.')
  })

  it('renders both headlines from the store getters', async () => {
    const { wrapper } = await mountView({
      dispatchStatus: { headline: 'Rules available · AI ready', detail: 'Last run: John Carter (confidence 0.85) · accepted' },
      nightShiftStatus: { headline: '3 watching · 2 need attention', detail: '1 in shadow mode (messages recorded, not sent) · 2 live · Last report 2m' },
    })
    expect(wrapper.find('[data-testid="dispatch-headline"]').text()).toBe('Rules available · AI ready')
    expect(wrapper.find('[data-testid="nightshift-headline"]').text()).toBe('3 watching · 2 need attention')
  })

  it('renders the mode-vs-activity explainer and the enforcement notice on the Night Shift card', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('Shadow/Live is what it may send. Watching/Waiting/Escalated is what it is doing.')
    const notice = wrapper.find('[data-testid="nightshift-enforcement"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe('Customer email and quiet-hours settings are not enforced yet — communication is governed by Shadow/Live only.')
  })

  it('renders the action links', async () => {
    const { wrapper } = await mountView()
    const links = wrapper.findAll('a').map((a) => ({ text: a.text(), href: a.attributes('href') }))
    expect(links).toContainEqual({ text: 'Find a driver', href: '/cockpit' })
    expect(links).toContainEqual({ text: 'Advanced: AI Lab', href: '/ai-lab' })
    expect(links).toContainEqual({ text: 'Open Control Tower', href: '/cockpit' })
    expect(links).toContainEqual({ text: 'Policies', href: '/night-shift' })
  })

  describe('the load list', () => {
    const loads: AgentsOverview['nightShift']['loads'] = [
      { loadId: 'load-1', boardLoadNo: '1001', pill: 'asked', mode: 'shadow', activity: 'waiting_reply', next: 'Waiting for the driver’s reply.', nextConfidence: 'inferred', lastEventAt: '2026-09-30T11:58:00.000Z' },
      { loadId: 'load-2', boardLoadNo: '1002', pill: 'watching', mode: 'live', activity: 'watching', next: 'Watching. Next check within a minute.', nextConfidence: 'known', lastEventAt: '2026-09-30T11:59:00.000Z' },
    ]

    it('renders one "View agent" link per load with the right href', async () => {
      const { wrapper } = await mountView({ data: overview({ nightShift: { ...overview().nightShift, loads } }) })
      const link1 = wrapper.find('[data-testid="view-agent-load-1"]')
      const link2 = wrapper.find('[data-testid="view-agent-load-2"]')
      expect(link1.attributes('href')).toBe('/cockpit?load=load-1')
      expect(link2.attributes('href')).toBe('/cockpit?load=load-2')
    })

    it('renders each row’s "next" text verbatim, with no transform', async () => {
      const { wrapper } = await mountView({ data: overview({ nightShift: { ...overview().nightShift, loads } }) })
      const rows = wrapper.findAll('[data-testid="load-next"]')
      expect(rows.map((r) => r.text())).toEqual([loads[0].next, loads[1].next])
    })

    it('shows the uncertainty marker only when nextConfidence is not known', async () => {
      const { wrapper } = await mountView({ data: overview({ nightShift: { ...overview().nightShift, loads } }) })
      const row1 = wrapper.find('[data-testid="agent-load-row-load-1"]')
      const row2 = wrapper.find('[data-testid="agent-load-row-load-2"]')
      expect(row1.find('[data-testid="uncertainty-marker"]').exists()).toBe(true)
      expect(row2.find('[data-testid="uncertainty-marker"]').exists()).toBe(false)
    })

    it('shows "Showing <rows> of <listed> loads" when the list is truncated, using activity.listed as the denominator', async () => {
      const { wrapper } = await mountView({
        data: overview({
          nightShift: {
            ...overview().nightShift,
            loads,
            activity: { ...overview().nightShift.activity, total: 623, listed: 25 },
          },
        }),
      })
      expect(wrapper.find('[data-testid="loads-showing-count"]').text()).toBe('Showing 2 of 25 loads')
    })

    it('does not show the showing-count line when all listed loads are shown, even if activity.total is far larger', async () => {
      const { wrapper } = await mountView({
        data: overview({
          nightShift: {
            ...overview().nightShift,
            loads,
            activity: { ...overview().nightShift.activity, total: 623, listed: 2 },
          },
        }),
      })
      expect(wrapper.find('[data-testid="loads-showing-count"]').exists()).toBe(false)
    })
  })

  it('shows agents-loading while loading with no data yet', async () => {
    const { wrapper } = await mountView({ data: null, loading: true, dispatchStatus: null, nightShiftStatus: null })
    expect(wrapper.find('[data-testid="agents-loading"]').exists()).toBe(true)
  })

  it('shows agents-error when the store has an error', async () => {
    const { wrapper } = await mountView({ error: 'Unable to read the AI Agents overview right now.' })
    const error = wrapper.find('[data-testid="agents-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toBe('Unable to read the AI Agents overview right now.')
  })

  describe('polling lifecycle', () => {
    it('loads on mount and polls every 15s', async () => {
      vi.useFakeTimers()
      const { store } = await mountView()
      expect(store.load).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.load).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.load).toHaveBeenCalledTimes(3)
      vi.useRealTimers()
    })

    it('clears the poll on unmount', async () => {
      vi.useFakeTimers()
      const { wrapper, store } = await mountView()
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(store.load).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })
})
