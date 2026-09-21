import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNightShiftStore, type AgentForLoad, type AgentPolicy } from '../../stores/nightShift'
import AgentDrawer from './AgentDrawer.vue'

vi.mock('../../stores/nightShift', async () => {
  const actual = await vi.importActual<typeof import('../../stores/nightShift')>('../../stores/nightShift')
  return { ...actual, useNightShiftStore: vi.fn() }
})

const mockedUseNightShiftStore = vi.mocked(useNightShiftStore)

const standardPolicy: AgentPolicy = {
  id: 'pol-standard',
  name: 'Standard',
  stopMin: 15,
  delayMin: 30,
  darkMin: 20,
  darkAtStopMin: 60,
  offRouteMi: 3.1,
  offRouteMin: 10,
  rungGapMin: 5,
  maxCalls: 2,
  dispatcherEmail: 'dispatch@fleet.test',
  dispatcherPhone: null,
  customerEmailOn: false,
  shadow: true,
  bossCallOn: true,
  quietFrom: null,
  quietTo: null,
}

function agentState(overrides: Partial<AgentForLoad> = {}): AgentForLoad {
  return {
    enabled: true,
    policy: standardPolicy,
    pill: 'watching',
    line: null,
    timeline: [],
    ...overrides,
  }
}

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    policies: [],
    loadsByPolicy: {},
    loading: false,
    error: null,
    loadPolicies: vi.fn(),
    savePolicy: vi.fn(),
    deletePolicy: vi.fn(),
    agentFor: vi.fn().mockResolvedValue(agentState()),
    setSwitch: vi.fn(),
    timeline: vi.fn(),
    command: vi.fn().mockResolvedValue({ command: { id: 'cmd-1' } }),
    ...overrides,
  }
}

function mountDrawer(props: Partial<InstanceType<typeof AgentDrawer>['$props']> = {}) {
  return mount(AgentDrawer, {
    props: {
      loadId: 'load-1',
      loadNo: 'LD-145219',
      customerName: 'Acme Foods',
      carrierName: 'Balkan Express',
      carrierMc: 'MC-778812',
      ...props,
    },
  })
}

