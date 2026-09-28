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

/** dispatch-v2 A/B experiment: the backend's own default when `promptVersion`
 *  is omitted from `POST /ai/experiments` — mirrored here so the create
 *  form's select starts on the same value the server would pick anyway. */
export const DEFAULT_PROMPT_VERSION = 'dispatch-v1'

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
  /** dispatch-v2 A/B experiment: server defaults to `DEFAULT_PROMPT_VERSION`
   *  when omitted. */
  promptVersion?: string
}

export interface UpdateExperimentBody {
  name?: string
  notes?: string
  status?: ExperimentStatus
  config?: Partial<HarnessConfig>
  /** dispatch-v2 A/B experiment: rejected 409 `{ error: "HAS_RUNS" }` once
   *  the experiment already has runs — immutable after first use, same
   *  rationale as `config` being freely editable but the prompt shape not. */
  promptVersion?: string
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
  /** The highest single call's `promptTokens` over the run — distinct from
   *  the per-run SUM above. Optional (not just nullable): a run persisted
   *  before this field existed has no key at all on the wire, not `null`. */
  maxPromptTokens?: number | null
  /** `true` once `maxPromptTokens` passed 85% of the run's own `numCtx` —
   *  Ollama drops the oldest non-system messages silently once its context
   *  fills, so this is the harness's own after-the-fact signal that a run
   *  plausibly lost history to that. Optional for the same reason as
   *  `maxPromptTokens` above; `EvaluationRow.contextPressure` below is the
   *  one place this is always a real boolean (the server backfills it). */
  contextPressure?: boolean
  /** dispatch-v2 A/B experiment: how many candidate drivers the model
   *  actually looked at (evidence-derived, same source as
   *  `Evidence.candidatesInspected.length`) — always present going forward,
   *  unlike the two optional fields above. */
  candidatesInvestigated: number
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

/** dispatch-v2 A/B experiment: one finalist's case in the model's own words —
 *  neutral by construction (strengths/weaknesses/unknowns, never a verdict
 *  like "better"/"correct"; ComparisonTable.vue must not editorialize either). */
export interface ProposalComparisonEntry {
  driverId: string
  strengths: string[]
  weaknesses: string[]
  unknowns: string[]
}

/** The run's terminal structured output (design §2's `propose_decision`
 *  contract) — `driverId: null` is a deliberate "no feasible driver" answer,
 *  not a missing field. */
export interface Proposal {
  driverId: string | null
  reason: string
  confidence: number
  alternatives: ProposalAlternative[]
  /** dispatch-v2 A/B experiment: present only for dispatch-v2 runs — absent
   *  (not an empty array) for dispatch-v1, which never produced this shape. */
  comparison?: ProposalComparisonEntry[]
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
  /** Every `propose_decision` attempt, accepted or rejected (round 2) —
   *  never folded into `toolsCalled`/`candidatesInspected`: a proposal is the
   *  model's output, not a registry tool call it made to gather evidence. */
  proposalAttempts: number
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

/** Fix round 2: `driverId`/`name` are nullable even when the row itself is
 *  non-null — a pick (or a deterministic top) can exist as a fact ("this run
 *  reached a decision") while explicitly naming no driver. Distinct from
 *  `EvaluationRow.pick`/`.deterministicTop` themselves being `null` (no
 *  decision reached at all yet). */
export interface EvaluationRowPick {
  driverId: string | null
  name: string | null
}

/** Fix round 2: `loadId`/`latencyMs`/`startedAt` are nullable — the backend
 *  contract allows a row with no known load or no completed timing yet (a
 *  fresh experiment's still-queued/still-running rows). */
export interface EvaluationRow {
  runId: string
  loadId: string | null
  loadRef: string | null
  scenario: RunScenario | null
  status: RunStatus
  terminationReason: string | null
  /** dispatch-v2 A/B experiment: which prompt version produced this run —
   *  `null` for a run persisted before the registry existed. */
  promptVersion: string | null
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
  /** dispatch-v2 A/B experiment: mirrors `RunStats.candidatesInvestigated` —
   *  nullable here (unlike the run-level field) because a still-queued row
   *  has no stats snapshot to read it from yet. */
  candidatesInvestigated: number | null
  latencyMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  /** `true` once some call in this run pushed `promptTokens` past 85% of the
   *  run's own `numCtx` — always a real boolean (the server backfills `false`
   *  for a run whose stats predate this field), never missing like
   *  `RunStats.contextPressure` can be. */
  contextPressure: boolean
  startedAt: string | null
}

/** dispatch-v2 A/B experiment: proposed-run counts bucketed by confidence —
 *  plain counts (never null; a fresh experiment's bands are all legitimately
 *  `0`, distinct from the nullable means below which mean "no runs to
 *  average"). Keys are the band labels verbatim, not a coded enum. */
export interface ConfidenceBands {
  '≥0.90': number
  '0.70–0.89': number
  '0.50–0.69': number
  '<0.50': number
}

/** dispatch-v2 A/B experiment: the most commonly proposed driver across this
 *  experiment's proposed runs, and the share of those runs that picked it —
 *  `null` when there are no proposed runs, or no driver was ever proposed
 *  more than once (no meaningful "repeat" to report). Neutral by
 *  construction: a factual tally, not a claim that the pick was right. */
export interface RepeatedPick {
  driverId: string
  name: string | null
  share: number
}

/** Fix round 2: the three means are `null` when the experiment has no
 *  proposed runs yet to average over (a fresh experiment) — never a
 *  fabricated `0`. dispatch-v2 A/B experiment: `meanCandidatesInvestigated`
 *  and `meanConfidence` follow the same null convention. */
export interface EvaluationSummary {
  runs: number
  byTermination: Record<string, number>
  proposed: number
  matchedDeterministicTop: number
  accepted: number
  rejected: number
  meanTurns: number | null
  meanToolCalls: number | null
  meanLatencyMs: number | null
  meanCandidatesInvestigated: number | null
  meanConfidence: number | null
  confidenceBands: ConfidenceBands
  repeatedPick: RepeatedPick | null
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
