# Qwen Harness v0.1

The Qwen Harness runs a local language model against the AI Dispatch
Foundation's read-only tools to answer one question about one load: which
feasible driver, if any, should be recommended for it. Every model call, tool
call, and outcome is persisted, so a developer can inspect, replay, and
evaluate a run afterward. It is a read-only reasoning layer: nothing it does
writes to a load, an assignment, or a driver, and nothing it does touches
Night Shift, Twilio, email, or the deterministic ⚡Suggest engine dispatchers
already use.

## Architecture

```
portal /ai-lab -> dispatcherAiRouter (/api/dispatcher/ai/*, 404 unless OLLAMA_URL)
               -> aiHarness/runner.ts (in-process queue, one run per org)
               -> aiHarness/loop.ts   (runDispatchDecision, the turn loop)
                    -> ModelAdapter + dispatchTools/invoke.ts (17 tools) + RunStore
                    -> emitToDispatchers("ai_run_step" / "ai_run_status")
```

The backend surface lives under `/api/dispatcher/ai/*`
(`dispatcherAiRouter`, `fleet-backend/src/routes/dispatcherAi.ts`, mounted in
`app.ts`). `dispatcherAi.ts` holds status, the uncovered-loads picker, and
experiment create/list/get/update (archiving is `PATCH { status: "archived" }`;
there is no delete); `dispatcherAiRuns.ts` holds run lifecycle — enqueue, batch,
list, detail, cancel, verdict, replay, evaluation. Both sit behind the same
gate as every other `/api/dispatcher` route (auth, dispatcher role, org
scope), plus one more local to this feature: every route under `/ai/*`,
including `/ai/status` itself, answers `404 { "error": "Not found" }` unless
`OLLAMA_URL` is set.

`runner.ts` turns an enqueued `AiDecisionRecord` into an actual
`runDispatchDecision` call, one at a time per org. `loop.ts` is the
turn-by-turn algorithm, described below; it calls out to a `ModelAdapter`
(the model), `dispatchTools/invoke.ts` (the 17 read-only tools), and a
`RunStore` (the database). Every step and status change also goes out over
the existing realtime channel as `ai_run_step` / `ai_run_status`, so the
portal's run page can watch a run live instead of only polling.

The portal side (`fleet-portal/src/views/ai/AiLabView.vue`,
`AiExperimentView.vue`, `AiRunView.vue`) is a developer console under
`/ai-lab`, linked from the tower-tier nav only (the routes themselves are not
tier-guarded; the backend gates by dispatcher role and `OLLAMA_URL`) — a
status banner, an experiment list/create form,
and a run page with the full step timeline, the proposal beside the baseline,
and verdict controls. Its own banner copy: "v0.1 — read-only dispatch
reasoning; nothing here assigns anything."

## Model adapter

A `ModelAdapter` (`aiHarness/types.ts`) is
`{ name: string; chat(request, signal): Promise<ChatResponse> }`. The loop
never imports Ollama directly — it receives an adapter through
`RunInput.adapter`, and `runner.ts` is the only place that builds a real one
by default (`createOllamaAdapter(ollamaBaseUrl())`, built lazily so
`OLLAMA_URL` is read only once a run actually starts). Tests inject a
scripted adapter instead (`tests/helpers/scriptedAdapter.ts`).

