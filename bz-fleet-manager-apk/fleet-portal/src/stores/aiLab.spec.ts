import { AxiosError } from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelAiRun,
  createAiExperiment,
  fetchAiEvaluation,
  fetchAiExperiment,
  fetchAiExperiments,
  fetchAiRun,
  fetchAiStatus,
  fetchUncoveredLoads,
  postAiVerdict,
  replayAiRun,
  startAiBatch,
  startAiRun,
  updateAiExperiment,
} from '../lib/api'
import { subscribe, type Frame } from '../lib/realtime'
import { useAiLabStore } from './aiLab'
import { DEFAULT_HARNESS_CONFIG, type AiExperiment, type AiStatus, type RunDetail, type RunSummary } from '../types/aiLab'

vi.mock('../lib/api', () => ({
  fetchAiStatus: vi.fn(),
  fetchAiExperiments: vi.fn(),
  createAiExperiment: vi.fn(),
  fetchAiExperiment: vi.fn(),
  updateAiExperiment: vi.fn(),
  fetchUncoveredLoads: vi.fn(),
  startAiRun: vi.fn(),
  startAiBatch: vi.fn(),
  fetchAiRun: vi.fn(),
  cancelAiRun: vi.fn(),
  postAiVerdict: vi.fn(),
  replayAiRun: vi.fn(),
  fetchAiEvaluation: vi.fn(),
}))

vi.mock('../lib/realtime', () => ({ subscribe: vi.fn() }))

const mockedFetchStatus = vi.mocked(fetchAiStatus)
const mockedFetchExperiments = vi.mocked(fetchAiExperiments)
const mockedCreateExperiment = vi.mocked(createAiExperiment)
const mockedFetchExperiment = vi.mocked(fetchAiExperiment)
const mockedUpdateExperiment = vi.mocked(updateAiExperiment)
const mockedFetchUncoveredLoads = vi.mocked(fetchUncoveredLoads)
const mockedStartRun = vi.mocked(startAiRun)
const mockedStartBatch = vi.mocked(startAiBatch)
const mockedFetchRun = vi.mocked(fetchAiRun)
const mockedCancelRun = vi.mocked(cancelAiRun)
const mockedPostVerdict = vi.mocked(postAiVerdict)
const mockedReplay = vi.mocked(replayAiRun)
const mockedFetchEvaluation = vi.mocked(fetchAiEvaluation)
const mockedSubscribe = vi.mocked(subscribe)

function status(overrides: Partial<AiStatus> = {}): AiStatus {
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
    runCount: 0, lastRunAt: null,
    ...overrides,
  }
}

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1', loadId: 'l1', loadRef: 'L-1', scenario: null, status: 'queued', terminationReason: null,
    driverId: null, driverName: null, confidence: null, humanVerdict: null, stats: null,
    startedAt: '2026-09-25T00:00:00.000Z', completedAt: null, parentRunId: null,
    ...overrides,
  }
}

function runDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    ...runSummary(),
    experimentId: 'exp-1', kind: 'dispatch_candidate', modelConfig: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v1',
    baseline: null, evidence: null, proposedDecision: null, reason: null, humanDecision: null, decidedAt: null, error: null,
    ...overrides,
  }
}

