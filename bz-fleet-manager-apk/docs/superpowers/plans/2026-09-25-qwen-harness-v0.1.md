# Qwen Harness v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** An observable, read-only agent loop: a local Ollama model investigates one load through the 17 dispatch tools and ends with a validated `propose_decision`; every interaction is persisted; a developer UI shows the whole run; runs are comparable against the deterministic engine and a human verdict.

**Architecture:** in-process `fleet-backend/src/lib/aiHarness/` (adapter → loop → runner) over `dispatchTools/invoke.ts`; persistence in `AiExperiment`/`AiDecisionRecord`/`AiRunStep`; routes on `dispatcherAiRouter` (404 unless `OLLAMA_URL`); portal `/ai-lab`. The engine (`domain/dispatch`), `loadWriter`, Night Shift, sheet sync, Twilio are untouched.

**Tech Stack:** Express 4 + Prisma 5 + zod (v3 for routes, `zod/v4` already used by the tool manifest) + vitest/supertest; Vue 3 + Pinia options stores; Ollama HTTP API (`POST /api/chat`, `stream:false`, `tools`, `think`); Node `fetch` + `AbortController`.

**Spec:** `docs/superpowers/specs/2026-09-25-qwen-harness-v0.1-design.md` (binding). Foundation background: `docs/ai-dispatch-foundation.md`.

