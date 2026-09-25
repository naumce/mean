import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiLabStore } from '../../stores/aiLab'
import { DEFAULT_HARNESS_CONFIG, type AiExperiment, type Evaluation } from '../../types/aiLab'
import AiExperimentView from './AiExperimentView.vue'

vi.mock('../../stores/aiLab', () => ({ useAiLabStore: vi.fn(), MAX_BATCH_RUNS: 10 }))
const mockedUseAiLabStore = vi.mocked(useAiLabStore)

function experiment(overrides: Partial<AiExperiment> = {}): AiExperiment {
  return {
    id: 'exp-1', name: 'Baseline', notes: null, status: 'active', model: 'qwen3:8b',
    promptVersion: 'dispatch-v1', config: DEFAULT_HARNESS_CONFIG, createdAt: '2026-09-20T00:00:00.000Z',
    runCount: 1, lastRunAt: null,
    ...overrides,
  }
}

function evaluation(): Evaluation {
  return {
    experimentId: 'exp-1',
    rows: [{
      runId: 'run-1', loadId: 'l1', loadRef: 'L-1', scenario: null, status: 'proposed', terminationReason: 'proposed',
      deterministicTop: null, deterministicRankOfPick: null, pick: null, confidence: null,
      humanVerdict: null, humanDriverId: null, matchesDeterministicTop: null,
      turns: 3, toolCalls: 5, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0,
      latencyMs: 4000, promptTokens: 100, completionTokens: 20, startedAt: '2026-09-25T00:00:00.000Z',
    }],
    summary: { runs: 1, byTermination: { proposed: 1 }, proposed: 1, matchedDeterministicTop: 0, accepted: 0, rejected: 0, meanTurns: 3, meanToolCalls: 5, meanLatencyMs: 4000 },
  }
}

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    experiment: experiment(),
    evaluation: evaluation(),
    uncoveredLoads: [],
    error: null,
    loadExperiment: vi.fn().mockResolvedValue(undefined),
    loadEvaluation: vi.fn().mockResolvedValue(undefined),
    loadUncoveredLoads: vi.fn().mockResolvedValue(undefined),
    updateExperiment: vi.fn().mockResolvedValue(true),
    startRun: vi.fn().mockResolvedValue('run-9'),
    startBatch: vi.fn().mockResolvedValue(['run-9', 'run-10']),
    ...overrides,
  }
}

async function mountView(store: ReturnType<typeof createStoreStub>) {
  mockedUseAiLabStore.mockReturnValue(store as unknown as ReturnType<typeof useAiLabStore>)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/ai-lab/experiments/:id', name: 'ai-experiment', component: AiExperimentView, props: true },
      { path: '/ai-lab/runs/:id', name: 'ai-run', component: { template: '<div/>' } },
    ],
  })
  await router.push('/ai-lab/experiments/exp-1')
  await router.isReady()
  const wrapper = mount(AiExperimentView, { props: { id: 'exp-1' }, global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('AiExperimentView', () => {
  beforeEach(() => {
    mockedUseAiLabStore.mockReset()
  })

  it('loads the experiment, evaluation, and uncovered loads for :id on mount', async () => {
    const store = createStoreStub()
    await mountView(store)
    expect(store.loadExperiment).toHaveBeenCalledWith('exp-1')
    expect(store.loadEvaluation).toHaveBeenCalledWith('exp-1')
    expect(store.loadUncoveredLoads).toHaveBeenCalled()
  })

  it('renders the experiment header and the evaluation summary strip', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)
    expect(wrapper.text()).toContain('Baseline')
    expect(wrapper.find('[data-testid="experiment-model"]').text()).toBe('qwen3:8b')
    expect(wrapper.find('[data-testid="evaluation-summary"]').text()).toContain('1 runs')
  })

  // Fix round 2: the wire contract has these three means nullable (null when
  // the experiment has no proposed runs yet) — must render "—", never throw
  // on `.toFixed` of null, never fabricate a 0.
  it('the evaluation summary strip shows "—" for null means on a fresh experiment', async () => {
    const store = createStoreStub({
      evaluation: {
        ...evaluation(),
        summary: { runs: 0, byTermination: {}, proposed: 0, matchedDeterministicTop: 0, accepted: 0, rejected: 0, meanTurns: null, meanToolCalls: null, meanLatencyMs: null },
      },
    })
    const { wrapper } = await mountView(store)
    const text = wrapper.find('[data-testid="evaluation-summary"]').text()
    expect(text).toContain('mean — turns')
    expect(text).toContain('mean latency —')
  })

  it('saving the config card calls updateExperiment with the id and the edited config', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(store.updateExperiment).toHaveBeenCalledWith('exp-1', { config: DEFAULT_HARNESS_CONFIG })
  })

  it('starting a run from the load picker calls startRun and refreshes the experiment + evaluation', async () => {
    const store = createStoreStub({
      uncoveredLoads: [{
        id: 'l1', externalId: 'L-1', customerName: 'Acme', scenario: null, requiredEquip: 'DryVan',
        pickupWindowStart: null, pickupWindowEnd: null, originCity: 'Dallas, TX', destCity: 'Houston, TX',
      }],
    })
    const { wrapper } = await mountView(store)

    store.loadExperiment.mockClear()
    store.loadEvaluation.mockClear()
    await wrapper.find('[data-testid="run-load-picker-start"]').trigger('click')
    await flushPromises()

    expect(store.startRun).toHaveBeenCalledWith('exp-1', 'l1')
    expect(store.loadExperiment).toHaveBeenCalledWith('exp-1')
    expect(store.loadEvaluation).toHaveBeenCalledWith('exp-1')
  })

  it('"Run all uncovered" calls startBatch with the cap and refreshes', async () => {
    const store = createStoreStub()
    const { wrapper } = await mountView(store)

    store.loadExperiment.mockClear()
    await wrapper.find('[data-testid="run-all-uncovered"]').trigger('click')
    await flushPromises()

    expect(store.startBatch).toHaveBeenCalledWith('exp-1', 10)
    expect(store.loadExperiment).toHaveBeenCalledWith('exp-1')
  })

  it('clicking a runs-table row navigates to the run page', async () => {
    const store = createStoreStub()
    const { wrapper, router } = await mountView(store)

    await wrapper.find('[data-testid="runs-table-row"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('ai-run')
    expect(router.currentRoute.value.params.id).toBe('run-1')
  })
})