describe('useAiLabStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const m of [
      mockedFetchStatus, mockedFetchExperiments, mockedCreateExperiment, mockedFetchExperiment, mockedUpdateExperiment,
      mockedFetchUncoveredLoads, mockedStartRun, mockedStartBatch, mockedFetchRun, mockedCancelRun,
      mockedPostVerdict, mockedReplay, mockedFetchEvaluation, mockedSubscribe,
    ]) m.mockReset()
  })

  afterEach(() => {
    useAiLabStore().disconnectRealtime()
    vi.useRealTimers()
  })

  it('starts with null status and empty collections', () => {
    const store = useAiLabStore()
    expect(store.status).toBeNull()
    expect(store.experiments).toEqual([])
    expect(store.run).toBeNull()
    expect(store.error).toBeNull()
  })

  describe('probe', () => {
    it('sets status on success', async () => {
      mockedFetchStatus.mockResolvedValueOnce(status())
      const store = useAiLabStore()
      await store.probe()
      expect(store.status?.enabled).toBe(true)
      expect(store.error).toBeNull()
    })

    it('a 404 sets status.enabled = false silently (no error)', async () => {
      mockedFetchStatus.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404, data: { error: 'Not found' } } })
      const store = useAiLabStore()
      await store.probe()
      expect(store.status?.enabled).toBe(false)
      expect(store.error).toBeNull()
    })

    it('a non-404 failure also fails closed but records an error', async () => {
      mockedFetchStatus.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })
      const store = useAiLabStore()
      await store.probe()
      expect(store.status?.enabled).toBe(false)
      expect(store.error).toBeTruthy()
    })
  })

  it('listExperiments hits GET /dispatcher/ai/experiments', async () => {
    mockedFetchExperiments.mockResolvedValueOnce({ experiments: [experiment()] })
    const store = useAiLabStore()
    await store.listExperiments()
    expect(mockedFetchExperiments).toHaveBeenCalled()
    expect(store.experiments).toHaveLength(1)
  })

  it('createExperiment posts the body and prepends the result', async () => {
    mockedCreateExperiment.mockResolvedValueOnce({ experiment: experiment({ id: 'exp-2', name: 'Scratch' }) })
    const store = useAiLabStore()
    const created = await store.createExperiment({ name: 'Scratch' })
    expect(mockedCreateExperiment).toHaveBeenCalledWith({ name: 'Scratch' })
    expect(created?.id).toBe('exp-2')
    expect(store.experiments[0]?.id).toBe('exp-2')
  })

  it('loadExperiment fetches by id and sets experiment + runs', async () => {
    mockedFetchExperiment.mockResolvedValueOnce({ experiment: experiment(), runs: [runSummary()] })
    const store = useAiLabStore()
    await store.loadExperiment('exp-1')
    expect(mockedFetchExperiment).toHaveBeenCalledWith('exp-1')
    expect(store.experiment?.id).toBe('exp-1')
    expect(store.runs).toHaveLength(1)
  })

  it('updateExperiment sends the PATCH body and replaces the open experiment + list entry', async () => {
    mockedFetchExperiment.mockResolvedValueOnce({ experiment: experiment(), runs: [] })
    const store = useAiLabStore()
    await store.loadExperiment('exp-1')
    store.experiments = [experiment()]

    mockedUpdateExperiment.mockResolvedValueOnce({ experiment: experiment({ name: 'Renamed' }) })
    const ok = await store.updateExperiment('exp-1', { name: 'Renamed' })

    expect(ok).toBe(true)
    expect(mockedUpdateExperiment).toHaveBeenCalledWith('exp-1', { name: 'Renamed' })
    expect(store.experiment?.name).toBe('Renamed')
    expect(store.experiments[0]?.name).toBe('Renamed')
  })

  it('loadUncoveredLoads hits the loads endpoint', async () => {
    mockedFetchUncoveredLoads.mockResolvedValueOnce({
      loads: [{
        id: 'l1', externalId: 'L-1', customerName: 'Acme', scenario: null, requiredEquip: 'DryVan',
        pickupWindowStart: '2026-09-25T12:00:00.000Z', pickupWindowEnd: '2026-09-25T16:00:00.000Z',
        originCity: 'Dallas, TX', destCity: 'Houston, TX',
      }],
    })
    const store = useAiLabStore()
    await store.loadUncoveredLoads()
    expect(mockedFetchUncoveredLoads).toHaveBeenCalled()
    expect(store.uncoveredLoads).toHaveLength(1)
  })

  describe('startRun / startBatch', () => {
    it('startRun posts {loadId} and returns the new runId', async () => {
      mockedStartRun.mockResolvedValueOnce({ runId: 'run-9' })
      const store = useAiLabStore()
      const runId = await store.startRun('exp-1', 'l1')
      expect(mockedStartRun).toHaveBeenCalledWith('exp-1', 'l1')
      expect(runId).toBe('run-9')
    })

    it('a 429 QUEUE_FULL becomes a friendly error, not the raw code', async () => {
      mockedStartRun.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429, data: { error: 'QUEUE_FULL' } } })
      const store = useAiLabStore()
      const runId = await store.startRun('exp-1', 'l1')
      expect(runId).toBeNull()
      expect(store.error).toMatch(/queue is full/i)
    })

    it('startBatch posts {limit} and returns the new runIds', async () => {
      mockedStartBatch.mockResolvedValueOnce({ runIds: ['run-1', 'run-2'] })
      const store = useAiLabStore()
      const runIds = await store.startBatch('exp-1', 10)
      expect(mockedStartBatch).toHaveBeenCalledWith('exp-1', 10)
      expect(runIds).toEqual(['run-1', 'run-2'])
    })
  })

  describe('loadRun', () => {
    it('fetches the run detail and folds run/steps/load/driverNames into state', async () => {
      mockedFetchRun.mockResolvedValueOnce({
        run: runDetail(), steps: [{ seq: 0, kind: 'user', name: null, payload: { content: 'hi' }, atMs: 1, durationMs: null }],
        load: { id: 'l1', externalId: null, customerName: 'Acme', scenario: null },
        driverNames: { d1: 'Alice' },
      })
      const store = useAiLabStore()
      await store.loadRun('run-1')
      expect(mockedFetchRun).toHaveBeenCalledWith('run-1')
      expect(store.run?.id).toBe('run-1')
      expect(store.steps).toHaveLength(1)
      expect(store.load?.customerName).toBe('Acme')
      expect(store.driverNames.d1).toBe('Alice')
    })
  })

  describe('cancelRun / recordVerdict / replay / loadEvaluation', () => {
    it('cancelRun posts to the cancel endpoint and refreshes the open run', async () => {
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail(), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      mockedCancelRun.mockResolvedValueOnce({ cancelled: true })
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'cancelled' }), steps: [], load: null, driverNames: {} })
      const cancelled = await store.cancelRun('run-1')

      expect(mockedCancelRun).toHaveBeenCalledWith('run-1')
      expect(cancelled).toBe(true)
      expect(store.run?.status).toBe('cancelled')
    })

    it('recordVerdict posts the exact body and replaces the open run', async () => {
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail(), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      const decided = runDetail({ humanVerdict: 'accept', humanDecision: { verdict: 'accept', driverId: 'd1', note: 'looks right', byDispatcherId: 'disp-1' } })
      mockedPostVerdict.mockResolvedValueOnce({ run: decided })

      const ok = await store.recordVerdict('run-1', { verdict: 'accept', driverId: 'd1', note: 'looks right' })

      expect(mockedPostVerdict).toHaveBeenCalledWith('run-1', { verdict: 'accept', driverId: 'd1', note: 'looks right' })
      expect(ok).toBe(true)
      expect(store.run?.humanVerdict).toBe('accept')
    })

    it('replay posts to the replay endpoint and returns the new run id', async () => {
      mockedReplay.mockResolvedValueOnce({ runId: 'run-2' })
      const store = useAiLabStore()
      const runId = await store.replay('run-1')
      expect(mockedReplay).toHaveBeenCalledWith('run-1')
      expect(runId).toBe('run-2')
    })

    it('loadEvaluation hits the evaluation endpoint', async () => {
      mockedFetchEvaluation.mockResolvedValueOnce({
        evaluation: {
          experimentId: 'exp-1', rows: [],
          summary: {
            runs: 0, byTermination: {}, proposed: 0, matchedDeterministicTop: 0, accepted: 0, rejected: 0,
            meanTurns: 0, meanToolCalls: 0, meanLatencyMs: 0,
            meanCandidatesInvestigated: 0, meanConfidence: 0,
            confidenceBands: { '≥0.90': 0, '0.70–0.89': 0, '0.50–0.69': 0, '<0.50': 0 },
            repeatedPick: null,
          },
        },
      })
      const store = useAiLabStore()
      await store.loadEvaluation('exp-1')
      expect(mockedFetchEvaluation).toHaveBeenCalledWith('exp-1')
      expect(store.evaluation?.experimentId).toBe('exp-1')
    })
  })

  describe('dispatch-v2 A/B experiment: promptVersion', () => {
    // Unlike QUEUE_FULL (special-cased into a friendly message), HAS_RUNS
    // gets no special-casing — extractApiErrorMessage's normal extraction is
    // the whole story, so this pins that a REAL AxiosError's `data.error`
    // reaches `store.error` verbatim (see lib/errors.ts; a plain
    // `{isAxiosError, response}` object, this codebase's usual mock shape,
    // does not exercise that `instanceof AxiosError` branch).
    it('a 409 HAS_RUNS surfaces verbatim as the store error, with no special-casing', async () => {
      mockedFetchExperiment.mockResolvedValueOnce({ experiment: experiment(), runs: [] })
      const store = useAiLabStore()
      await store.loadExperiment('exp-1')

      mockedUpdateExperiment.mockRejectedValueOnce(
        new AxiosError('409', '409', undefined, undefined, {
          status: 409, statusText: '', headers: {}, config: {} as never, data: { error: 'HAS_RUNS' },
        }),
      )
      const ok = await store.updateExperiment('exp-1', { promptVersion: 'dispatch-v2' })

      expect(ok).toBe(false)
      expect(store.error).toBe('HAS_RUNS')
    })
  })

  describe('polling', () => {
    it('does not start a timer when the open run is not queued/running', async () => {
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'proposed' }), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      store.startPolling(2000)
      expect(store.pollTimerId).toBeNull()
    })

    it('polls every intervalMs while queued/running, and stopPolling halts it', async () => {
      vi.useFakeTimers()
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'running' }), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      mockedFetchRun.mockResolvedValue({ run: runDetail({ status: 'running' }), steps: [], load: null, driverNames: {} })
      store.startPolling(2000)
      expect(store.pollTimerId).not.toBeNull()

      await vi.advanceTimersByTimeAsync(2000)
      expect(mockedFetchRun).toHaveBeenCalledTimes(2) // initial loadRun + one poll tick

      store.stopPolling()
      await vi.advanceTimersByTimeAsync(4000)
      expect(mockedFetchRun).toHaveBeenCalledTimes(2)
    })

    it('auto-stops once a poll tick observes a terminal status', async () => {
      vi.useFakeTimers()
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'running' }), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'proposed' }), steps: [], load: null, driverNames: {} })
      store.startPolling(2000)
      await vi.advanceTimersByTimeAsync(2000)

      expect(store.run?.status).toBe('proposed')
      expect(store.pollTimerId).toBeNull()
    })
  })

  describe('connectRealtime', () => {
    it('ai_run_step frames for the open run are throttled to one refetch per 500ms', async () => {
      vi.useFakeTimers()
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'running' }), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      const handlers = new Map<string, (frame: Frame) => void>()
      mockedSubscribe.mockImplementation((type, handler) => {
        handlers.set(type, handler)
        return vi.fn()
      })
      store.connectRealtime()
      expect(mockedSubscribe).toHaveBeenCalledWith('ai_run_step', expect.any(Function))
      expect(mockedSubscribe).toHaveBeenCalledWith('ai_run_status', expect.any(Function))

      mockedFetchRun.mockResolvedValue({ run: runDetail({ status: 'running' }), steps: [{ seq: 1, kind: 'tool_call', name: 'findFeasibleDrivers', payload: { name: 'findFeasibleDrivers', arguments: {} }, atMs: 1, durationMs: null }], load: null, driverNames: {} })

      // Three rapid frames — only ONE refetch should land, after the flush timer.
      handlers.get('ai_run_step')?.({ type: 'ai_run_step', runId: 'run-1', seq: 1 })
      handlers.get('ai_run_step')?.({ type: 'ai_run_step', runId: 'run-1', seq: 2 })
      handlers.get('ai_run_step')?.({ type: 'ai_run_step', runId: 'run-1', seq: 3 })

      expect(store.steps).toHaveLength(0) // not applied yet — still buffered

      await vi.advanceTimersByTimeAsync(500)

      expect(mockedFetchRun).toHaveBeenCalledTimes(2) // initial loadRun + exactly one coalesced refetch
      expect(store.steps).toHaveLength(1)
    })

    it('ignores an ai_run_step frame for a different run', async () => {
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'running' }), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')

      let handler: ((frame: Frame) => void) | undefined
      mockedSubscribe.mockImplementation((type, h) => {
        if (type === 'ai_run_step') handler = h
        return vi.fn()
      })
      store.connectRealtime()
      handler?.({ type: 'ai_run_step', runId: 'some-other-run', seq: 1 })

      expect(mockedFetchRun).toHaveBeenCalledTimes(1) // only the initial loadRun
    })

    it('ai_run_status patches the open run status inline (no refetch) and stops polling on a terminal status', async () => {
      vi.useFakeTimers()
      mockedFetchRun.mockResolvedValueOnce({ run: runDetail({ status: 'running' }), steps: [], load: null, driverNames: {} })
      const store = useAiLabStore()
      await store.loadRun('run-1')
      store.startPolling(2000)

      let handler: ((frame: Frame) => void) | undefined
      mockedSubscribe.mockImplementation((type, h) => {
        if (type === 'ai_run_status') handler = h
        return vi.fn()
      })
      store.connectRealtime()
      handler?.({ type: 'ai_run_status', runId: 'run-1', status: 'proposed' })

      expect(store.run?.status).toBe('proposed')
      expect(mockedFetchRun).toHaveBeenCalledTimes(1) // patched in place, no extra fetch
      expect(store.pollTimerId).toBeNull()
    })

    it('does not open a second subscription on a repeat call', () => {
      mockedSubscribe.mockReturnValue(vi.fn())
      const store = useAiLabStore()
      store.connectRealtime()
      store.connectRealtime()
      expect(mockedSubscribe).toHaveBeenCalledTimes(2) // one for each frame type, not four
    })
  })

  describe('askQwen', () => {
    it('creates a "Scratch" experiment when no active experiment exists, then starts the run', async () => {
      mockedFetchExperiments.mockResolvedValueOnce({ experiments: [experiment({ id: 'exp-old', status: 'archived' })] })
      mockedCreateExperiment.mockResolvedValueOnce({ experiment: experiment({ id: 'exp-scratch', name: 'Scratch' }) })
      mockedStartRun.mockResolvedValueOnce({ runId: 'run-42' })

      const store = useAiLabStore()
      const runId = await store.askQwen('l1')

      expect(mockedCreateExperiment).toHaveBeenCalledWith({ name: 'Scratch' })
      expect(mockedStartRun).toHaveBeenCalledWith('exp-scratch', 'l1')
      expect(runId).toBe('run-42')
    })

    it('reuses the most recently created active experiment instead of creating a new one', async () => {
      mockedFetchExperiments.mockResolvedValueOnce({
        experiments: [
          experiment({ id: 'exp-older', createdAt: '2026-09-01T00:00:00.000Z' }),
          experiment({ id: 'exp-newer', createdAt: '2026-09-20T00:00:00.000Z' }),
        ],
      })
      mockedStartRun.mockResolvedValueOnce({ runId: 'run-7' })

      const store = useAiLabStore()
      const runId = await store.askQwen('l1')

      expect(mockedCreateExperiment).not.toHaveBeenCalled()
      expect(mockedStartRun).toHaveBeenCalledWith('exp-newer', 'l1')
      expect(runId).toBe('run-7')
    })
  })
})