## Global Constraints
- Implementers never run `git add`/`git commit`; never read or print `.env`; no subagents.
- **Untouched:** `domain/dispatch/*`, `lib/loadWriter.ts`, `lib/sheet/*`, `night-shift/`, `lib/simulation/*`, `lib/candidateContext.ts`, `lib/suggestForLoad.ts` (read-only import), the 17 tool files (except the new `invoke.ts` sibling and one additive export from `manifest.ts`).
- The harness never writes anything but `AiExperiment`, `AiDecisionRecord`, `AiRunStep`. No `applyLoadChange`, no assignment/driver/load writes, no Twilio/SMS/email, no Night Shift changes.
- No LLM SDKs; Ollama via `fetch`. The loop depends on `ModelAdapter` only. Thinking is display-only: never parsed, never influences the decision, absence must not break anything.
- `propose_decision` is the terminal structured output, not a registry tool; validated (schema + driver exists + org + in this run's feasible set); no side effects.
- The prompt never names the deterministic winner or any score; the model discovers evidence through tools.
- Tool results > 8 KB are wrapped `{ truncated: true, originalSize, returnedSize, data }` — never silently cut.
- Loop protection: `maxTurns`, `maxToolCalls`, repeated identical call detection, `maxConsecutiveInvalid`, `maxToolResultBytes`, per-call and per-run timeouts, cancel; every run persists exactly one `terminationReason`.
- Model config lives in `AiExperiment.config` (defaults `qwen3:8b`, think true, temperature 0.2, numCtx 16384, maxTurns 12, maxToolCalls 30, maxConsecutiveInvalid 3, maxToolResultBytes 65536, maxRunMs 600000, modelCallTimeoutMs 120000) and every run snapshots it into `AiDecisionRecord.modelConfig`.
- Routes: `asyncRoute`, zod bodies, org-scoped, 404 not 403, behind the `/api/dispatcher` structural gate, never on the API-key allow-list; `dispatcherAiRouter` answers 404 for everything unless `process.env.OLLAMA_URL` is set (read at request time).
- Backend checks per task: targeted vitest + `npx tsc --noEmit`; full suite (`npx vitest run`, ~10 min, baseline 176 files) once per task that touches `src/`. Portal: `npx vitest run` (baseline 114 files / 1255), `npx vue-tsc --noEmit -p tsconfig.app.json` 0 errors, `npm run build`.
- Files ≤ ~400 lines, small functions, immutable updates, "why" comments in the codebase's style, no process narration in comments, no nationality, no subjective driver fields.

## File Structure
**Backend, created:** migration `<ts>_qwen_harness_v0_1`; `src/lib/dispatchTools/invoke.ts`; `src/lib/aiHarness/{types.ts, config.ts, serialize.ts, ollamaAdapter.ts, decision.ts, baseline.ts, evidence.ts, loop.ts, runStore.ts, runner.ts, evaluation.ts, prompts/dispatch-v1.ts}`; `src/routes/dispatcherAi.ts`; `scripts/ai-eval-scenarios.mjs`; tests `tests/ai-harness-*.test.ts`, `tests/helpers/scriptedAdapter.ts`; `docs/qwen-harness-v0.1.md`.
**Backend, modified:** `prisma/schema.prisma`; `tests/helpers.ts` (resetDb); `src/lib/dispatchTools/manifest.ts` (export `TOOL_PARAMS`); `src/app.ts` (mount); `tests/dispatch-tools.test.ts` (guard covers `invoke.ts` — it already scans the directory; assert the file count).
**Portal, created:** `src/types/aiLab.ts`, `src/stores/aiLab.ts` (+spec), `src/views/ai/{AiLabView.vue, AiExperimentView.vue, AiRunView.vue}` (+specs), `src/components/ai/{RunTimeline.vue, RunStepCard.vue, JsonViewer.vue, ProposalCard.vue, ExperimentRunsTable.vue, ExperimentConfigCard.vue, RunLoadPicker.vue}`.
**Portal, modified:** `src/router/index.ts`, `src/layouts/AppShell.vue` (+spec), `src/lib/api.ts`, `src/components/cockpit/SuggestModal.vue` ("Ask Qwen").

---

### Task 1: Schema — experiment config, run status, steps
**Files:** `prisma/schema.prisma`; migration; `tests/helpers.ts`; `tests/ai-harness-schema.test.ts`.
**Produces (exact):**
```prisma
model AiExperiment { … existing …; status String @default("active") // active | archived
  promptVersion String @default("dispatch-v1"); config Json @default("{}"); createdById String? }
model AiDecisionRecord { … existing …; status String @default("queued") // queued | running | proposed | incomplete | failed | cancelled
  terminationReason String?; error String?; stats Json?; baseline Json?; evidence Json?; modelConfig Json?; promptVersion String?
  startedAt DateTime?; completedAt DateTime?; requestedById String?; parentRunId String?; steps AiRunStep[]
  @@index([orgId, status]) }
model AiRunStep { id String @id @default(uuid()); decisionId String; decision AiDecisionRecord @relation(fields: [decisionId], references: [id], onDelete: Cascade)
  seq Int; kind String // system | user | assistant | thinking | tool_call | tool_result | final | error | nudge
  name String?; payload Json; atMs BigInt; durationMs Int?
  @@unique([decisionId, seq]) @@index([decisionId]) }
```
Migration header per the Supabase convention (`CREATE EXTENSION IF NOT EXISTS pgcrypto;` + `set_config('search_path', … ',public,extensions')`), additive only. `resetDb`: `aiRunStep` before `aiDecisionRecord`.
- [ ] Failing test: a step cascades with its record; `(decisionId, seq)` unique; defaults (`status "queued"`, `config {}`); an experiment's `config` round-trips JSON. Migrate dev DB; implement; green; full suite; night-shift typecheck.

### Task 2: Tool invoke registry + result serializer
**Files:** `src/lib/dispatchTools/manifest.ts` (export `TOOL_PARAMS`), create `src/lib/dispatchTools/invoke.ts`, `src/lib/aiHarness/serialize.ts`, tests `tests/ai-harness-invoke.test.ts`, `tests/ai-harness-serialize.test.ts`; `tests/dispatch-tools.test.ts` (guard file count +1).
**Produces:**
```ts
// invoke.ts
export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string; code: "unknown_tool" | "invalid_params" | "tool_error" };
export async function invokeTool(orgId: string, name: string, params: unknown): Promise<InvokeResult>;
export function toolDefinitionsForModel(): { name: string; description: string; parameters: Record<string, unknown> }[];  // from toolManifestJson()
// Mapping (params validated with TOOL_PARAMS[name] first): getLoad(orgId,p.loadId) · searchLoads(orgId,p) · getUncoveredLoads(orgId) · getDriver(orgId,p.driverId) · searchDrivers(orgId,p) · getAvailableDrivers(orgId) · getDriverAvailability(orgId,p.driverId) · getDriverMetrics(orgId,p.driverId) · getDriverHistory(orgId,p.driverId,p.limit) · getDriverLocationHistory(orgId,p.driverId,p.sinceMs) · getCustomer(orgId,p.customerId) · getCustomerHistory(orgId,p.customerId) · getCurrentETA(orgId,p.loadId) · getLoadEvents(orgId,p.loadId) · getAgentEvents(orgId,p.loadId) · findFeasibleDrivers(orgId,p.loadId) · getDispatchCandidateDetails(orgId,p.loadId,p.driverId)
// serialize.ts
export const TOOL_RESULT_MAX_BYTES = 8192;
export interface SerializedToolResult { content: string; truncated: boolean; originalSize: number; returnedSize: number }
export function serializeToolResult(value: unknown, maxBytes = TOOL_RESULT_MAX_BYTES): SerializedToolResult;   // BigInt→number, Date→ISO, undefined→null; over cap → content = JSON.stringify({ truncated: true, originalSize, returnedSize, data: prefix })
export function canonicalArgs(args: unknown): string;  // stable key order, for repeated-call detection
```
- [ ] Failing tests: every one of the 17 names invokes the right function with the right positional args (spy on the module exports via `vi.mock` of the sibling files) and cross-org ids yield `{ ok: true, value: null }`; unknown tool / invalid params codes; a thrown tool error → `tool_error` with a short message; serializer BigInt/Date/undefined; truncation wrapper exact shape and byte counts; `canonicalArgs` order-independence.

### Task 3: Model adapter — interface, Ollama, scripted
**Files:** create `src/lib/aiHarness/types.ts`, `config.ts`, `ollamaAdapter.ts`, `tests/helpers/scriptedAdapter.ts`, `tests/ai-harness-ollama-adapter.test.ts`.
**Produces:**
```ts
// types.ts
export type Role = "system" | "user" | "assistant" | "tool";
export interface ToolCall { name: string; arguments: Record<string, unknown> }
export interface ChatMessage { role: Role; content: string; thinking?: string; toolCalls?: ToolCall[]; toolName?: string }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatRequest { model: string; messages: ChatMessage[]; tools: ToolDefinition[]; think: boolean; temperature: number; numCtx: number; keepAlive: string }
export interface ChatStats { promptTokens: number | null; completionTokens: number | null; totalDurationMs: number | null }
export interface ChatResponse { message: ChatMessage; doneReason: string | null; stats: ChatStats; raw?: unknown }
export interface ModelAdapter { readonly name: string; chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> }
export class ModelError extends Error { constructor(message: string, readonly kind: "http" | "network" | "malformed" | "aborted") }
// config.ts
export interface HarnessConfig { adapter: "ollama"; model: string; think: boolean; temperature: number; numCtx: number; maxTurns: number; maxToolCalls: number; maxConsecutiveInvalid: number; maxToolResultBytes: number; maxRunMs: number; modelCallTimeoutMs: number }
export const DEFAULT_HARNESS_CONFIG: HarnessConfig = { adapter: "ollama", model: "qwen3:8b", think: true, temperature: 0.2, numCtx: 16384, maxTurns: 12, maxToolCalls: 30, maxConsecutiveInvalid: 3, maxToolResultBytes: 65536, maxRunMs: 600_000, modelCallTimeoutMs: 120_000 };
export const harnessConfigSchema: z.ZodType<Partial<HarnessConfig>>;   // zod v3, ranges: temperature 0..2, numCtx 2048..131072, maxTurns 1..50, maxToolCalls 1..200, maxConsecutiveInvalid 1..10, maxToolResultBytes 8192..1048576, maxRunMs 30000..3600000, modelCallTimeoutMs 5000..600000, model non-empty ≤ 80
export function resolveHarnessConfig(partial: unknown): HarnessConfig;   // defaults ← validated partial
export function harnessEnabled(): boolean;   // Boolean(process.env.OLLAMA_URL), read at call time
export function ollamaBaseUrl(): string;
// ollamaAdapter.ts
export function createOllamaAdapter(baseUrl: string, fetchImpl: typeof fetch = fetch): ModelAdapter;   // POST {baseUrl}/api/chat body { model, messages: [{role, content, thinking?, tool_calls?: [{function:{name, arguments}}], tool_name?}], tools: [{type:"function", function:{name, description, parameters}}], think, stream:false, options:{temperature, num_ctx}, keep_alive } → parses message.content/thinking/tool_calls (arguments given as a string are JSON.parsed; unparsable → the call is kept with arguments {__raw: string} so the loop can reject it as invalid), stats from prompt_eval_count / eval_count / total_duration (ns→ms); non-2xx → ModelError("http"), fetch failure → "network", bad JSON/shape → "malformed", AbortSignal → "aborted"
export async function checkOllama(baseUrl: string, model: string, fetchImpl = fetch): Promise<{ reachable: boolean; version: string | null; models: string[]; modelPresent: boolean; error: string | null }>;   // GET /api/version + /api/tags, 3 s timeout
// tests/helpers/scriptedAdapter.ts
export function scriptedAdapter(script: (ChatResponse | Error | ((req: ChatRequest) => ChatResponse | Error))[]): ModelAdapter & { requests: ChatRequest[] };
```
- [ ] Failing tests with a fake `fetch`: request body shape exactly as above (incl. tool messages carrying `tool_name`, assistant history carrying `tool_calls`), thinking captured, string arguments parsed, unparsable arguments → `__raw`, stats conversion, each ModelError kind, abort; `checkOllama` reachable/unreachable/model-missing; `resolveHarnessConfig` defaults + rejections.

### Task 4: Terminal contract, baseline, prompt
**Files:** create `src/lib/aiHarness/decision.ts`, `baseline.ts`, `prompts/dispatch-v1.ts`, tests `tests/ai-harness-decision.test.ts`, `tests/ai-harness-baseline.test.ts`.
**Produces:**
```ts
// decision.ts
export const PROPOSE_DECISION_NAME = "propose_decision";
export const PROPOSE_DECISION_DEFINITION: ToolDefinition;   // parameters: driverId string|null, reason string, confidence number 0..1, alternatives array(max 3) of {driverId, reason}; required: driverId, reason, confidence, alternatives
export interface Proposal { driverId: string | null; reason: string; confidence: number; alternatives: { driverId: string; reason: string }[] }
export const proposalSchema: z.ZodType<Proposal>;   // reason 20..2000 chars, confidence 0..1, alternatives ≤ 3, alternative reason 5..500
export interface ProposalCheck { ok: true; proposal: Proposal } | { ok: false; errors: string[] }
export async function validateProposal(raw: unknown, ctx: { orgId: string; feasibleDriverIds: ReadonlySet<string> }): Promise<ProposalCheck>;   // schema → all ids (driverId + alternatives) exist in the org (one findMany) → each ∈ feasibleDriverIds; driverId null allowed; duplicate alternative ids rejected; errors are short sentences meant for the model
// baseline.ts
export interface BaselineCandidate { driverId: string; driverName: string | null; feasible: boolean; score: number | null; deadheadMi: number; marginCents: number; etaMs: number; blockedReason: string | null; context: { availabilityStatus: string | null; laneRuns: number | null; onTimeRate: number | null; responseRate: number | null; hosKnown: boolean | null } | null }
export interface Baseline { capturedAt: string; requiredEquip: string | null; note: string | null; candidates: BaselineCandidate[]; feasibleDriverIds: string[]; topFeasibleDriverId: string | null }
export async function captureBaseline(orgId: string, loadId: string): Promise<Baseline | null>;   // suggestForLoad(orgId, loadId); candidates in the engine's order; null when the load is missing/other-org
export function feasibleIdsFromToolResult(value: unknown): string[];   // from a findFeasibleDrivers result: rows with feasible === true
// prompts/dispatch-v1.ts
export const DISPATCH_PROMPT_V1 = { version: "dispatch-v1", system: string, user: (args: { loadId: string; loadRef: string | null }) => string, nudge: string } as const;
```
`system` says: you are a dispatch analyst for a trucking operation; the task is to investigate ONE load and recommend the most appropriate feasible driver; gather evidence with the tools (they are the only source of facts); only recommend a driver who appears feasible in `findFeasibleDrivers`; cite facts you actually retrieved; call `propose_decision` exactly once when done, with a reason that names the evidence; never invent ids; prefer fewer, well-chosen calls; if no driver is appropriate, propose `driverId: null` and say why. It does NOT mention scores, rankings, the deterministic winner, or seeded scenarios. `user` = "Investigate load {loadRef} (id {loadId}) and recommend the most appropriate feasible driver." `nudge` = "You have not proposed a decision. Finish by calling propose_decision with your recommendation, or with driverId null if none is appropriate."
- [ ] Failing tests: schema edge cases; existence/org/feasible-set rejections with model-readable messages; null driver accepted; baseline fields on a fixture with one feasible and one blocked driver (order preserved, `topFeasibleDriverId`); `feasibleIdsFromToolResult` on a real `findFeasibleDrivers` result; the prompt contains none of the strings "score", "rank", "deterministic", "scenario", "expected" (a literal test).

### Task 5: The loop — persistence, protection, evidence, stats
**Files:** create `src/lib/aiHarness/runStore.ts`, `evidence.ts`, `loop.ts`; tests `tests/ai-harness-loop.test.ts` (split `-loop-protection.test.ts` if > 500 lines), `tests/ai-harness-evidence.test.ts`.
**Produces:**
```ts
// runStore.ts (the only writer of Ai* rows besides routes/runner)
export interface RunStore { appendStep(decisionId: string, step: { kind: StepKind; name?: string | null; payload: unknown; atMs: number; durationMs?: number | null }): Promise<number /*seq*/>; updateRun(decisionId: string, data: Partial<{ status: RunStatus; startedAt: Date; completedAt: Date; terminationReason: TerminationReason; error: string | null; stats: RunStats; baseline: Baseline | null; evidence: Evidence | null; proposedDecision: Proposal | null; reason: string | null; confidence: number | null; driverId: string | null; modelConfig: HarnessConfig; promptVersion: string }>): Promise<void>; listSteps(decisionId: string): Promise<StoredStep[]> }
export const prismaRunStore: RunStore;   // seq = count+1 inside a transaction-free upsert loop (unique index guards races); emits nothing
export type StepKind = "system" | "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "final" | "error" | "nudge";
// evidence.ts
export interface Evidence { toolsCalled: { name: string; count: number }[]; candidatesInspected: string[]; feasibilitySeen: { driverId: string; feasible: boolean; score: number | null; blockedReason: string | null; source: "baseline" | "tool" }[]; metricsInspected: string[]; historyInspected: string[]; factsCited: { text: string; forDriverId: string | null }[]; supportingSteps: number[] }
export function collectEvidence(steps: StoredStep[], proposal: Proposal, baseline: Baseline | null): Evidence;   // pure; candidatesInspected = driverIds in tool_call args ∪ feasibility rows seen; metrics/history from getDriverMetrics/getDriverHistory calls; factsCited = proposal.reason (forDriverId = proposal.driverId) + alternatives' reasons; supportingSteps = seqs of tool_result steps whose content contains the proposed driverId
// loop.ts
export type TerminationReason = "proposed" | "no_decision" | "max_turns" | "max_tool_calls" | "repeated_calls" | "consecutive_invalid" | "tool_bytes_exceeded" | "timeout" | "model_error" | "cancelled";
export type RunStatus = "queued" | "running" | "proposed" | "incomplete" | "failed" | "cancelled";
export interface RunStats { modelCalls: number; toolCalls: number; uniqueTools: number; repeatedCalls: number; invalidCalls: number; promptTokens: number | null; completionTokens: number | null; durationMs: number }
export interface RunInput { orgId: string; decisionId: string; loadId: string; loadRef: string | null; config: HarnessConfig; adapter: ModelAdapter; store: RunStore; invoke?: typeof invokeTool; now?: () => number; signal?: AbortSignal; onStep?: (seq: number, kind: StepKind) => void; onStatus?: (status: RunStatus) => void }
export interface RunOutcome { status: RunStatus; terminationReason: TerminationReason; proposal: Proposal | null; stats: RunStats }
export async function runDispatchDecision(input: RunInput): Promise<RunOutcome>;
```
Algorithm (binding): `updateRun(status running, startedAt, modelConfig, promptVersion)` → `captureBaseline` (persist; feasible set seeded from it; a null baseline is persisted as null and the run continues) → steps `system` and `user` → for turn = 1..maxTurns: race `adapter.chat` against the call timeout and the run deadline and the cancel signal → persist `thinking` (if any, payload `{ text }`) then `assistant` (payload `{ content, toolCalls, stats, doneReason }`) → if no tool calls: first time persist `nudge` + push the nudge user message and continue; second time terminate `no_decision` → for each tool call in order: `propose_decision` → `validateProposal(args, { orgId, feasibleSet })` → ok: persist `final` `{ proposal }`, terminate `proposed` (later calls in the same message ignored, noted in the final payload); not ok: persist `tool_result` `{ ok: false, errors }` as a tool message, invalid++ / consecutiveInvalid++; other name → if `canonicalArgs` seen before for that name: tool message `{ ok: false, error: "identical call already made; reuse the earlier result (step N)" }`, repeated++/invalid++; else `invokeTool` → not ok: tool message with the error, invalid++; ok: `serializeToolResult` → persist `tool_call` `{ name, arguments }` and `tool_result` `{ name, truncated, originalSize, returnedSize, preview: first 512 chars }` with `durationMs` → tool message content; toolCalls++, bytes += returnedSize; if name === findFeasibleDrivers add `feasibleIdsFromToolResult` to the set; valid call resets consecutiveInvalid → after each call check caps in this order: maxToolCalls → `max_tool_calls`, bytes → `tool_bytes_exceeded`, consecutiveInvalid → `consecutive_invalid`, and if repeated ≥ 3 → `repeated_calls` → loop end → `max_turns`. Errors: `ModelError` → `error` step `{ kind, message }`, terminate `model_error` (or `timeout` for aborted-by-deadline, `cancelled` for the signal). Finally: stats, evidence (only when proposed), `updateRun({ status: proposed|incomplete|failed|cancelled, terminationReason, completedAt, stats, evidence, proposedDecision, reason, confidence, driverId })`; `incomplete` = every non-proposed termination except `model_error`/`timeout` (failed) and `cancelled`. `onStep`/`onStatus` are called after each persist.
- [ ] Failing tests with `scriptedAdapter` and an in-memory `RunStore` (plus one test on `prismaRunStore`): happy path (two tool calls then a valid proposal → steps in order with seqs 1..n, statuses, stats, evidence populated, feasible set includes tool-returned rows); invalid proposal then corrected; unknown tool; invalid params; repeated call thrice → `repeated_calls`; consecutive invalid ×3; max tool calls; bytes cap with a big fixture; max turns; nudge then no decision; model error; per-call timeout; run deadline; cancel; thinking present vs absent identical decision path; `incomplete` vs `failed` mapping table.

### Task 6: Runner, realtime, routes, evaluation
**Files:** create `src/lib/aiHarness/runner.ts`, `evaluation.ts`, `src/routes/dispatcherAi.ts`; modify `src/app.ts`; tests `tests/ai-harness-runner.test.ts`, `tests/dispatcher-ai.test.ts`, `tests/ai-harness-evaluation.test.ts`; `tests/dispatcher-mount-order.test.ts` green.
**Produces:**
```ts
// runner.ts
export const MAX_QUEUED_PER_ORG = 10;
export async function enqueueRun(args: { orgId: string; experimentId: string; loadId: string; requestedById: string | null; parentRunId?: string | null }): Promise<{ runId: string } | { error: "QUEUE_FULL" | "EXPERIMENT_NOT_FOUND" | "LOAD_NOT_FOUND" | "HARNESS_DISABLED" }>;   // creates AiDecisionRecord { kind: "dispatch_candidate", status queued, context: { loadRef, requestedAt }, toolCalls: [], toolResults: [] }, then schedules drain(orgId)
export function cancelRun(orgId: string, runId: string): Promise<boolean>;
export function runnerState(orgId: string): { running: string | null; queued: string[] };
export function setAdapterFactory(f: (config: HarnessConfig) => ModelAdapter): void;   // tests inject the scripted adapter; default = createOllamaAdapter(ollamaBaseUrl())
// drain: one run at a time per org (Map<orgId, Promise>), each run: load experiment → resolveHarnessConfig(experiment.config) → runDispatchDecision with prismaRunStore, onStep → emitToDispatchers(orgId, "ai_run_step", { runId, seq, kind }), onStatus → emitToDispatchers(orgId, "ai_run_status", { runId, status }); a thrown error marks the run failed and the drain continues; nothing survives a process restart (queued rows stay "queued" — GET /ai/runs shows them; documented)
// evaluation.ts
export interface EvaluationRow { runId: string; loadId: string | null; loadRef: string | null; scenario: { code: string; title: string; hint: string } | null; status: RunStatus; terminationReason: string | null; deterministicTop: { driverId: string; name: string | null } | null; deterministicRankOfPick: number | null; pick: { driverId: string | null; name: string | null } | null; confidence: number | null; humanVerdict: string | null; humanDriverId: string | null; matchesDeterministicTop: boolean | null; turns: number; toolCalls: number; uniqueTools: number; repeatedCalls: number; invalidCalls: number; latencyMs: number | null; promptTokens: number | null; completionTokens: number | null; startedAt: string | null }
export interface Evaluation { experimentId: string; rows: EvaluationRow[]; summary: { runs: number; byTermination: Record<string, number>; proposed: number; matchedDeterministicTop: number; accepted: number; rejected: number; meanTurns: number | null; meanToolCalls: number | null; meanLatencyMs: number | null } }
export async function evaluateExperiment(orgId: string, experimentId: string): Promise<Evaluation | null>;
```
Routes (all under `/api/dispatcher`, on `dispatcherAiRouter`; `router.use("/ai", …)` 404 `{ error: "Not found" }` unless `harnessEnabled()`): `GET /ai/status` → `{ enabled: true, ollama: checkOllama(...), defaults: DEFAULT_HARNESS_CONFIG, promptVersions: ["dispatch-v1"], queue: runnerState }`; `GET /ai/experiments` (name, status, model, config, promptVersion, runCount, lastRunAt); `POST /ai/experiments { name 1..80, notes? ≤ 2000, config? }` → 201; `GET /ai/experiments/:id` (+ `runs` summaries newest first, ≤ 100); `PATCH /ai/experiments/:id { name?, notes?, status?, config? }`; `POST /ai/experiments/:id/runs { loadId }` → 202 `{ runId }` / 429 `QUEUE_FULL`; `POST /ai/experiments/:id/runs/batch { limit 1..10 }` → uncovered loads via `getUncoveredLoads` → 202 `{ runIds }`; `GET /ai/runs?experimentId&loadId&status&limit≤100`; `GET /ai/runs/:id` → `{ run, steps, load: { id, externalId, customerName, scenario }, driverNames: Record<id, name> }`; `POST /ai/runs/:id/cancel` → `{ cancelled }`; `POST /ai/runs/:id/decision { verdict: accept|reject|other, driverId?, note? ≤ 1000 }` (other requires a driverId in the org) → sets `humanDecision { verdict, driverId, note, byDispatcherId }`, `decidedAt`; `POST /ai/runs/:id/replay` → `enqueueRun({ …, parentRunId })` → 202; `GET /ai/experiments/:id/evaluation`. Mounted after the structural gate; not on the API-key allow-list.
- [ ] Failing tests: queue order and one-at-a-time per org (scripted adapter with a deferred response), `QUEUE_FULL` at 11, cancel queued and running, WS emits (spy on `src/realtime.js`) per step/status, a thrown adapter error → failed + drain continues; routes: 404 without `OLLAMA_URL`, each route's happy path + zod 400s + cross-org 404 + verdict rules + replay lineage; evaluation rows/summary on a fixture with three finished runs (proposed matching top, proposed not matching, incomplete) and the seeded scenario reference when `extras.scenario` exists.

### Task 7: Portal — AI Lab
**Files:** `src/types/aiLab.ts`; `src/lib/api.ts` (typed functions for every Task 6 route); `src/stores/aiLab.ts` (+spec); `src/views/ai/AiLabView.vue`, `AiExperimentView.vue`, `AiRunView.vue` (+specs); `src/components/ai/RunTimeline.vue`, `RunStepCard.vue`, `JsonViewer.vue`, `ProposalCard.vue`, `ExperimentRunsTable.vue`, `ExperimentConfigCard.vue`, `RunLoadPicker.vue` (+specs for timeline, step card, proposal card, runs table); `src/router/index.ts` (`/ai-lab`, `/ai-lab/experiments/:id`, `/ai-lab/runs/:id`); `src/layouts/AppShell.vue` (`{ label: 'AI Lab (dev)', to: '/ai-lab' }` in `TOWER_MORE`; spec); `src/components/cockpit/SuggestModal.vue` ("Ask Qwen" button → `askQwen(loadId)` in the store: most recent active experiment or create "Scratch" → enqueue → `router.push` to the run).
**Produces:** store state `{ status, experiments, experiment, runs, run, steps, evaluation, loading, error, pollTimerId }`, actions `probe()` (404 → `status.enabled=false`, silent), `listExperiments`, `createExperiment`, `loadExperiment`, `updateExperiment`, `startRun(experimentId, loadId)`, `startBatch`, `loadRun(id)`, `cancelRun`, `recordVerdict`, `replay`, `loadEvaluation`, `connectRealtime()` (`ai_run_step` → refetch steps for the open run, throttled 500 ms; `ai_run_status` → patch status), `startPolling(2000)` while the open run is queued/running, `askQwen(loadId)`. Run page renders the step list as the labelled chain USER REQUEST → MODEL → TOOL REQUEST → TOOL ARGUMENTS → TOOL RESULT → MODEL → … → FINAL PROPOSAL (thinking as a collapsed grey block; tool arguments and results in `JsonViewer` with a "truncated N → M bytes" badge; each card shows the wall time and durationMs; error/nudge cards distinct), header with status/termination/duration/tokens/config snapshot, `ProposalCard` next to the baseline top candidate (name, score, deadhead, rank of the pick), verdict controls, "Run again". Experiment page: `ExperimentConfigCard` (editable fields per `harnessConfigSchema` ranges), `RunLoadPicker` (uncovered loads with `extras.scenario` code/title), "Run all uncovered (10)", `ExperimentRunsTable` with the evaluation columns and a summary strip. Lab page: status banner (enabled / Ollama reachable / model present / version) and experiments. It looks like a developer console, not a product screen (monospace stats, raw JSON, no marketing copy).
- [ ] Failing specs: store actions call the right endpoints; 404 probe silent; realtime throttle; timeline renders the chain labels in order for a fixture run incl. a truncated result badge and an error card; proposal card shows rank; verdict posts the body; runs table columns; router/nav (tower only); "Ask Qwen" enqueues and navigates. Checks: portal vitest, vue-tsc, build.

### Task 8: Live smoke, scenario script, documentation
**Files:** `tests/ai-harness-live.test.ts` (skipped unless `OLLAMA_URL` and `AI_LIVE_TEST=1`), `scripts/ai-eval-scenarios.mjs`, `docs/qwen-harness-v0.1.md`; a README note in `fleet-backend/.env.example` (`OLLAMA_URL=`).
**Produces:** the live test runs one real `runDispatchDecision` against the seeded world's `W-A-RELIABLE` load with the default config and asserts only structural facts (≥ 1 tool call, a terminal status, steps persisted, stats populated). `scripts/ai-eval-scenarios.mjs`: logs in as `w@fleet.com` against `BASE_URL` (default `http://localhost:3001`), creates (or reuses) the experiment "Scenarios A–H · dispatch-v1 · <model>", enqueues the eight scenario loads by `externalId` (`W-A-RELIABLE` … `W-H-PRIORITY`), waits for completion (polling `GET /ai/runs/:id`), prints the evaluation table (one row per run: scenario, deterministic top, pick, confidence, rank of pick, turns, tool calls, unique/repeated/invalid, latency, tokens, termination) and writes it to `docs/evaluations/<date>-scenarios-a-h.md`. The doc covers: architecture, model adapter, agent loop, tool registry, terminal decision contract, persistence, experiment lifecycle, safety boundaries, evaluation methodology (explicitly: matching the deterministic top or the seeded expectation is reference data, not correctness), running Ollama locally (`ollama pull qwen3:8b`, `OLLAMA_URL=http://127.0.0.1:11434`), running scenarios A–H, known limitations (single adapter, no frozen replay, no outcomes, in-memory queue, local only).
- [ ] The controller runs the scenario script once against the dev stack (backend with `OLLAMA_URL` + the seeded world) and pastes the table into the doc's "First run" section.

---

### Scan of the plan against itself (controller)
- T2's `invokeTool`/`serializeToolResult`/`canonicalArgs` are consumed by T5 with these exact names; T3's `ModelAdapter`/`ChatResponse`/`ModelError` by T5/T6; T4's `validateProposal`/`captureBaseline`/`feasibleIdsFromToolResult`/`DISPATCH_PROMPT_V1` by T5; T5's `runDispatchDecision`/`RunStore`/`prismaRunStore` by T6; T6's routes by T7/T8.
- The read-only scan in `tests/dispatch-tools.test.ts` will cover `invoke.ts` automatically (it reads the directory); T2 must keep `invoke.ts` free of the forbidden call forms.
- `AiDecisionRecord.toolCalls`/`toolResults` (existing, required Json) are written as `[]` at enqueue and left as summaries (`[{ seq, name }]`, `[{ seq, truncated }]`) by T5's final update — T5 defines that.
- T7's "Ask Qwen" needs T6's experiment creation; the button hides when `status.enabled` is false.
