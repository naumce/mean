import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiLabStore } from '../../stores/aiLab'
import { DEFAULT_HARNESS_CONFIG, type Baseline, type RunDetail } from '../../types/aiLab'
import AiRunView from './AiRunView.vue'

vi.mock('../../stores/aiLab', () => ({ useAiLabStore: vi.fn(), MAX_BATCH_RUNS: 10 }))
const mockedUseAiLabStore = vi.mocked(useAiLabStore)

function baseline(): Baseline {
  return {
    capturedAt: '2026-09-25T00:00:00.000Z', requiredEquip: 'DryVan', note: null,
    candidates: [
      { driverId: 'd1', driverName: 'Alice', feasible: true, score: 91, deadheadMi: 12, marginCents: 40000, etaMs: 0, blockedReason: null, context: null },
      { driverId: 'd2', driverName: 'Bob', feasible: true, score: 80, deadheadMi: 30, marginCents: 30000, etaMs: 0, blockedReason: null, context: null },
    ],
    feasibleDriverIds: ['d1', 'd2'], topFeasibleDriverId: 'd1',
  }
}

function runDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 'run-1', experimentId: 'exp-1', kind: 'dispatch_candidate', loadId: 'l1', loadRef: 'L-1', scenario: null,
    status: 'proposed', terminationReason: 'proposed', driverId: 'd2', driverName: 'Bob', confidence: 0.72,
    humanVerdict: null, stats: { modelCalls: 3, toolCalls: 5, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0, promptTokens: 300, completionTokens: 60, durationMs: 8000 },
    startedAt: '2026-09-25T00:00:00.000Z', completedAt: '2026-09-25T00:00:08.000Z', parentRunId: null,
    modelConfig: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v1',
    baseline: baseline(),
    evidence: {
      toolsCalled: [{ name: 'findFeasibleDrivers', count: 1 }],
      candidatesInspected: ['d1', 'd2'],
      feasibilitySeen: [{ driverId: 'd2', feasible: true, score: 80, blockedReason: null, source: 'baseline' }],
      metricsInspected: ['d2'],
      historyInspected: ['d2'],
      factsCited: [{ text: 'closer and available sooner', forDriverId: 'd2' }],
      supportingSteps: [1, 2],
    },
    proposedDecision: { driverId: 'd2', reason: 'closer and available sooner', confidence: 0.72, alternatives: [] },
    reason: null, humanDecision: null, decidedAt: null, error: null,
    ...overrides,
  }
}

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    run: runDetail(),
    steps: [],
    driverNames: { d1: 'Alice', d2: 'Bob' },
    error: null,
    loadRun: vi.fn().mockResolvedValue(undefined),
    connectRealtime: vi.fn(),
    disconnectRealtime: vi.fn(),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue(true),
    recordVerdict: vi.fn().mockResolvedValue(true),
    replay: vi.fn().mockResolvedValue('run-2'),
    ...overrides,
  }
}

