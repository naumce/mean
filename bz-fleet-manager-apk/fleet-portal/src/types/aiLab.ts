// Qwen Harness v0.1 (AI Dispatch Foundation, Task 7): wire types for the
// dispatcherAiRouter routes (Task 6, built concurrently — coded against the
// contracts in docs/superpowers/specs/2026-09-25-qwen-harness-v0.1-design.md
// §6/§8 and the Task 7 brief). Every `/ai/*` route 404s with
// `{ error: "Not found" }` when the harness is disabled (OLLAMA_URL unset);
// stores/aiLab.ts's probe() is the only place that sees and swallows that.
//
// READ-ONLY DISPATCH REASONING: nothing here writes a load, an assignment, a
// driver, or anything outside the harness's own run/verdict endpoints.

export type HarnessAdapter = 'ollama'

export interface HarnessConfig {
  adapter: HarnessAdapter
  model: string
  think: boolean
  temperature: number
  numCtx: number
  maxTurns: number
  maxToolCalls: number
  maxConsecutiveInvalid: number
  maxToolResultBytes: number
  maxRunMs: number
  modelCallTimeoutMs: number
}

/** Mirrors the harness's own defaults (design §2) — used to prefill the
 *  create form and as the fallback `defaults` before the first successful
 *  probe. */
export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  adapter: 'ollama',
  model: 'qwen3:8b',
  think: true,
  temperature: 0.2,
  numCtx: 16384,
  maxTurns: 12,
  maxToolCalls: 30,
  maxConsecutiveInvalid: 3,
  maxToolResultBytes: 65536,
  maxRunMs: 600000,
  modelCallTimeoutMs: 120000,
}

export interface HarnessConfigRange {
  min: number
  max: number
}

type RangedConfigField = Exclude<keyof HarnessConfig, 'adapter' | 'model' | 'think'>

/** ExperimentConfigCard's client-side guardrails — the same ranges the
 *  backend validates, restated here so a dispatcher gets an immediate inline
 *  error instead of a round trip to find out a value is out of range. */
export const HARNESS_CONFIG_RANGES: Record<RangedConfigField, HarnessConfigRange> = {
  temperature: { min: 0, max: 2 },
  numCtx: { min: 2048, max: 131072 },
  maxTurns: { min: 1, max: 50 },
  maxToolCalls: { min: 1, max: 200 },
  maxConsecutiveInvalid: { min: 1, max: 10 },
  maxToolResultBytes: { min: 8192, max: 1048576 },
  maxRunMs: { min: 30000, max: 3600000 },
  modelCallTimeoutMs: { min: 5000, max: 600000 },
}

export interface OllamaStatus {
  reachable: boolean
  version: string | null
  models: string[]
  modelPresent: boolean
  error: string | null
}

export interface AiQueueStatus {
  running: string | null
  queued: string[]
}

/** GET /ai/status. `enabled` is always literally `true` on the wire (the
 *  route 404s instead of ever answering `enabled: false`) — `false` is a
 *  value the STORE synthesizes locally after catching that 404, never
 *  something the server sends. See stores/aiLab.ts's `disabledStatus()`. */
export interface AiStatus {
  enabled: boolean
  ollama: OllamaStatus
  defaults: HarnessConfig
  promptVersions: string[]
  queue: AiQueueStatus
}

export type ExperimentStatus = 'active' | 'archived'

export interface AiExperiment {
  id: string
  name: string
  notes: string | null
  status: ExperimentStatus
  model: string
  promptVersion: string
  config: HarnessConfig
  createdAt: string
  runCount: number
  lastRunAt: string | null
}

export interface CreateExperimentBody {
  name: string
  notes?: string
  config?: Partial<HarnessConfig>
}

export interface UpdateExperimentBody {
  name?: string
  notes?: string
  status?: ExperimentStatus
  config?: Partial<HarnessConfig>
}

export type RunStatus = 'queued' | 'running' | 'proposed' | 'incomplete' | 'failed' | 'cancelled'
export type HumanVerdict = 'accept' | 'reject' | 'other'

/** The seeded demo scenario a load was created from (design §6) —
 *  informational only, same shape as loadboard.ts's ScenarioHint. */
export interface RunScenario {
  code: string
  title: string
  hint: string
}

export interface RunStats {
  modelCalls: number
  toolCalls: number
  uniqueTools: number
  repeatedCalls: number
  invalidCalls: number
  promptTokens: number | null
  completionTokens: number | null
  durationMs: number
}

export interface RunSummary {
  id: string
  loadId: string
  loadRef: string | null
  scenario: RunScenario | null
  status: RunStatus
  terminationReason: string | null
  driverId: string | null
  driverName: string | null
  confidence: number | null
  humanVerdict: HumanVerdict | null
  stats: RunStats | null
  startedAt: string
  completedAt: string | null
  parentRunId: string | null
}

export interface ProposalAlternative {
  driverId: string
  reason: string
}

/** The run's terminal structured output (design §2's `propose_decision`
 *  contract) — `driverId: null` is a deliberate "no feasible driver" answer,
 *  not a missing field. */
export interface Proposal {
  driverId: string | null
  reason: string
  confidence: number
  alternatives: ProposalAlternative[]
}

/** The narrow per-candidate context the baseline carries (distinct from, and
 *  smaller than, loadboard.ts's full `CandidateContext` — this is what the
 *  harness contract itself documents, not the Suggest panel's richer shape). */
export interface BaselineCandidateContext {
  availabilityStatus: string
  laneRuns: number
  onTimeRate: number | null
  responseRate: number | null
  hosKnown: boolean
}