describe('AgentDrawer', () => {
  beforeEach(() => {
    mockedUseNightShiftStore.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when no load is open', () => {
    mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer({ loadId: null })
    expect(wrapper.find('[data-testid="agent-drawer"]').exists()).toBe(false)
  })

  it('shows the header: LOAD#, customer, carrier + MC, policy name, shadow badge', async () => {
    const store = createStoreStub({ agentFor: vi.fn().mockResolvedValue(agentState({ policy: { ...standardPolicy, shadow: true } })) })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.get('[data-testid="drawer-load-no"]').text()).toBe('LD-145219')
    expect(wrapper.get('[data-testid="drawer-customer"]').text()).toBe('Acme Foods')
    expect(wrapper.get('[data-testid="drawer-carrier"]').text()).toContain('Balkan Express')
    expect(wrapper.get('[data-testid="drawer-carrier"]').text()).toContain('MC-778812')
    expect(wrapper.get('[data-testid="drawer-policy-name"]').text()).toBe('Standard')
    expect(wrapper.get('[data-testid="drawer-shadow-badge"]').text()).toBe('Shadow')
  })

  it('shows a Live badge when the policy is not shadow', async () => {
    const store = createStoreStub({ agentFor: vi.fn().mockResolvedValue(agentState({ policy: { ...standardPolicy, shadow: false } })) })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.get('[data-testid="drawer-shadow-badge"]').text()).toBe('Live')
  })

  it('renders the timeline newest first, with call outcome + transcript verbatim and escalation reason', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({
          timeline: [
            { atMs: 300, kind: 'escalation', text: 'escalated', evidence: { reason: 'stop unresolved after 2 calls' } },
            { atMs: 200, kind: 'call', text: 'manual call', evidence: { answered: true, transcript: 'yes I am fine, tire is fixed' } },
            { atMs: 100, kind: 'status', text: 'EN ROUTE — 40 mi out' },
          ],
        }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    const entries = wrapper.findAll('[data-testid="timeline-entry"]')
    expect(entries).toHaveLength(3)
    // newest first: escalation, then call, then status
    expect(entries[0].text()).toContain('Escalated')
    expect(entries[0].get('[data-testid="escalation-reason"]').text()).toBe('stop unresolved after 2 calls')
    expect(entries[1].get('[data-testid="call-outcome"]').text()).toBe('Answered')
    expect(entries[1].get('[data-testid="call-transcript"]').text()).toBe('yes I am fine, tire is fixed')
    expect(entries[2].get('[data-testid="entry-text"]').text()).toBe('EN ROUTE — 40 mi out')
  })

  // Slice 2 (2026-09-19): the itinerary rides on the `plan` event; once a
  // `sheet_write` carries a re-timed remainder, that is what is shown.
  describe('itinerary', () => {
    const T = Date.UTC(2026, 8, 20, 12, 0)
    const planned = {
      legs: [
        { kind: 'stop', startMs: T, endMs: T + 3_600_000, at: { name: 'Kansas City, MO' }, stopType: 'pickup', assumed: true },
        { kind: 'drive', startMs: T + 3_600_000, endMs: T + 4 * 3_600_000, at: { name: 'Des Moines, IA' } },
        { kind: 'break', startMs: T + 4 * 3_600_000, endMs: T + 4.5 * 3_600_000, at: { name: "Love's Cameron" } },
        { kind: 'stop', startMs: T + 5 * 3_600_000, endMs: T + 5.5 * 3_600_000, at: { name: 'Des Moines, IA' }, stopType: 'delivery', late: true },
      ],
      etaAtMs: T + 5 * 3_600_000,
      slackMin: -40,
      hos: { feasible: false, reason: 'needs 4h drive; 1h remaining' },
      hasAssumptions: true,
    }

    it('shows the planned legs in order with the HOS verdict, late stops, assumptions and negative slack', async () => {
      const store = createStoreStub({
        agentFor: vi.fn().mockResolvedValue(agentState({ timeline: [{ atMs: 1, kind: 'plan', text: 'plan', evidence: { itinerary: planned } }] })),
      })
      mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
      const wrapper = mountDrawer()
      await flushPromises()

      const it = wrapper.get('[data-testid="itinerary"]')
      expect(it.text()).toContain('as planned')
      expect(it.findAll('[data-leg]').map((l) => l.attributes('data-leg'))).toEqual(['stop', 'drive', 'break', 'stop'])
      expect(it.get('[data-testid="itinerary-hos"]').text()).toContain('needs 4h drive')
      expect(it.get('[data-testid="itinerary-slack"]').text()).toContain('40 min LATE')
      expect(it.findAll('[data-leg="stop"]')[1].text()).toContain('after window')
      expect(it.findAll('[data-leg="stop"]')[0].text()).toContain('est.')
    })

    it('prefers the re-timed remainder from the newest sheet_write once there is one', async () => {
      const remaining = { legs: [planned.legs[3]], etaAtMs: T + 6 * 3_600_000, slackMin: 15 }
      const store = createStoreStub({
        agentFor: vi.fn().mockResolvedValue(agentState({ timeline: [
          { atMs: 2, kind: 'sheet_write', text: 'sheet_write', evidence: { cells: {}, remaining } },
          { atMs: 1, kind: 'plan', text: 'plan', evidence: { itinerary: planned } },
        ] })),
      })
      mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
      const wrapper = mountDrawer()
      await flushPromises()

      const it = wrapper.get('[data-testid="itinerary"]')
      expect(it.text()).toContain('from last fix')
      expect(it.findAll('[data-leg]')).toHaveLength(1)
      expect(it.get('[data-testid="itinerary-slack"]').text()).toContain('15 min slack')
      // The plan-time HOS verdict still shows: the clock did not get better by driving.
      expect(it.find('[data-testid="itinerary-hos"]').exists()).toBe(true)
    })

    it('renders no itinerary section for a trip with no plan yet', async () => {
      mockedUseNightShiftStore.mockReturnValue(createStoreStub() as unknown as ReturnType<typeof useNightShiftStore>)
      const wrapper = mountDrawer()
      await flushPromises()
      expect(wrapper.find('[data-testid="itinerary"]').exists()).toBe(false)
    })
  })

  it('shows "No answer" for an unanswered call, with no transcript', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({ timeline: [{ atMs: 100, kind: 'call', text: 'call rung', evidence: { answered: false, transcript: null } }] }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    const entry = wrapper.get('[data-testid="timeline-entry"]')
    expect(entry.get('[data-testid="call-outcome"]').text()).toBe('No answer')
    expect(entry.find('[data-testid="call-transcript"]').exists()).toBe(false)
  })

  it('styles a would_say line distinctly and labels it', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({ timeline: [{ atMs: 100, kind: 'would_say', text: 'would say: calling dispatch now' }] }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    const entry = wrapper.get('[data-testid="timeline-entry"]')
    expect(entry.find('[data-testid="would-say-label"]').exists()).toBe(true)
    expect(entry.classes().join(' ')).toContain('blue')
  })

  it('offers Call the driver now, Stop the agent, and I\'ve got it, and posts each as one command shown as queued', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.find('[data-testid="queued-banner"]').exists()).toBe(false)
    await wrapper.get('[data-testid="action-call"]').trigger('click')
    expect(store.command).toHaveBeenCalledWith('load-1', 'call', undefined)
    expect(store.command).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(wrapper.find('[data-testid="queued-banner"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="queued-banner"]').text()).toContain('call')
  })

  it("toggles I've got it -> Hand it back based on pill 'held'", async () => {
    const store = createStoreStub({ agentFor: vi.fn().mockResolvedValue(agentState({ pill: 'watching' })) })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.get('[data-testid="action-hold"]').text()).toBe("I've got it")
    await wrapper.get('[data-testid="action-hold"]').trigger('click')
    expect(store.command).toHaveBeenCalledWith('load-1', 'takeover', undefined)
  })

  it('shows "Hand it back" when the pill is held, and posts handback', async () => {
    const store = createStoreStub({ agentFor: vi.fn().mockResolvedValue(agentState({ pill: 'held' })) })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.get('[data-testid="action-hold"]').text()).toBe('Hand it back')
    await wrapper.get('[data-testid="action-hold"]').trigger('click')
    expect(store.command).toHaveBeenCalledWith('load-1', 'handback', undefined)
  })

  it('posts stop when Stop the agent is clicked', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    await wrapper.get('[data-testid="action-stop"]').trigger('click')
    expect(store.command).toHaveBeenCalledWith('load-1', 'stop', undefined)
  })

  it('hides Send the customer email when no draft exists', async () => {
    const store = createStoreStub({ agentFor: vi.fn().mockResolvedValue(agentState({ timeline: [] })) })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.find('[data-testid="action-send-customer-email"]').exists()).toBe(false)
  })

  it('shows Send the customer email once an escalation carries a draft, and posts send_customer_email', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({
          timeline: [{ atMs: 100, kind: 'escalation', text: 'escalated', evidence: { reason: 'delay', draftAttached: true } }],
        }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    const button = wrapper.get('[data-testid="action-send-customer-email"]')
    await button.trigger('click')
    expect(store.command).toHaveBeenCalledWith('load-1', 'send_customer_email', undefined)
  })

  it('hides Send the customer email once a later email entry shows it was sent', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({
          timeline: [
            { atMs: 200, kind: 'email', text: 'customer email sent', evidence: { to: 'customer@example.com' } },
            { atMs: 100, kind: 'escalation', text: 'escalated', evidence: { reason: 'delay', draftAttached: true } },
          ],
        }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.find('[data-testid="action-send-customer-email"]').exists()).toBe(false)
  })

  it('posts a dispatcher reply and clears the box', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    await wrapper.get('[data-testid="reply-input"]').setValue('Stay put, tow is coming')
    await wrapper.get('[data-testid="reply-form"]').trigger('submit')
    expect(store.command).toHaveBeenCalledWith('load-1', 'reply', { text: 'Stay put, tow is coming' })
    expect((wrapper.get('[data-testid="reply-input"]').element as HTMLTextAreaElement).value).toBe('')
  })

  it('offers Correct on the newest classified reply, with the situation-library keys', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({
          timeline: [
            { atMs: 200, kind: 'reply', text: 'responded', evidence: { situationKey: 'breakdown', rawText: 'my tire broken' } },
            { atMs: 100, kind: 'status', text: 'watching' },
          ],
        }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    const entries = wrapper.findAll('[data-testid="timeline-entry"]')
    expect(entries[0].find('[data-testid="action-correct"]').exists()).toBe(true)
    expect(entries[1].find('[data-testid="action-correct"]').exists()).toBe(false)

    await entries[0].get('[data-testid="action-correct"]').trigger('click')
    const options = entries[0].findAll('[data-testid="correct-key"] option').map((o) => (o.element as HTMLOptionElement).value)
    expect(options).toContain('breakdown')
    expect(options).toContain('accident')
    expect(options).toContain('all_good')

    await entries[0].get('[data-testid="correct-key"]').setValue('spill')
    await entries[0].get('[data-testid="correct-submit"]').trigger('click')
    expect(store.command).toHaveBeenCalledWith('load-1', 'correct', { correctedKey: 'spill' })
  })

  it('does not offer Correct on an unclassified reply', async () => {
    const store = createStoreStub({
      agentFor: vi.fn().mockResolvedValue(
        agentState({ timeline: [{ atMs: 100, kind: 'reply', text: 'responded', evidence: { situationKey: null, rawText: 'huh?' } }] }),
      ),
    })
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.find('[data-testid="action-correct"]').exists()).toBe(false)
  })

  it('re-fetches the timeline every 10s while open', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    mountDrawer()
    await flushPromises()
    expect(store.agentFor).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.agentFor).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.agentFor).toHaveBeenCalledTimes(3)
  })

  it('stops polling once closed (loadId becomes null)', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()
    expect(store.agentFor).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ loadId: null })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.agentFor).toHaveBeenCalledTimes(1)
  })

  it('emits close when the close button is clicked', async () => {
    const store = createStoreStub()
    mockedUseNightShiftStore.mockReturnValue(store as unknown as ReturnType<typeof useNightShiftStore>)
    const wrapper = mountDrawer()
    await flushPromises()

    await wrapper.get('[data-testid="drawer-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
