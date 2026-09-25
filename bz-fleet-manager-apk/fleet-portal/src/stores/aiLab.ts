import { defineStore } from 'pinia'
import axios from 'axios'
import {
  cancelAiRun,
  createAiExperiment,
  fetchAiEvaluation,
  fetchAiExperiment,
  fetchAiExperiments,
  fetchAiRun,
  fetchAiRuns,
  fetchAiStatus,
  fetchUncoveredLoads,
  postAiVerdict,
  replayAiRun,
  startAiBatch,
  startAiRun,
  updateAiExperiment,
} from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import { isActiveRunStatus } from '../lib/aiLabFormat'
import { subscribe } from '../lib/realtime'
import {
  DEFAULT_HARNESS_CONFIG,
  type AiExperiment,
  type AiStatus,
  type CreateExperimentBody,
  type Evaluation,
  type RunDetail,
  type RunLoadInfo,
  type RunStatus,
  type RunStep,
  type RunSummary,
  type UncoveredLoad,
  type UpdateExperimentBody,
  type PostVerdictBody,
} from '../types/aiLab'

const DEFAULT_POLL_INTERVAL_MS = 2000
const STEP_REFETCH_THROTTLE_MS = 500
/** Batch runs cap (design §6: "batch of uncovered ≤ 10"). */
export const MAX_BATCH_RUNS = 10

interface AiLabState {
  status: AiStatus | null
  experiments: AiExperiment[]
  experiment: AiExperiment | null
  /** The open experiment's runs, straight off `GET /ai/experiments/:id`
   *  (RunSummary — no evaluation columns). `ExperimentRunsTable` reads
   *  `evaluation.rows` instead; this stays around for anything that only
   *  needs the plain summaries (e.g. a future run picker). */
  runs: RunSummary[]
  run: RunDetail | null
  steps: RunStep[]
  load: RunLoadInfo | null
  driverNames: Record<string, string>
  uncoveredLoads: UncoveredLoad[]
  evaluation: Evaluation | null
  loading: boolean
  error: string | null
  pollTimerId: number | null
}

/** A full-shaped, harmless "disabled" status — never `null` once probed, so
 *  every consumer can read `status.ollama`/`status.defaults` etc. without an
 *  extra layer of optional chaining beyond the single `status?.` for "have
 *  we probed at all yet." */
function disabledStatus(): AiStatus {
  return {
    enabled: false,
    ollama: { reachable: false, version: null, models: [], modelPresent: false, error: null },
    defaults: DEFAULT_HARNESS_CONFIG,
    promptVersions: [],
    queue: { running: null, queued: [] },
  }
}

function mostRecentActive(experiments: AiExperiment[]): AiExperiment | null {
  const active = experiments.filter((e) => e.status === 'active')
  if (active.length === 0) return null
  return active.reduce((latest, e) => (Date.parse(e.createdAt) > Date.parse(latest.createdAt) ? e : latest))
}

// Style A (module-scope handle array — lib/tracking.ts's/driverSupply.ts's
// own convention): the run page's own 2s poll is already the reliability
// net, so a socket drop never needs the stricter "resync from a snapshot"
// handling loadLocks.ts's Style B exists for.
let unsubscribers: Array<() => void> = []
let stepRefetchTimerId: number | null = null