export interface BaselineCandidate {
  driverId: string
  driverName: string
  feasible: boolean
  score: number | null
  deadheadMi: number
  marginCents: number
  etaMs: number
  blockedReason: string | null
  context: BaselineCandidateContext | null
}

/** The deterministic engine's snapshot at run start (design §2) — captured
 *  once, never shown to the model unless it calls `findFeasibleDrivers`
 *  itself. Exists purely so the UI can compare ENGINE vs QWEN vs HUMAN. */
export interface Baseline {
  capturedAt: string
  requiredEquip: string
  note: string | null
  candidates: BaselineCandidate[]
  feasibleDriverIds: string[]
  topFeasibleDriverId: string | null
}

export interface EvidenceToolCount {
  name: string
  count: number
}

export interface EvidenceFeasibilitySeen {
  driverId: string
  feasible: boolean
  score: number | null
  blockedReason: string | null
  source: string
}

export interface EvidenceFactCited {
  text: string
  forDriverId: string | null
}

/** Reconstructed from the persisted steps (design §2) — the step history is
 *  the source of truth; this is never re-derived from the model's own claims. */
export interface Evidence {
  toolsCalled: EvidenceToolCount[]
  candidatesInspected: string[]
  feasibilitySeen: EvidenceFeasibilitySeen[]
  metricsInspected: string[]
  historyInspected: string[]
  factsCited: EvidenceFactCited[]
  supportingSteps: number[]
}

export type RunStepKind = 'system' | 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'nudge'

export interface ContentPayload {
  content: string
}

export interface ThinkingPayload {
  text: string
}

export interface AssistantToolCall {
  name: string
  arguments: Record<string, unknown>
}

/** Token counts are nullable here too (not just on the run-level `RunStats`)
 *  — an adapter that does not report usage per call must not force a
 *  fabricated number onto the card. */
export interface AssistantStats {
  promptTokens: number | null
  completionTokens: number | null
  totalDurationMs: number | null
}

export interface AssistantPayload {
  content: string | null
  toolCalls: AssistantToolCall[]
  stats: AssistantStats | null
  doneReason: string | null
}

export interface ToolCallPayload {
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResultPayload {
  name: string
  ok: boolean
  truncated?: boolean
  originalSize?: number
  returnedSize?: number
  preview?: unknown
  error?: string
  errors?: string[]
}

export interface FinalPayload {
  proposal: Proposal
  ignoredCalls?: number
}

export interface ErrorPayload {
  kind: string
  message: string
}

export type StepPayload =
  | ContentPayload
  | ThinkingPayload
  | AssistantPayload
  | ToolCallPayload
  | ToolResultPayload
  | FinalPayload
  | ErrorPayload

export interface RunStep {
  seq: number
  kind: RunStepKind
  name: string | null
  payload: StepPayload
  atMs: number
  durationMs: number | null
}

export interface HumanDecision {
  verdict: HumanVerdict
  driverId: string | null
  note: string | null
  byDispatcherId: string | null
}

export interface RunDetail extends RunSummary {
  experimentId: string
  kind: string
  modelConfig: HarnessConfig | null
  promptVersion: string | null
  baseline: Baseline | null
  evidence: Evidence | null
  proposedDecision: Proposal | null
  reason: string | null
  humanDecision: HumanDecision | null
  decidedAt: string | null
  error: string | null
}

export interface RunLoadInfo {
  id: string
  externalId: string | null
  customerName: string | null
  scenario: RunScenario | null
}

export interface RunDetailResponse {
  run: RunDetail
  steps: RunStep[]
  load: RunLoadInfo | null
  driverNames: Record<string, string>
}

export interface PostVerdictBody {
  verdict: HumanVerdict
  driverId?: string
  note?: string
}

export interface FetchAiRunsParams {
  experimentId?: string
  loadId?: string
  status?: RunStatus
  limit?: number
}

export interface EvaluationRowPick {
  driverId: string
  name: string
}

export interface EvaluationRow {
  runId: string
  loadId: string
  loadRef: string | null
  scenario: RunScenario | null
  status: RunStatus
  terminationReason: string | null
  deterministicTop: EvaluationRowPick | null
  deterministicRankOfPick: number | null
  pick: EvaluationRowPick | null
  confidence: number | null
  humanVerdict: HumanVerdict | null
  humanDriverId: string | null
  matchesDeterministicTop: boolean | null
  turns: number
  toolCalls: number
  uniqueTools: number
  repeatedCalls: number
  invalidCalls: number
  latencyMs: number
  promptTokens: number | null
  completionTokens: number | null
  startedAt: string
}

export interface EvaluationSummary {
  runs: number
  byTermination: Record<string, number>
  proposed: number
  matchedDeterministicTop: number
  accepted: number
  rejected: number
  meanTurns: number
  meanToolCalls: number
  meanLatencyMs: number
}

export interface Evaluation {
  experimentId: string
  rows: EvaluationRow[]
  summary: EvaluationSummary
}

/** The load picker's row shape — `GET /dispatcher/ai/uncovered-loads`
 *  (Task 6, fix round 1): uncovered = open, no active assignment, pickup
 *  window not more than 24h past; ordered by pickup. */
export interface UncoveredLoad {
  id: string
  externalId: string | null
  customerName: string | null
  scenario: RunScenario | null
  requiredEquip: string
  pickupWindowStart: string | null
  pickupWindowEnd: string | null
  originCity: string | null
  destCity: string | null
}
