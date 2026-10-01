import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DemoView from './DemoView.vue'
import HowItWorksLinks from '../components/demo/HowItWorksLinks.vue'
import { useDemoStore } from '../stores/demo'
import type { DemoStage, DemoStageAction, DemoStory, DemoStoryResponse, PresenterStageView } from '../types/demo'

// StageCard.vue (a real, unmocked child) imports DEFAULT_REPLY_TEXT from
// this same module — vi.mock replaces the whole resolved file, so the
// factory has to keep supplying it, same literal value the store exports.
const REPLY_TEXT = 'Engine warning. Give me 15 minutes.'
vi.mock('../stores/demo', () => ({ useDemoStore: vi.fn(), DEFAULT_REPLY_TEXT: 'Engine warning. Give me 15 minutes.' }))
const mockedUseDemoStore = vi.mocked(useDemoStore)

const Stub = { template: '<div />' }

async function testRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ai-lab/runs/:id', component: Stub },
      { path: '/cockpit', component: Stub },
      { path: '/supply', component: Stub },
    ],
  })
  await router.push('/cockpit')
  await router.isReady()
  return router
}

// A mid-story fixture (spec: "rail states for a mid-story fixture") — the
// truck just broke down, four tiles already done.
const RAIL: PresenterStageView[] = [
  { id: 'uncovered', title: 'Uncovered load', narration: 'n', status: 'done' },
  { id: 'ai_recommendation', title: 'AI recommendation', narration: 'n', status: 'done' },
  { id: 'awaiting_approval', title: 'Human approval', narration: 'n', status: 'done' },
  { id: 'in_transit', title: 'In transit', narration: 'n', status: 'done' },
  { id: 'breakdown_detected', title: 'Breakdown detected', narration: 'Night Shift noticed the truck stopped.', status: 'current' },
  { id: 'driver_contacted', title: 'Driver contacted', narration: 'n', status: 'upcoming' },
  { id: 'escalated', title: 'Escalated', narration: 'n', status: 'upcoming' },
  { id: 'customer_updated', title: 'Customer update', narration: 'n', status: 'upcoming' },
  { id: 'resolved', title: 'Resolved', narration: 'n', status: 'upcoming' },
  { id: 'delivered', title: 'Delivered', narration: 'n', status: 'upcoming' },
]

function demoStory(overrides: Partial<DemoStory> = {}): DemoStory {
  return {
    orgId: 'org-1', stage: 'breakdown_detected', loadId: 'load-1', driverId: 'drv-1', assignmentId: 'asg-1',
    runId: null, experimentId: null, policyId: null, customerId: null, recommendedDriverId: 'drv-1',
    recommendationSource: 'ai', breakdownAtFraction: 0.4, breakdownTriggeredAt: null, holdStartedAt: null,
    log: [{ atMs: 1, stage: 'breakdown_detected', text: 'Truck stopped unexpectedly near Gary, IN.' }],
    error: null, startedAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:05:00.000Z',
    ...overrides,
  }
}

function demoData(storyOverrides: Partial<DemoStory> = {}): DemoStoryResponse {
  return {
    story: demoStory(storyOverrides),
    stages: RAIL,
    // breakdown_detected (the default fixture stage) has no pending human
    // action per fleet-backend's waitingOnFor — null, same as the real GET.
    waitingOn: null,
    links: { cockpitLoadId: 'load-1', aiRunId: 'run-1', driverId: 'drv-1', agentTimelineLoadId: 'load-1' },
    worker: { configured: true },
    sim: { running: true, speed: 5, simNowMs: 1000 },
    pill: null,
  }
}

function demoStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    data: demoData(),
    busy: false,
    error: null,
    autoRun: false,
    presenterStages: RAIL,
    currentPresenterStage: RAIL[4],
    actionForStage: null as DemoStageAction | null,
    isHumanStage: false,
    probe: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    toggleAutoRun: vi.fn(),
    reset: vi.fn().mockResolvedValue(true),
    askAi: vi.fn().mockResolvedValue(true),
    approve: vi.fn().mockResolvedValue(true),
    driverReply: vi.fn().mockResolvedValue(true),
    sendCustomerUpdate: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockResolvedValue(true),
    skipArrival: vi.fn().mockResolvedValue(true),
    next: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

async function mountView(storeOverrides: Record<string, unknown> = {}) {
  const store = demoStoreStub(storeOverrides)
  mockedUseDemoStore.mockReturnValue(store as unknown as ReturnType<typeof useDemoStore>)
  const router = await testRouter()
  const wrapper = mount(DemoView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, store }
}