v0.1 ships exactly one adapter, `createOllamaAdapter(baseUrl, fetchImpl)`
(`aiHarness/ollamaAdapter.ts`). It POSTs to `${baseUrl}/api/chat` with
`stream: false`, the conversation so far, the tool definitions, `think`,
`options.temperature`, `options.num_ctx`, and `keep_alive`. Failures are
classified into one `ModelError` kind: `http` (non-2xx), `network` (no
response at all), `malformed` (a response that parsed but not into a usable
message), or `aborted` (the caller's signal fired first). If a model returns
its tool-call arguments as a JSON-encoded string instead of an object, the
adapter parses it; if even that fails it keeps the raw string as
`{ "__raw": "<string>" }` rather than crashing, which then fails the tool's
own parameter validation downstream as an ordinary invalid call.

The adapter enforces no timeout of its own — `modelCallTimeoutMs` is the
loop's budget, not the adapter's. `keep_alive` is fixed at `"10m"`
(`loopMessages.ts`'s `KEEP_ALIVE`, not a config field): it keeps the model
resident in memory between calls and between back-to-back runs, cutting
cold-start latency. `checkOllama(baseUrl, model, fetchImpl)` is a separate,
occasional preflight used only by `GET /ai/status` — it calls `/api/version`
and `/api/tags` under one shared 3-second budget and reports reachability,
version, the pulled-model list, and whether the requested model is present.

The model's `thinking` output (when `think: true`) is captured as its own
step for the run timeline. It is never parsed and never drives control flow
— its absence changes nothing about how a run proceeds. It is also never
replayed back to the model on a later call: an early version resent every
turn's thinking on every subsequent request, which cost 0.5-2k tokens per
turn and grew turn over turn, materially shrinking how many real turns fit in
`config.numCtx` before Ollama's own context handling starts silently dropping
history (see Known limitations).

## Agent loop

`runDispatchDecision` (`aiHarness/loop.ts`) drives one run to completion. The
per-turn/per-call mechanics live in `aiHarness/loopHandlers.ts`
(`handleAssistantTurn`, `handleProposeCall`, `handleToolCall`,
`finalizeRun`); `loop.ts` is the state machine deciding which runs next, plus
the closures that persist steps and check for timeout/cancellation.

**Turn structure.** A run captures the deterministic baseline, persists a
`system` step and a `user` step, then repeats up to `config.maxTurns` times:
call the model; persist a `thinking` step if present, then an `assistant`
step; if the answer has no tool calls, nudge once and continue, or (on any
second content-only answer in the run, nudged or not) end as `no_decision`;
otherwise process each tool call in order — `propose_decision` specially,
everything else through `invokeTool`, checked against every cap afterward.

The run ends with exactly one `TerminationReason`: `proposed`, `no_decision`,
`max_turns`, `max_tool_calls`, `repeated_calls`, `consecutive_invalid`,
`tool_bytes_exceeded`, `timeout`, `model_error`, `cancelled`, or
`internal_error`. The last was added after the original design: it covers an
unexpected throw from anywhere other than capturing the baseline —
`validateProposal`'s own database call, the store, or any other bug — so a
run can never stay `"running"` forever because something other than the
model itself broke. (A baseline-capture failure is not an `internal_error`;
the run just continues with `baseline: null` and an empty feasible set.)
Caps are checked in a fixed order — `max_tool_calls`, `tool_bytes_exceeded`,
`consecutive_invalid`, `repeated_calls` — so a call tripping more than one at
once always reports the same reason.

**The shared step payload contract.** Every interaction is one `AiRunStep`
row (`kind`, `name`, `payload`, `atMs`, `durationMs`):

| Kind | Payload |
|---|---|
| `system`, `user`, `nudge` | `{ content }` |
| `thinking` | `{ text }` |
| `assistant` | `{ content, toolCalls: [{ name, arguments }], stats: { promptTokens, completionTokens, totalDurationMs }, doneReason }` |
| `tool_call` | `{ name, arguments }` |
| `tool_result` | `{ name, ok, truncated?, originalSize?, returnedSize?, preview?, error?, errors? }` |
| `final` | `{ proposal, ignoredCalls? }` |
| `error` | `{ kind, message }` |

`findFeasibleDrivers`'s `tool_result` also carries a `feasibility` array of
parsed candidate rows — exactly the rows the model-facing compact projection
(see Tool registry) actually delivered (up to 20 feasible + 15 blocked), never
the engine's full candidate list — so evidence reconstruction (see Evaluation
methodology) reports what the model saw and never depends on the
512-character display `preview`.

Every `tool_call` step, including one that turns out to be an unknown tool, a
repeated call, invalid parameters, or a rejected `propose_decision`, is
persisted BEFORE that call is validated or executed — request wall time, not
completion time — so the developer timeline always shows exactly what was
asked for, not only the calls that happened to succeed.

**Nudge.** A content-only answer gets one fixed message
(`DISPATCH_PROMPT_V1.nudge`): to finish by calling `propose_decision`, with
`driverId: null` if nothing is appropriate. At most once per run — a second
content-only answer, nudged or not, ends the run as `no_decision`.

**Per-call and per-run timeouts.** `config.modelCallTimeoutMs` (default
120000ms) bounds one call, never past however much of `config.maxRunMs`
(default 600000ms) remains — `callModel` (`loopGuards.ts`) races the adapter
against whichever budget is smaller, plus the caller's cancel signal, and
reports whether `timeout`, `cancelled`, or `model_error` won. The run
deadline is also checked directly before every model call, before every tool
call, and once more right after a tool call finishes, so a call completing
just past the deadline still gets its result persisted before the run stops.

## Tool registry

`dispatchTools/manifest.ts` defines 17 read-only functions:

| Tool | Returns |
|---|---|
| `getLoad` | One load: stops, appointments, customer, current assignment. |
| `searchLoads` | Loads filtered by status/customer/pickup window/coverage, newest first. |
| `getUncoveredLoads` | Open, unassigned loads whose pickup window hasn't been over for more than 24h, soonest first. |
| `getDriver` | One driver's profile and current availability (no metrics). |
| `searchDrivers` | Drivers filtered by availability/equipment/language/state/accepting-loads. |
| `getAvailableDrivers` | Drivers AVAILABLE or AVAILABLE_SOON and accepting loads, soonest first. |
| `getDriverAvailability` | One driver's current availability only. |
| `getDriverMetrics` | On-time rate, detention, response behavior, lane experience. |
| `getDriverHistory` | One driver's completed assignments, most recent first. |
| `getDriverLocationHistory` | Raw location pings since a given time, oldest first. |
| `getCustomer` | One customer's profile and load count. |
| `getCustomerHistory` | Volume, on-time rate, common lanes, detention history. |
| `getCurrentETA` | Best-known current ETA (agent live itinerary, else planned end). |
| `getLoadEvents` | A load's change history + agent status updates, merged, oldest first. |
| `getAgentEvents` | The Night Shift agent's own trip/event trail for a load. |
| `findFeasibleDrivers` | Every org driver ranked for one load; feasible scored, others with a reason. |
| `getDispatchCandidateDetails` | One driver's ranking row for one load. |

**invokeTool.** `invokeTool(orgId, name, params)` is the one place a tool
name becomes a call. Unknown name → `{ ok: false, code: "unknown_tool" }`.
Otherwise `params` is validated against that tool's zod schema
(`invalid_params` on failure, naming the first bad field and zod's message).
On success the function is called with `orgId` injected first — never a
value the model supplies — and whatever positional arguments it needs. A
thrown error comes back as `{ ok: false, code: "tool_error" }`. `invokeTool`
itself never throws, so any outcome goes straight back to the model as a
tool result.

**Model-facing projection.** A successful result is reshaped by
`projectForModel(name, value)` before `invokeTool` returns it — the 17 tool
functions themselves are unchanged, and every OTHER caller (the portal's own
routes) still gets their real return value. Two things are stripped: (1)
`extras` (and any `load`/`loads` field nested inside another result), removed
at every depth from every tool's result — the seeded demo world keeps its
scenario answer key at `Load.extras.scenario.hint`, naming the expected
driver, and a model reasoning from that instead of its own tool calls would
make every evaluation against the seeded world meaningless; (2)
`findFeasibleDrivers`'s full candidate list is reshaped into a compact form
(see Known limitations) rather than handed over verbatim.

`toolDefinitionsForModel()` turns the manifest's zod schemas into
`ToolDefinition[]` (via zod v4's `z.toJSONSchema`). `harnessToolDefinitions()`
(`loopMessages.ts`) appends the one non-registry tool, `propose_decision` —
every turn offers the model all 18.

**The read-only guarantee.** `orgId` is always the run's own org, injected by
`invokeTool` — no tool's params schema even has an `orgId` field a model
could override. Every function under `dispatchTools/` only reads; nothing
there calls a write helper. This is checked mechanically too:
`tests/dispatch-tools.test.ts` statically scans every file under
`dispatchTools/` for forbidden write call forms, and `invoke.ts` lives there
specifically so the scan covers it.

**Truncation.** `serializeToolResult(value, maxBytes = 8192)`
(`aiHarness/serialize.ts`) turns a raw tool result into the JSON text a model
reads back (BigInt → number, Date → ISO string, `undefined` → `null`, so no
key is silently dropped). Under 8192 bytes (`TOOL_RESULT_MAX_BYTES`, this
module's own fixed default — **not** a config field), it returns as-is with
`truncated: false`. Over it, the text is cut to a UTF-8-safe prefix and
wrapped as `{ truncated: true, originalSize, returnedSize, data }`, so the
model always gets valid JSON and always knows it was cut. The same metadata,
plus a 512-character `preview`, is what the persisted `tool_result` step
carries.

This per-result cap is independent of `config.maxToolResultBytes` (default
65536), the loop's own **cumulative** cap across every successful call in a
run, checked once per call against a running total — never against one
result's size. Exceeding it ends the run as `tool_bytes_exceeded`.
`canonicalArgs(args)` recursively sorts object keys (arrays keep their
order) so two argument objects differing only in key order canonicalize
identically — this is what detects a repeated call.

## Terminal decision contract

`propose_decision` (`aiHarness/decision.ts`) is not one of the 17 registry
tools — it is the run's own structured output, and calling it validly is the
only way a run ends in success.

**Schema:**
```
{
  driverId: string | null,
  reason: string (20-2000 characters),
  confidence: number (0-1),
  alternatives: [{ driverId: string, reason: string (5-500 characters) }] (max 3)
}
```
All four fields are required. `driverId: null` ("no feasible driver is
appropriate") is a valid, complete proposal.

**Validation rules.** `validateProposal(raw, { orgId, feasibleDriverIds })`
runs three passes, reporting every problem at once: (1) shape, the schema
above translated into plain-English messages; (2) self-consistency — an
alternative can't repeat the main pick or another alternative; (3)
feasibility — every referenced driver id must exist in the org and belong to
`feasibleDriverIds`, the union of the baseline's own `feasibleDriverIds` and
every id a `findFeasibleDrivers` call **for this same load** returned as
feasible during the run. A driver missing from that set is rejected even if
it is a real driver elsewhere in the org.

**Correction within remaining turns.** An invalid proposal does not end the
run — it is persisted as a `tool_result` (`{ ok: false, errors: [...] }`) and
answered back like any other tool result, so the model can correct itself
with whatever turns remain. It also counts toward
`config.maxConsecutiveInvalid`.

**No side effects.** A valid proposal ends the run and is recorded on the
`AiDecisionRecord` (`proposedDecision`, `reason`, `confidence`, `driverId`) —
nothing else changes. The harness never calls `applyLoadChange` or creates or
edits an `Assignment` or `Driver`; every write in this feature goes through
`RunStore` into `AiExperiment`/`AiDecisionRecord`/`AiRunStep`.

## Persistence

The schema is additive on the AI Dispatch Foundation's existing
`AiExperiment`/`AiDecisionRecord` models (migration
`20260925062128_qwen_harness_v0_1`), plus one new table, `AiRunStep`.

**`AiExperiment`** — one row per named configuration: `name`, `notes`;
`model` (kept in sync with `config.model` for flat-column readers); `status`
(`active` \| `archived`, default `active`); `promptVersion` (default
`"dispatch-v1"`); `config` (JSON `HarnessConfig`); `createdById` (plain
string, not a relation).

**`AiDecisionRecord`** — one row per run:

| Column | Notes |
|---|---|
| `experimentId`, `orgId`, `loadId`, `driverId` | `loadId`/`driverId` are plain strings — an audit trail survives the row it refers to being deleted. |
| `kind` | `"dispatch_candidate"` for every run here. |
| `context` | `{ loadRef, requestedAt }`, set at enqueue time. |
| `toolCalls`, `toolResults` | Compact summaries, written once at the end; full detail lives in `AiRunStep`. |
| `proposedDecision`, `reason`, `confidence` | Set once a proposal is accepted. |
| `humanDecision`, `decidedAt` | `{ verdict, driverId, note, byDispatcherId }`. |
| `actualOutcome`, `outcomeAt` | Always `null` in v0.1. |
| `status` | `queued \| running \| proposed \| incomplete \| failed \| cancelled`. |
| `terminationReason`, `error` | The reason above; `error` set for `model_error`/`timeout`/`internal_error`, and for `cancelled` (where the cancellation was detected). |
| `stats` | `{ modelCalls, toolCalls, uniqueTools, repeatedCalls, invalidCalls, promptTokens, completionTokens, maxPromptTokens, contextPressure, durationMs }`. |
| `baseline`, `evidence` | See Evaluation methodology. |
| `modelConfig`, `promptVersion` | Snapshotted at run start — see below. |
| `startedAt`, `completedAt`, `requestedById`, `parentRunId` | `parentRunId` links a replay to its source run. |

**`AiRunStep`** — one row per interaction: `decisionId` (FK, cascades),
`seq` (1-based, gapless, unique per `decisionId`), `kind`, `name`, `payload`
(the step payload contract above), `atMs` (epoch ms, `BigInt`),
`durationMs`. It exists so a full replay never depends on how
`AiDecisionRecord`'s own summary columns chose to compress the same run.
`AiRunStep.name` carries the tool name for `tool_call`/`tool_result`/`final`,
`null` otherwise.

**Config snapshot per run.** `modelConfig` is written by the very first
`store.updateRun` call, before anything else runs — the fully resolved
config the run is actually executing with, not a live reference to the
experiment's. Editing an experiment later can never rewrite what an
already-run decision used. `promptVersion` is copied from the experiment at
enqueue time and overwritten by that same first `updateRun` with the version
of the prompt the loop actually ran (`DISPATCH_PROMPT_V1.version`).

## Experiment lifecycle

- **Create** — `POST /ai/experiments { name, notes?, config? }`. `config` is
  partial; missing fields fill in from `DEFAULT_HARNESS_CONFIG`
  (`resolveHarnessConfig`); an out-of-range or wrong-type field is a 400, not
  a silent clamp.
- **Run** — `POST /ai/experiments/:id/runs { loadId }` → `202 { runId }`.
  `POST /ai/experiments/:id/runs/batch { limit }` (1-10) enqueues up to
  `limit` of `getUncoveredLoads(orgId)`, stopping early on a full queue but
  never aborting the batch over one bad row.
- **Replay** — `POST /ai/runs/:id/replay` enqueues a **new** record for the
  same experiment and load against the world's **current** state (not a
  frozen snapshot), with `parentRunId` set. 409 while the source run is
  queued/running; 400 if it has no load.
- **Verdict** — `POST /ai/runs/:id/decision { verdict, driverId?, note? }`,
  only once a run has stopped on its own (`proposed`/`incomplete`/`failed`,
  never `queued`/`running`/`cancelled`). `verdict: "other"` requires a real
  `driverId` in the org.
- **Evaluation** — `GET /ai/experiments/:id/evaluation` — see below.

**Queue semantics.** `runner.ts` keeps one FIFO queue per org, in memory. One
run executes at a time per org; different orgs run fully concurrently. At
most `MAX_QUEUED_PER_ORG` (10) runs may be **queued** — the run currently
executing is not counted, so an org can hold one running plus ten queued —
before `enqueueRun` returns `{ error: "QUEUE_FULL" }` (HTTP 429). Cancel
removes a still-queued run and marks it `cancelled` directly, or signals a
running run's `AbortController`, which the loop's own deadline/cancel check
finishes as `cancelled` on its next pass.

**Restart behaviour.** The queue is process-local state — nothing survives a
restart. A run left `"queued"` or `"running"` by a restart or crash is not
resumed and is unknown to the new process — but it is not stuck: `POST
/ai/runs/:id/cancel` reads the row directly whenever the runner does not
recognize it, and if the database still says `"queued"`/`"running"`, marks it
`cancelled` (with `error` noting the process restart) so the row stops
reporting a status nothing will ever change again. A verdict still 409s on a
`cancelled` row either way (the allow-list is `proposed`/`incomplete`/`failed`
only); a replay is allowed, same as any other `cancelled` run. `GET
/ai/status` reports how many of the org's rows are in this orphaned state as
`orphaned`, so a dispatcher can see there is something to reclaim before
hunting for a stuck run by hand.

## Safety boundaries

- **What the harness can never touch.** Every callable tool is read-only,
  statically scanned (see Tool registry). `propose_decision` has no side
  effect. Every write in this feature goes through `RunStore` into
  `AiExperiment`/`AiDecisionRecord`/`AiRunStep` — nothing here ever creates
  or edits a `Load`, `Assignment`, or `Driver`, and nothing here reaches
  Night Shift, Twilio, or email.
- **Local only.** v0.1 ships one adapter, talking to a local or LAN Ollama
  server at `OLLAMA_URL`. There is no hosted-model path and no production
  Ollama deployment in scope.
- **404 unless `OLLAMA_URL`.** `harnessEnabled()` reads `process.env.OLLAMA_URL`
  fresh on every call, never cached, so every route under
  `/api/dispatcher/ai/*` — including `/ai/status` itself — answers a plain
  `404`, same as a nonexistent route, whenever it is unset.
- **Not on the API-key allow list.** Night Shift's MCP-tool credential
  (`x-api-key`) is restricted, right after the session gate, to a small
  allow-list of routes (`middleware/apiKeyAuth.ts`). `dispatcherAiRouter` is
  never added to it — an API-key request 401s every `/ai/*` route exactly
  like a request with no credential at all. Only a real dispatcher bearer
  session can reach the harness.

## Evaluation methodology

**Baseline vs pick vs human.** Every run is judged against two independent
references, never against each other. At the start of every run,
`captureBaseline(orgId, loadId)` calls the same `suggestForLoad` pipeline
⚡Suggest already uses and stores its candidates, feasibility, scores,
deadhead, margin, ETA, and blocked reasons onto `AiDecisionRecord.baseline`,
**before** the model sees anything — it sees those rows only if it calls
`findFeasibleDrivers` itself. The model's own answer is its
independently-reasoned `proposedDecision`; a human dispatcher's reaction,
once recorded, is `humanDecision`. `GET /ai/experiments/:id/evaluation`
lines all three up per run, plus the loop-effort numbers that explain how
the model got there.

**Evaluation columns:**

| Column | Source |
|---|---|
| Scenario | The load's `extras.scenario` (code/title/hint), or none. |
| Deterministic top | The baseline's `topFeasibleDriverId`. |
| Rank of pick | The pick's 1-based position in the baseline's full candidate order (feasible or not); null if no pick, no baseline, or never seen there. |
| Pick, confidence | `proposedDecision.driverId`, `confidence`. |
| Human verdict | `accept \| reject \| other`, once recorded. |
| Turns, tool calls, unique/repeated/invalid | `stats.modelCalls/toolCalls/uniqueTools/repeatedCalls/invalidCalls`. |
| Latency, tokens | `stats.durationMs`; `stats.promptTokens` + `stats.completionTokens`. |
| Ctx pressure | `stats.contextPressure` — the run's `"ctx!"` badge (see Known limitations). |
| Termination | The run's own `terminationReason`. |

The accompanying summary reports counts by termination reason, how many
matched the deterministic top, accepted/rejected counts, and mean
turns/tool calls/latency — the means cover only runs that reached
`proposed`, since a run that stopped some other way reflects why it stopped,
not typical effort.

**Matching is reference, not correctness.** Matching the deterministic top,
or a scenario's own seeded expectation, is reference data — never ground
truth. A different pick is not automatically wrong: the model may have
weighed evidence the engine's formula does not. A match does not by itself
prove good reasoning either — it could echo the engine's favorite without
real investigation. This table is for comparing runs, not for grading a
model pass/fail against the existing pipeline.

**What "actual outcome" will add later.** `actualOutcome`/`outcomeAt`
already exist on `AiDecisionRecord` and stay `null` in v0.1. They are
reserved for a later phase that records what really happened after a
recommendation was acted on (delivered on time, driver accepted, and so on)
— letting a future evaluation compare against a real result, not only
against the deterministic snapshot and an immediate human reaction.

## How to run Ollama locally

1. Install Ollama and pull the default model: `ollama pull qwen3:8b`.
2. Confirm it is serving where the backend will look — Ollama's own default
   is `http://127.0.0.1:11434`.
3. Set `OLLAMA_URL` in the backend's environment (`fleet-backend/.env`,
   documented in `.env.example`): `OLLAMA_URL=http://127.0.0.1:11434`.
   Leaving it unset is a deliberate, supported state — the whole `/ai/*`
   surface 404s and the rest of the product is unaffected.
4. Start (or restart) the backend, then check `GET /api/dispatcher/ai/status`
   (or the AI Lab's own status banner) to confirm Ollama is reachable and
   the model is present before running anything real.
5. To enable the one test that reaches this real server
   (`tests/ai-harness-live.test.ts`), set `AI_LIVE_TEST=1` alongside
   `OLLAMA_URL` for that process only:
   ```
   OLLAMA_URL=http://127.0.0.1:11434 AI_LIVE_TEST=1 \
     npx vitest run tests/ai-harness-live.test.ts
   ```
   Without both set, that file is skipped — an ordinary `npx vitest run`
   never depends on a local model.

## How to run scenarios A–H

Prerequisites: the demo world already seeded (`node seed-world.mjs` from
`fleet-backend/`, which creates `W-A-RELIABLE` through `W-H-PRIORITY` among
others), and the backend running with `OLLAMA_URL` set, reachable, with the
desired model pulled.

From `fleet-backend/`: `node scripts/ai-eval-scenarios.mjs`.

| Env var | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | The backend's origin. |
| `AI_EVAL_EMAIL` | `w@fleet.com` | Dispatcher login (the seeded world's own). |
| `AI_EVAL_PASSWORD` | `pass123` | Dispatcher login password. |
| `AI_EVAL_MODEL` | `qwen3:8b` | Model to run the experiment with. |
| `AI_EVAL_MAX_WAIT_MS` | `5400000` (90 min) | Safety ceiling on the polling phase. |

The script logs in, checks `GET /ai/status` (exit code 2 with a clear message
if the harness is disabled or Ollama is unreachable), finds or creates an
experiment named `Scenarios A–H · dispatch-v1 · <model>` (a different
`AI_EVAL_MODEL` is always a different experiment), resolves each scenario
load by `externalId` (primarily `GET /ai/uncovered-loads`, falling back to
`dispatcherLoads.ts`'s by-ref lookup, `GET /api/dispatcher/loads/lookup?ref=`),
enqueues one run per resolved load respecting the 10-pending queue cap, and
polls every 3 seconds until each is terminal. It then fetches
`GET /ai/experiments/:id/evaluation`, prints the markdown table and a
one-line summary, and writes the same to
`docs/evaluations/<YYYY-MM-DD>-scenarios-a-h.md` (creating the folder if
needed). It never prints `AI_EVAL_PASSWORD`, the login token, or any
`Authorization` header.

## Known limitations

- **Single adapter.** `ModelAdapter` is an interface, but only
  `createOllamaAdapter` exists; a couple of fixed names (`keep_alive`,
  `num_ctx`) are Ollama-specific concepts with no second provider yet to
  generalize them for.
- **In-memory queue.** `runner.ts`'s whole queue/state is a process-local
  `Map` (see Restart behaviour) — a multi-instance deployment would need a
  shared queue this version does not have, and a restart still orphans any
  row that was `queued`/`running` at that moment (recoverable via `GET
  /ai/status`'s `orphaned` count and `POST /ai/runs/:id/cancel`, never
  auto-resumed).
- **Context window.** The default `numCtx` 16384 holds roughly six or seven
  turns of this prompt: per-call prompt tokens reached 12.4k after five calls
  in an early run (+1.5-4.3k per turn, before thinking replay was removed —
  see Agent loop). Past that, Ollama silently drops the oldest non-system
  messages — the user request first — and its response carries no flag of its
  own; this harness cannot change that behavior. What it does do: `stats.maxPromptTokens`
  records the highest per-call prompt-token count for the
  run, and `stats.contextPressure` is `true` once any call exceeded 85% of
  `numCtx`, surfaced per row in the evaluation table's "ctx!" badge — so a run
  that plausibly lost history is visible after the fact instead of silent.
  Watch for the badge, or raise `numCtx`, on a run with many turns.
- **`findFeasibleDrivers` is projected, never sent raw.** A large fleet's full
  ranked list (165 drivers ≈ 263 KB) is never handed to the model —
  `dispatchTools/invoke.ts`'s `projectForModel` reduces it to a compact shape (up to 25
  feasible rows and 15 blocked rows, engine order, plus a `counts` block
  naming how many of each actually exist) before the per-result 8192-byte cap
  (see Tool registry) ever applies. The persisted `feasibility` array and the
  evidence it feeds mirror exactly those delivered rows, not the engine's full
  candidate list.
- **No frozen-context replay.** Replay re-runs against the world's current
  state, not a frozen snapshot of what the original run saw.
- **No outcomes.** `actualOutcome`/`outcomeAt` exist in the schema and stay
  `null`.
- **Thinking is display-only.** Stored and shown, never parsed or acted on.
- **8B-model behaviours to expect.** Every loop-protection cap exists because
  a smaller model is more likely than a larger one to answer with no tool
  call, repeat an identical call, or send malformed tool arguments — a run
  ending via one of those caps is the guard doing its job, not necessarily a
  bug. In the one live run performed while preparing this document
  (`W-A-RELIABLE`, default config), `qwen3:8b` reached a valid proposal after
  4 model turns and 3 tool calls — a single data point, not a benchmark.
- **Local only.** No hosted or production Ollama path; the backend must be
  able to reach Ollama over the local machine or LAN.
- **Loop-protection defaults** (`DEFAULT_HARNESS_CONFIG`,
  `aiHarness/config.ts`), overridable per experiment within the listed range:

  | Field | Default | Range |
  |---|---|---|
  | `model` | `qwen3:8b` | non-empty, ≤80 chars |
  | `think` | `true` | boolean |
  | `temperature` | `0.2` | 0-2 |
  | `numCtx` | `16384` | 2048-131072 |
  | `maxTurns` | `12` | 1-50 |
  | `maxToolCalls` | `30` | 1-200 |
  | `maxConsecutiveInvalid` | `3` | 1-10 |
  | `maxToolResultBytes` (cumulative) | `65536` | 8192-1048576 |
  | `maxRunMs` | `600000` (10 min) | 30000-3600000 |
  | `modelCallTimeoutMs` | `120000` (2 min) | 5000-600000 |

  Two more values are fixed, not config fields: the per-result truncation
  ceiling is always 8192 bytes (`serialize.ts`'s `TOOL_RESULT_MAX_BYTES`),
  and the repeated-identical-call limit is always 3 (`loopGuards.ts`'s
  `REPEATED_CALLS_LIMIT`).

## First run

Second run, 2026-09-25, after the model-facing projection removed the seeded scenario hints from tool results (the first run could read them and is kept in the evaluation file's history as superseded). Seeded world `Great Lakes Freight Co` (165 drivers), local Ollama 0.34.3, `qwen3:8b`, prompt `dispatch-v1`, default config (think on, temperature 0.2, num_ctx 16384, maxTurns 12). Every run is in the AI Lab, experiment "Scenarios A–H · dispatch-v1 · qwen3:8b", with its complete step history.

| Scenario | Load ref | Deterministic top | Pick | Confidence | Rank of pick | Human verdict | Turns | Tool calls | Unique/Repeated/Invalid | Latency (s) | Tokens (prompt+completion) | Termination |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | W-A-RELIABLE | Charlotte Petrovski | Dwayne Okafor | 0.95 | 4 | — | 4 | 3 | 3/0/0 | 30.8 | 18866+2850 | proposed |
| B | W-B-CLOSER | Eric Davis | Dwayne Okafor | 0.95 | 4 | — | 4 | 3 | 3/0/0 | 35.9 | 18007+3399 | proposed |
| C | W-C-SOON | Ana Kovacs | Dwayne Okafor | 0.95 | 3 | — | 5 | 4 | 4/0/0 | 38.1 | 22074+3752 | proposed |
| D | W-D-HOS | Dwayne Okafor | Dwayne Okafor | 0.95 | 1 | — | 5 | 4 | 4/0/0 | 36.0 | 25040+3472 | proposed |
| E | W-E-EQUIP | Femi Okafor | — | — | — | — | 9 | 6 | 4/1/3 | 129.5 | 59536+12879 | consecutive_invalid |
| F | W-F-LANE | — | — | 1.00 | — | — | 3 | 2 | 2/0/0 | 23.0 | 9487+2162 | proposed |
| G | W-G-HOME | Ava Li | Marcus Webb | 0.95 | 5 | — | 4 | 3 | 3/0/0 | 35.9 | 18040+3477 | proposed |
| H | W-H-PRIORITY | Ava Li | Marcus Webb | 0.95 | 6 | — | 5 | 4 | 4/0/0 | 57.1 | 24659+5567 | proposed |

8 runs (proposed=7, consecutive_invalid=1) — 1/8 matched the deterministic top — mean turns 4.3, mean latency 36.7s

Observations (reference data, not verdicts):

- Seven of eight runs ended with a validated `propose_decision`; scenario E (a Reefer load whose nearest driver is flatbed-only) ended `consecutive_invalid` after three rejected proposals in a row — the model kept proposing drivers that were not in the feasible set it had been shown, and the terminal guard held.
- Two to four tool calls per run in the proposed cases; `findFeasibleDrivers` first every time, then one or two driver-detail calls. Metrics or history were requested in four of eight runs.
- The model proposed the same driver, Dwayne Okafor, in scenarios A–D. In scenario B his seeded evidence (three unanswered check-ins, 61 % reply rate) argues against him; whether that evidence was requested is visible in each run's step history.
- Confidence was 0.95–1.00 in every proposed run regardless of how much evidence was gathered — it is self-reported and not calibrated.
- One in eight picks matched the deterministic engine's top candidate; the pick's rank in the engine's order ranged from 1 to 6.
- Mean latency 36.7 s per run on this machine; prompt tokens 9–25 k per run for proposed cases (59 k for the nine-turn scenario E), now without thinking replayed into the history.

What to try next with this data: a `dispatch-v2` prompt that requires metrics for the top two feasible drivers before proposing; the same eight scenarios on a larger model via a second experiment config; human verdicts on these eight runs so the evaluation columns fill in.