export const useAiLabStore = defineStore('aiLab', {
  state: (): AiLabState => ({
    status: null,
    experiments: [],
    experiment: null,
    runs: [],
    run: null,
    steps: [],
    load: null,
    driverNames: {},
    uncoveredLoads: [],
    evaluation: null,
    loading: false,
    error: null,
    pollTimerId: null,
  }),

  actions: {
    /** A 404 means "harness disabled on this server" — expected and silent,
     *  same convention as stores/sim.ts's own probe(). Any other failure
     *  still fails closed (nothing in the UI offers a broken feature) but
     *  records why. */
    async probe(): Promise<void> {
      try {
        this.status = await fetchAiStatus()
        this.error = null
      } catch (error) {
        this.status = disabledStatus()
        if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
          this.error = extractApiErrorMessage(error, 'Unable to read the AI harness status right now.')
        }
      }
    },

    async listExperiments(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { experiments } = await fetchAiExperiments()
        this.experiments = experiments
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load experiments right now.')
      } finally {
        this.loading = false
      }
    },

    async createExperiment(body: CreateExperimentBody): Promise<AiExperiment | null> {
      this.error = null
      try {
        const { experiment } = await createAiExperiment(body)
        this.experiments = [experiment, ...this.experiments]
        return experiment
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to create this experiment right now.')
        return null
      }
    },

    async loadExperiment(id: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { experiment, runs } = await fetchAiExperiment(id)
        this.experiment = experiment
        this.runs = runs
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load this experiment right now.')
      } finally {
        this.loading = false
      }
    },

    async updateExperiment(id: string, body: UpdateExperimentBody): Promise<boolean> {
      this.error = null
      try {
        const { experiment } = await updateAiExperiment(id, body)
        if (this.experiment?.id === id) this.experiment = experiment
        this.experiments = this.experiments.map((e) => (e.id === id ? experiment : e))
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to update this experiment right now.')
        return false
      }
    },

    async loadUncoveredLoads(): Promise<void> {
      try {
        const { loads } = await fetchUncoveredLoads()
        this.uncoveredLoads = loads
      } catch (error) {
        // Auxiliary to the experiment page — a failure here must not block
        // the config card or the runs table from rendering.
        this.error = extractApiErrorMessage(error, 'Unable to load uncovered loads right now.')
      }
    },

    async startRun(experimentId: string, loadId: string): Promise<string | null> {
      this.error = null
      try {
        const { runId } = await startAiRun(experimentId, loadId)
        const { runs } = await fetchAiRuns({ experimentId })
        this.runs = runs
        return runId
      } catch (error) {
        this.error = isQueueFull(error)
          ? 'The run queue is full (max 10 pending) — try again shortly.'
          : extractApiErrorMessage(error, 'Unable to start this run right now.')
        return null
      }
    },

    async startBatch(experimentId: string, limit: number = MAX_BATCH_RUNS): Promise<string[]> {
      this.error = null
      try {
        const { runIds } = await startAiBatch(experimentId, limit)
        const { runs } = await fetchAiRuns({ experimentId })
        this.runs = runs
        return runIds
      } catch (error) {
        this.error = isQueueFull(error)
          ? 'The run queue is full (max 10 pending) — try again shortly.'
          : extractApiErrorMessage(error, 'Unable to start these runs right now.')
        return []
      }
    },

    /** Fetches the run detail and folds every part of the response
     *  (`run`/`steps`/`load`/`driverNames`) into state as one wholesale
     *  replacement — never patched field by field. */
    async applyRun(id: string): Promise<void> {
      const data = await fetchAiRun(id)
      this.run = data.run
      this.steps = data.steps
      this.load = data.load
      this.driverNames = data.driverNames
    },

    async loadRun(id: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await this.applyRun(id)
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load this run right now.')
      } finally {
        this.loading = false
      }
    },

    /** Used by both the poll timer and the realtime throttle below — a
     *  transient failure here must never blank an already-rendered run page. */
    async refreshRun(): Promise<void> {
      if (!this.run) return
      try {
        await this.applyRun(this.run.id)
      } catch {
        // silent: the next poll tick or realtime frame tries again
      }
      if (this.run && !isActiveRunStatus(this.run.status)) this.stopPolling()
    },

    /** Polls only while the OPEN run is queued/running; a no-op (and clears
     *  any previous timer) otherwise — see the store's own spec for the
     *  "starts only for queued/running, stops otherwise" contract. */
    startPolling(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
      this.stopPolling()
      if (!this.run || !isActiveRunStatus(this.run.status)) return
      this.pollTimerId = window.setInterval(() => {
        void this.refreshRun()
      }, intervalMs)
    },

    stopPolling(): void {
      if (this.pollTimerId !== null) {
        window.clearInterval(this.pollTimerId)
        this.pollTimerId = null
      }
    },

    /** `ai_run_step` frames for the open run trigger a steps refetch,
     *  coalesced to at most one per 500ms (a burst of tool-call/tool-result
     *  frames must not refetch the whole run once per frame) — same
     *  "buffer + single flush timer" idiom as driverSupply.ts's ping
     *  coalescing. `ai_run_status` patches the open run's status inline. */
    connectRealtime(): void {
      if (unsubscribers.length) return
      unsubscribers = [
        subscribe('ai_run_step', (frame) => {
          const runId = typeof frame.runId === 'string' ? frame.runId : null
          if (!runId || !this.run || runId !== this.run.id) return
          if (stepRefetchTimerId === null) {
            stepRefetchTimerId = window.setTimeout(() => {
              stepRefetchTimerId = null
              void this.refreshRun()
            }, STEP_REFETCH_THROTTLE_MS)
          }
        }),
        subscribe('ai_run_status', (frame) => {
          const runId = typeof frame.runId === 'string' ? frame.runId : null
          const status = typeof frame.status === 'string' ? (frame.status as RunStatus) : null
          if (!runId || !status || !this.run || runId !== this.run.id) return
          this.run = { ...this.run, status }
          if (!isActiveRunStatus(status)) this.stopPolling()
        }),
      ]
    },

    disconnectRealtime(): void {
      for (const off of unsubscribers) off()
      unsubscribers = []
      if (stepRefetchTimerId !== null) {
        window.clearTimeout(stepRefetchTimerId)
        stepRefetchTimerId = null
      }
    },

    async cancelRun(id: string): Promise<boolean> {
      this.error = null
      try {
        const { cancelled } = await cancelAiRun(id)
        if (this.run?.id === id) await this.refreshRun()
        return cancelled
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to cancel this run right now.')
        return false
      }
    },

    async recordVerdict(id: string, body: PostVerdictBody): Promise<boolean> {
      this.error = null
      try {
        const { run } = await postAiVerdict(id, body)
        if (this.run?.id === id) this.run = run
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to record this verdict right now.')
        return false
      }
    },

    async replay(id: string): Promise<string | null> {
      this.error = null
      try {
        const { runId } = await replayAiRun(id)
        return runId
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to start a replay right now.')
        return null
      }
    },

    async loadEvaluation(experimentId: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { evaluation } = await fetchAiEvaluation(experimentId)
        this.evaluation = evaluation
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load the evaluation right now.')
      } finally {
        this.loading = false
      }
    },

    /** The Suggest panel's "Ask Qwen" entry point: reuses the most recently
     *  created ACTIVE experiment, or creates one named "Scratch" if none
     *  exists, then enqueues a run on it and returns the new run's id.
     *  Always refetches the experiment list first — this may be the first
     *  AI Lab interaction of the session, so whatever is already in memory
     *  cannot be trusted to answer "does an active experiment exist." */
    // No outer try/catch here (fix round 1): listExperiments/createExperiment/
    // startRun each already catch their own errors and never rethrow (they
    // fail closed and return null/void), so a wrapping catch here could never
    // actually be reached.
    async askQwen(loadId: string): Promise<string | null> {
      this.error = null
      await this.listExperiments()
      const experiment = mostRecentActive(this.experiments) ?? (await this.createExperiment({ name: 'Scratch' }))
      if (!experiment) return null
      return await this.startRun(experiment.id, loadId)
    },
  },
})

function isQueueFull(error: unknown): boolean {
  return axios.isAxiosError(error) && (error.response?.data as { error?: string } | undefined)?.error === 'QUEUE_FULL'
}