describe('DemoView', () => {
  beforeEach(() => {
    mockedUseDemoStore.mockReset()
  })

  it('shows the unavailable message and no Reset button when the demo store is unavailable', async () => {
    const { wrapper } = await mountView({ available: false, data: null, presenterStages: [], currentPresenterStage: null })
    expect(wrapper.find('[data-testid="demo-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-reset"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stage-rail"]').exists()).toBe(false)
  })

  it('shows the driver-recommendation stage by name in the intro copy', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('A single load, walked through driver recommendation, human approval, a breakdown, and delivery')
  })

  // Task 6: the "View agent activity" deep link into the Cockpit's
  // AgentDrawer — visible once there is a Night Shift story to look at
  // (post-approval stages only), always pointing at the same `?load=` target
  // HowItWorksLinks' "Night Shift timeline" link uses.
  describe('"View agent activity" button', () => {
    const AGENT_ACTIVITY_STAGES: DemoStage[] = [
      'in_transit', 'breakdown_detected', 'driver_contacted', 'awaiting_driver_reply',
      'escalated', 'awaiting_customer_update', 'customer_updated', 'resolved', 'delivering', 'delivered',
    ]
    const HIDDEN_STAGES: DemoStage[] = ['uncovered', 'ai_recommendation', 'awaiting_approval', 'error']

    for (const stage of AGENT_ACTIVITY_STAGES) {
      it(`shows it and links to the deep link on the ${stage} stage`, async () => {
        const { wrapper } = await mountView({ data: demoData({ stage, error: stage === 'error' ? 'x' : null }) })
        const link = wrapper.find('[data-testid="demo-view-agent"]')
        expect(link.exists()).toBe(true)
        expect(link.attributes('href')).toBe('/cockpit?load=load-1')
      })
    }

    for (const stage of HIDDEN_STAGES) {
      it(`hides it on the ${stage} stage`, async () => {
        const { wrapper } = await mountView({ data: demoData({ stage, error: stage === 'error' ? 'x' : null }) })
        expect(wrapper.find('[data-testid="demo-view-agent"]').exists()).toBe(false)
      })
    }

    it('falls back to the plain /cockpit route when the demo has no agentTimelineLoadId yet', async () => {
      const { wrapper } = await mountView({
        data: { ...demoData({ stage: 'in_transit' }), links: { cockpitLoadId: null, aiRunId: null, driverId: null, agentTimelineLoadId: null } },
      })
      expect(wrapper.find('[data-testid="demo-view-agent"]').attributes('href')).toBe('/cockpit')
    })
  })

  // Render follow-up (2026-10-01): HowItWorksLinks' "AI Lab run" copy needs
  // to know whether the model or the dispatch rules made the
  // recommendation — DemoView is the one place with the story, so it must
  // pass that through rather than HowItWorksLinks guessing from aiRunId alone.
  describe('recommendationSource passed to HowItWorksLinks', () => {
    it("passes the story's recommendationSource through", async () => {
      const { wrapper } = await mountView({ data: demoData({ recommendationSource: 'engine' }) })
      const links = wrapper.findComponent(HowItWorksLinks)
      expect(links.props('recommendationSource')).toBe('engine')
    })

    it('passes null when the story has not recommended anything yet', async () => {
      const { wrapper } = await mountView({ data: demoData({ recommendationSource: null }) })
      const links = wrapper.findComponent(HowItWorksLinks)
      expect(links.props('recommendationSource')).toBeNull()
    })
  })

  it('renders the rail exactly as the store computed it for a mid-story fixture', async () => {
    const { wrapper } = await mountView()
    const items = wrapper.findAll('[data-testid="stage-rail-item"]')
    expect(items.map((i) => i.attributes('data-status'))).toEqual([
      'done', 'done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming',
    ])
  })

  describe('the action button per stage', () => {
    it('shows no button when actionForStage is null', async () => {
      const { wrapper } = await mountView({ actionForStage: null })
      expect(wrapper.find('[data-testid="stage-action-button"]').exists()).toBe(false)
    })

    it('clicking "Ask AI for a driver" calls demo.askAi()', async () => {
      const { wrapper, store } = await mountView({ actionForStage: { kind: 'ask_ai', label: 'Ask AI for a driver' } })
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
      expect(store.askAi).toHaveBeenCalledTimes(1)
    })

    it('clicking "Approve ..." calls demo.approve()', async () => {
      const { wrapper, store } = await mountView({
        actionForStage: { kind: 'approve', label: 'Approve John Carter', subline: 'Recommended by AI (confidence 0.85)' },
      })
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
      expect(store.approve).toHaveBeenCalledTimes(1)
    })

    it("prefills John's reply and sends the (possibly edited) text to demo.driverReply()", async () => {
      const { wrapper, store } = await mountView({ actionForStage: { kind: 'driver_reply', label: "Send John's reply" } })
      const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="stage-reply-text"]')
      expect(textarea.element.value).toBe(REPLY_TEXT)

      await textarea.setValue('Five more minutes.')
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')

      expect(store.driverReply).toHaveBeenCalledWith('Five more minutes.')
    })

    it('clicking "Send customer update" calls demo.sendCustomerUpdate(), never demo.resolve()', async () => {
      const { wrapper, store } = await mountView({
        actionForStage: { kind: 'customer_update_sent', label: 'Send customer update', subline: 'Demo sink — nothing leaves the system' },
      })
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
      expect(store.sendCustomerUpdate).toHaveBeenCalledTimes(1)
      expect(store.resolve).not.toHaveBeenCalled()
    })

    it('clicking "Continue" calls demo.resolve()', async () => {
      const { wrapper, store } = await mountView({ actionForStage: { kind: 'resolve', label: 'Continue' } })
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
      expect(store.resolve).toHaveBeenCalledTimes(1)
    })

    // Fix round 1, Critical #1: when the backend's waitingOn says there was
    // nothing to send (awaiting_customer_update with no draft attached),
    // actionForStage resolves to this label instead of "Send customer
    // update" — clicking it must call resolve() ONLY, never the Night Shift
    // send_customer_email command.
    it('clicking "Continue — no customer update was needed" calls demo.resolve(), never demo.sendCustomerUpdate()', async () => {
      const { wrapper, store } = await mountView({
        actionForStage: { kind: 'resolve', label: 'Continue — no customer update was needed' },
      })
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
      expect(store.resolve).toHaveBeenCalledTimes(1)
      expect(store.sendCustomerUpdate).not.toHaveBeenCalled()
    })

    it('clicking "Skip wait" calls demo.skipArrival()', async () => {
      const { wrapper, store } = await mountView({ actionForStage: { kind: 'skip_arrival', label: 'Skip wait' } })
      await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
      expect(store.skipArrival).toHaveBeenCalledTimes(1)
    })
  })

  // Fix round 1, Important #4.
  describe('the driver-channel banner', () => {
    it('stays hidden when the worker is configured (demoData()\'s default)', async () => {
      const { wrapper } = await mountView({
        data: demoData({ stage: 'awaiting_driver_reply' }),
        actionForStage: { kind: 'driver_reply', label: "Send John's reply" },
      })
      expect(wrapper.find('[data-testid="driver-channel-banner"]').exists()).toBe(false)
    })

    it('shows when demo.data.worker.configured is false', async () => {
      const { wrapper } = await mountView({
        data: { ...demoData({ stage: 'awaiting_driver_reply' }), worker: { configured: false } },
        actionForStage: { kind: 'driver_reply', label: "Send John's reply" },
      })
      expect(wrapper.find('[data-testid="driver-channel-banner"]').text()).toBe(
        'The driver channel is not connected on this server — the reply cannot be sent here.',
      )
    })
  })

  it('reflects autoRun and delegates the toggle to the store', async () => {
    const { wrapper, store } = await mountView({ autoRun: false })
    const checkbox = wrapper.find<HTMLInputElement>('[data-testid="demo-autorun-toggle"]')
    expect(checkbox.element.checked).toBe(false)
    await checkbox.setValue(true)
    expect(store.toggleAutoRun).toHaveBeenCalledTimes(1)
  })

  describe('Reset Demo', () => {
    it('asks for confirmation and calls reset() when confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { wrapper, store } = await mountView()
      await wrapper.find('[data-testid="demo-reset"]').trigger('click')
      expect(window.confirm).toHaveBeenCalled()
      expect(store.reset).toHaveBeenCalledTimes(1)
    })

    it('does nothing when the confirmation is declined', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { wrapper, store } = await mountView()
      await wrapper.find('[data-testid="demo-reset"]').trigger('click')
      expect(store.reset).not.toHaveBeenCalled()
    })

    it('stays enabled on the error stage', async () => {
      const { wrapper } = await mountView({ data: demoData({ stage: 'error', error: 'Something broke.' }) })
      expect(wrapper.find('[data-testid="demo-reset"]').attributes('disabled')).toBeUndefined()
    })
  })

  // Fix round 4, P6: the raw backend error string (a Prisma message, on a
  // database failure) must never land on the unhidden main screen — only a
  // plain sentence there, with the raw text behind a collapsed "Technical
  // details" the presenter has to choose to open.
  describe('the error banner', () => {
    it('shows a plain sentence and a reset hint only on the error stage, never the raw message in the visible summary', async () => {
      const { wrapper } = await mountView({ data: demoData({ stage: 'error', error: 'The worker timed out.' }) })
      const banner = wrapper.find('[data-testid="demo-error-banner"]')
      expect(banner.exists()).toBe(true)
      const summary = wrapper.find('[data-testid="demo-error-summary"]')
      expect(summary.text()).toBe('The demo hit a problem. Press Reset Demo to start again.')
      expect(summary.text()).not.toContain('The worker timed out.')
    })

    it('puts the raw message inside a collapsed "Technical details" element', async () => {
      const { wrapper } = await mountView({ data: demoData({ stage: 'error', error: 'The worker timed out.' }) })
      const details = wrapper.find('[data-testid="demo-error-details"]')
      expect(details.exists()).toBe(true)
      expect(details.attributes('open')).toBeUndefined() // collapsed by default
      expect(details.text()).toContain('Technical details')
      expect(details.text()).toContain('The worker timed out.')
    })

    it('does not show on a normal stage', async () => {
      const { wrapper } = await mountView()
      expect(wrapper.find('[data-testid="demo-error-banner"]').exists()).toBe(false)
    })
  })

  describe('polling lifecycle', () => {
    it('loads and starts polling on mount', async () => {
      const { store } = await mountView()
      expect(store.load).toHaveBeenCalled()
      expect(store.startPolling).toHaveBeenCalledTimes(1)
    })

    it('stops polling on unmount', async () => {
      const { wrapper, store } = await mountView()
      wrapper.unmount()
      expect(store.stopPolling).toHaveBeenCalledTimes(1)
    })
  })

  describe('presenter copy stays plain business language', () => {
    const FORBIDDEN = /\b(score|rank|ranking|engine|deterministic|scenario)\b/i

    // Fixture narration/log/labels stand in for whatever the backend sends,
    // kept deliberately clean so this only exercises the VIEW's own copy
    // (headings, button labels, sublines, the status line) — Task 1 owns the
    // wording of the narration text itself.
    const scenarios: Array<{ stage: DemoStage; action: DemoStageAction | null }> = [
      { stage: 'uncovered', action: { kind: 'ask_ai', label: 'Ask AI for a driver' } },
      { stage: 'awaiting_approval', action: { kind: 'approve', label: 'Approve John Carter', subline: 'Recommended by AI (confidence 0.85)' } },
      { stage: 'awaiting_approval', action: { kind: 'approve', label: 'Approve John Carter', subline: 'Recommended by the dispatch rules — AI unavailable' } },
      { stage: 'awaiting_driver_reply', action: { kind: 'driver_reply', label: "Send John's reply" } },
      { stage: 'awaiting_customer_update', action: { kind: 'customer_update_sent', label: 'Send customer update', subline: 'Demo sink — nothing leaves the system' } },
      { stage: 'awaiting_customer_update', action: { kind: 'resolve', label: 'Continue — no customer update was needed' } },
      { stage: 'customer_updated', action: { kind: 'resolve', label: 'Continue' } },
      { stage: 'delivering', action: { kind: 'skip_arrival', label: 'Skip wait' } },
      { stage: 'in_transit', action: null },
      { stage: 'resolved', action: null },
      { stage: 'error', action: null },
    ]

    for (const { stage, action } of scenarios) {
      it(`on the ${stage} stage${action ? ` (${action.kind})` : ''}`, async () => {
        const { wrapper } = await mountView({
          data: demoData({ stage, error: stage === 'error' ? 'A worker call failed.' : null }),
          actionForStage: action,
        })
        expect(wrapper.text()).not.toMatch(FORBIDDEN)
      })
    }

    // Fix round 1, Critical #2: a real, spec'd backend log line can
    // legitimately use a forbidden word (the engine-fallback line names
    // "deterministic") — that's fine buried in the collapsed Technical log
    // and never fine on the unhidden main screen. The scenarios above can't
    // catch this on their own: they deliberately keep fixture log text
    // clean, and the Technical log is collapsed (not rendered at all) by
    // default, so a whole-page check would pass either way. This checks the
    // one place that actually matters — the stage card itself.
    it('never puts a real backend log line on the visible card, even when that line names a forbidden word', async () => {
      const { wrapper } = await mountView({
        data: demoData({
          stage: 'awaiting_approval',
          log: [{ atMs: 1, stage: 'awaiting_approval', text: 'AI unavailable — using the deterministic recommendation: John Carter.' }],
        }),
        actionForStage: { kind: 'approve', label: 'Approve John Carter', subline: 'Recommended by the dispatch rules — AI unavailable' },
      })
      expect(wrapper.find('[data-testid="stage-card"]').text()).not.toMatch(FORBIDDEN)
      // Collapsed by default: the log line above reaches the page only once
      // "How it works" -> "Technical log" is opened, never as part of the
      // main screen.
      expect(wrapper.find('[data-testid="how-it-works-log"]').exists()).toBe(false)
    })
  })
})