async function mountView(store: ReturnType<typeof createStoreStub>) {
  mockedUseAiLabStore.mockReturnValue(store as unknown as ReturnType<typeof useAiLabStore>)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/ai-lab/runs/:id', name: 'ai-run', component: AiRunView, props: true },
    ],
  })
  await router.push('/ai-lab/runs/run-1')
  await router.isReady()
  const wrapper = mount(AiRunView, { props: { id: 'run-1' }, global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('AiRunView', () => {
  beforeEach(() => {
    mockedUseAiLabStore.mockReset()
  })

  it('loads the run, connects realtime, and starts polling on mount', async () => {
    const store = createStoreStub()
    await mountView(store)
    expect(store.loadRun).toHaveBeenCalledWith('run-1')
    expect(store.connectRealtime).toHaveBeenCalled()
    expect(store.startPolling).toHaveBeenCalled()
  })

  it('stops polling and disconnects realtime on unmount', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)
    wrapper.unmount()
    expect(store.stopPolling).toHaveBeenCalled()
    expect(store.disconnectRealtime).toHaveBeenCalled()
  })

  it('renders the header: status, termination, duration, tokens, model config, prompt version', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)
    expect(wrapper.find('[data-testid="run-status"]').text()).toBe('Proposed')
    expect(wrapper.find('[data-testid="run-termination"]').text()).toBe('proposed')
    expect(wrapper.find('[data-testid="run-duration"]').text()).toBe('8s')
    expect(wrapper.find('[data-testid="run-tokens"]').text()).toBe('300/60 tok')
    expect(wrapper.find('[data-testid="run-model"]').text()).toContain('qwen3:8b')
    expect(wrapper.find('[data-testid="run-prompt-version"]').text()).toBe('dispatch-v1')
  })

  it('shows Cancel while running, and Run again once terminal', async () => {
    const running = createStoreStub({ run: runDetail({ status: 'running', terminationReason: null }) })
    const { wrapper: runningWrapper } = await mountView(running)
    expect(runningWrapper.find('[data-testid="run-cancel"]').exists()).toBe(true)
    expect(runningWrapper.find('[data-testid="run-replay"]').exists()).toBe(false)

    const proposed = createStoreStub()
    const { wrapper: proposedWrapper } = await mountView(proposed)
    expect(proposedWrapper.find('[data-testid="run-cancel"]').exists()).toBe(false)
    expect(proposedWrapper.find('[data-testid="run-replay"]').exists()).toBe(true)
  })

  it('Cancel calls cancelRun with the run id', async () => {
    const store = createStoreStub({ run: runDetail({ status: 'queued' }) })
    const { wrapper } = await mountView(store)
    await wrapper.find('[data-testid="run-cancel"]').trigger('click')
    expect(store.cancelRun).toHaveBeenCalledWith('run-1')
  })

  it('Run again replays and navigates to the new run', async () => {
    const store = createStoreStub()
    const { wrapper, router } = await mountView(store)
    await wrapper.find('[data-testid="run-replay"]').trigger('click')
    await flushPromises()
    expect(store.replay).toHaveBeenCalledWith('run-1')
    expect(router.currentRoute.value.params.id).toBe('run-2')
  })

  it('shows a plain error panel for a failed run', async () => {
    const store = createStoreStub({ run: runDetail({ status: 'failed', terminationReason: 'model_error', error: 'Ollama timed out', proposedDecision: null }) })
    const { wrapper } = await mountView(store)
    expect(wrapper.find('[data-testid="run-error-panel"]').text()).toBe('Ollama timed out')
  })

  it('renders the proposal card and the full evidence summary (all seven fields)', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)
    expect(wrapper.find('[data-testid="proposal-driver"]').text()).toBe('Bob')
    const evidenceText = wrapper.find('[data-testid="evidence-summary"]').text()
    expect(evidenceText).toContain('tools called (1)')
    expect(evidenceText).toContain('findFeasibleDrivers × 1')
    expect(evidenceText).toContain('candidates inspected (2)')
    expect(evidenceText).toContain('feasibility seen (1)')
    expect(evidenceText).toContain('metrics inspected (1)')
    expect(evidenceText).toContain('history inspected (1)')
    expect(evidenceText).toContain('facts cited (1)')
    expect(evidenceText).toContain('supporting steps (2)')
    // Evidence's driverNames come from the store, resolved to real names.
    expect(wrapper.find('[data-testid="fact-cited-row"]').text()).toBe('Bob: closer and available sooner')
  })

  it('clicking a supporting step is wired through without throwing (scroll-to-step is best-effort in jsdom)', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)
    const button = wrapper.find('[data-testid="supporting-step"]')
    expect(button.text()).toBe('#1')
    await expect(button.trigger('click')).resolves.not.toThrow()
  })

  describe('verdict', () => {
    it('Accept pre-fills the driver from the proposal', async () => {
      const store = createStoreStub()
      const { wrapper } = await mountView(store)
      await wrapper.find('[data-testid="verdict-accept"]').trigger('click')
      expect((wrapper.find('[data-testid="verdict-driver"]').element as HTMLSelectElement).value).toBe('d2')
    })

    it('posts the exact verdict body on submit', async () => {
      const store = createStoreStub()
      const { wrapper } = await mountView(store)
      await wrapper.find('[data-testid="verdict-accept"]').trigger('click')
      await wrapper.find('[data-testid="verdict-note"]').setValue('looks right')
      await wrapper.find('[data-testid="verdict-submit"]').trigger('click')
      await flushPromises()
      expect(store.recordVerdict).toHaveBeenCalledWith('run-1', { verdict: 'accept', driverId: 'd2', note: 'looks right' })
    })

    it('"Other" requires a driver before it can be submitted', async () => {
      const store = createStoreStub({ run: runDetail({ proposedDecision: null }) })
      const { wrapper } = await mountView(store)
      await wrapper.find('[data-testid="verdict-other"]').trigger('click')
      await wrapper.find('[data-testid="verdict-submit"]').trigger('click')
      await flushPromises()

      expect(store.recordVerdict).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('Pick a driver')

      await wrapper.find('[data-testid="verdict-driver"]').setValue('d1')
      await wrapper.find('[data-testid="verdict-submit"]').trigger('click')
      await flushPromises()

      expect(store.recordVerdict).toHaveBeenCalledWith('run-1', { verdict: 'other', driverId: 'd1', note: undefined })
    })

    it('shows the recorded verdict once the run carries one', async () => {
      const store = createStoreStub({ run: runDetail({ humanVerdict: 'accept' }) })
      const { wrapper } = await mountView(store)
      expect(wrapper.find('[data-testid="verdict-recorded"]').text()).toContain('accept')
    })
  })
})
