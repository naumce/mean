import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiLabStore } from '../../stores/aiLab'
import { DEFAULT_HARNESS_CONFIG, type AiExperiment, type AiStatus } from '../../types/aiLab'
import AiLabView from './AiLabView.vue'

vi.mock('../../stores/aiLab', () => ({ useAiLabStore: vi.fn(), MAX_BATCH_RUNS: 10 }))
const mockedUseAiLabStore = vi.mocked(useAiLabStore)

function statusOf(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    enabled: true,
    ollama: { reachable: true, version: '0.4.1', models: ['qwen3:8b'], modelPresent: true, error: null },
    defaults: DEFAULT_HARNESS_CONFIG,
    promptVersions: ['dispatch-v1', 'dispatch-v2'],
    queue: { running: null, queued: [] },
    ...overrides,
  }
}

function experiment(overrides: Partial<AiExperiment> = {}): AiExperiment {
  return {
    id: 'exp-1', name: 'Baseline', notes: null, status: 'active', model: 'qwen3:8b',
    promptVersion: 'dispatch-v1', config: DEFAULT_HARNESS_CONFIG, createdAt: '2026-09-20T00:00:00.000Z',
    runCount: 3, lastRunAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  }
}

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    status: null as AiStatus | null,
    experiments: [] as AiExperiment[],
    error: null,
    probe: vi.fn().mockResolvedValue(undefined),
    listExperiments: vi.fn().mockResolvedValue(undefined),
    createExperiment: vi.fn().mockResolvedValue(experiment()),
    ...overrides,
  }
}

async function mountWithRouter(store: ReturnType<typeof createStoreStub>) {
  mockedUseAiLabStore.mockReturnValue(store as unknown as ReturnType<typeof useAiLabStore>)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: AiLabView }, { path: '/ai-lab/experiments/:id', name: 'ai-experiment', component: { template: '<div/>' } }],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(AiLabView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('AiLabView', () => {
  beforeEach(() => {
    mockedUseAiLabStore.mockReset()
  })

  it('probes on mount, and only lists experiments when the harness is enabled', async () => {
    const store = createStoreStub({ status: statusOf({ enabled: false }) })
    await mountWithRouter(store)
    expect(store.probe).toHaveBeenCalled()
    expect(store.listExperiments).not.toHaveBeenCalled()
  })

  it('lists experiments once probe confirms the harness is enabled', async () => {
    const store = createStoreStub()
    store.probe = vi.fn().mockImplementation(async () => { store.status = statusOf() })
    await mountWithRouter(store)
    expect(store.listExperiments).toHaveBeenCalled()
  })

  it('renders the disabled banner without an experiments section', async () => {
    const store = createStoreStub({ status: statusOf({ enabled: false }) })
    const { wrapper } = await mountWithRouter(store)
    expect(wrapper.find('[data-testid="status-enabled"]').text()).toBe('Harness disabled')
    expect(wrapper.find('[data-testid="create-experiment-form"]').exists()).toBe(false)
  })

  it('renders the enabled banner with Ollama/model/queue facts and the experiments list', async () => {
    const store = createStoreStub({ status: statusOf(), experiments: [experiment()] })
    const { wrapper } = await mountWithRouter(store)
    expect(wrapper.find('[data-testid="status-enabled"]').text()).toBe('Harness enabled')
    expect(wrapper.find('[data-testid="status-ollama"]').text()).toContain('reachable')
    expect(wrapper.find('[data-testid="status-model"]').text()).toContain('present')
    expect(wrapper.find('[data-testid="experiment-row"]').text()).toContain('Baseline')
  })

  it('clicking an experiment row navigates to its experiment page', async () => {
    const store = createStoreStub({ status: statusOf(), experiments: [experiment({ id: 'exp-9' })] })
    const { wrapper, router } = await mountWithRouter(store)
    await wrapper.find('[data-testid="experiment-row"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('ai-experiment')
    expect(router.currentRoute.value.params.id).toBe('exp-9')
  })

  it('creating an experiment sends name/notes/config/promptVersion and clears the form on success', async () => {
    const store = createStoreStub({ status: statusOf() })
    const { wrapper } = await mountWithRouter(store)

    await wrapper.find('[data-testid="create-name"]').setValue('Scratch')
    await wrapper.find('[data-testid="create-notes"]').setValue('trying a hunch')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.createExperiment).toHaveBeenCalledWith({
      name: 'Scratch', notes: 'trying a hunch', config: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v1',
    })
    expect((wrapper.find('[data-testid="create-name"]').element as HTMLInputElement).value).toBe('')
  })

  it('defaults the prompt version select to dispatch-v1, and posts whichever version is picked', async () => {
    const store = createStoreStub({ status: statusOf() })
    const { wrapper } = await mountWithRouter(store)

    expect((wrapper.find('[data-testid="config-prompt-version"]').element as HTMLSelectElement).value).toBe('dispatch-v1')

    await wrapper.find('[data-testid="create-name"]').setValue('Scratch')
    await wrapper.find('[data-testid="config-prompt-version"]').setValue('dispatch-v2')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.createExperiment).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: 'dispatch-v2' }))
  })

  it('blocks creation and shows an error when the name is blank', async () => {
    const store = createStoreStub({ status: statusOf() })
    const { wrapper } = await mountWithRouter(store)

    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.createExperiment).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Name is required')
  })
})
