# Qwen Harness v0.1 — design

Approved 2026-09-25 (Approach A, in-process) with fifteen adjustments from the product owner; all are folded in below.

## 1. Purpose

Make the agent loop observable. v0.1 runs a local model (Ollama, `qwen3:8b` by default) against the AI Dispatch Foundation's 17 read-only tools to answer one question per run — *"Investigate this load and recommend the most appropriate feasible driver"* — and persists every interaction so a developer can replay, compare and evaluate. It is READ-ONLY DISPATCH REASONING: nothing it does touches loads, assignments, drivers, Night Shift, Twilio, email or the deterministic engine.

## 2. Architecture

```
portal /ai-lab  ──HTTP──▶  dispatcherAiRouter (session-gated, 404 unless OLLAMA_URL)
                              │ enqueue / cancel / verdict / replay / evaluation
                              ▼
                         aiHarness/runner   (in-process queue, one run at a time per org)
                              │
                         aiHarness/loop     (turns ≤ maxTurns; loop protection; terminal contract)
                     ┌────────┼──────────────┐
            ModelAdapter   dispatchTools/invoke   RunStore (Prisma: AiDecisionRecord + AiRunStep)
            (Ollama HTTP)   (17 read-only tools)   + emitToDispatchers("ai_run_step" | "ai_run_status")
```

- **Model adapter.** `ModelAdapter { name; chat(request, signal) }`. v0.1 ships one adapter, `createOllamaAdapter(baseUrl)`, over `POST /api/chat` (`stream: false`, `tools`, `think`, `options.temperature`, `options.num_ctx`, `keep_alive`). The loop never imports Ollama directly; a scripted adapter drives the tests. Thinking (`message.thinking`) is captured as its own step for display only — never parsed, never used for the decision, and its absence changes nothing.
- **Tool registry.** `dispatchTools/invoke.ts` — `invokeTool(orgId, name, params)` validates `params` against the manifest's zod schema, then calls the existing positional function. It lives under `dispatchTools/` so the static read-only scan covers it. `toolDefinitionsForModel()` turns `toolManifestJson()` into Ollama tool definitions. The org is always the run's org, never a model parameter.
- **Terminal contract.** `propose_decision` is not a registry tool. It is the run's structured output: `{ driverId: string | null, reason: string, confidence: number, alternatives: { driverId: string, reason: string }[] }`, validated by zod and by a driver check (exists, belongs to the org, appeared in this run's feasible set — the baseline's feasible ids ∪ feasible rows the model itself received from `findFeasibleDrivers`). A valid proposal terminates the run (`terminationReason: "proposed"`); an invalid one is returned to the model as an error and counts as an invalid call, so it can correct itself within the remaining turns. No side effect is ever attached.
- **Deterministic baseline.** At the start of every `dispatch_candidate` run the harness captures `suggestForLoad(orgId, loadId)` — feasible ids, order, scores, deadhead, margin, ETA, blocked reasons and the context summary the engine already returns — into `AiDecisionRecord.baseline`. It is never put into the prompt; the model sees the engine's rows only if it calls `findFeasibleDrivers` itself. The baseline exists to compare ENGINE vs QWEN vs HUMAN (vs OUTCOME later).
- **Evidence.** After a proposal, `collectEvidence(steps, proposal, baseline)` reconstructs from the persisted steps: tools called (name, count), candidate drivers inspected (driver ids in tool arguments and in `findFeasibleDrivers` results), feasibility rows seen, drivers whose metrics/history were inspected, and the facts cited (the proposal's reasons verbatim, plus the step numbers whose results mention the proposed driver). The step history is the source of truth; the model is never asked to repeat tool results.
- **Config per experiment.** `AiExperiment.config` holds `{ adapter: "ollama", model, think, temperature, numCtx, maxTurns, maxToolCalls, maxConsecutiveInvalid, maxToolResultBytes, maxRunMs, modelCallTimeoutMs }`; defaults `qwen3:8b / true / 0.2 / 16384 / 12 / 30 / 3 / 65536 / 600000 / 120000`. Every run snapshots the config it executed with (`AiDecisionRecord.modelConfig`) so a later config edit never rewrites history.

## 3. Loop protection and termination

Turn cap (`maxTurns`), total tool-call cap (`maxToolCalls`), repeated identical call detection (same name + canonical JSON of arguments → not executed, error returned, counts as invalid), consecutive-invalid cap (`maxConsecutiveInvalid`; invalid = bad arguments, unknown tool, repeated call, rejected proposal), accumulated tool-result bytes cap (`maxToolResultBytes`), per-call timeout (`modelCallTimeoutMs`), per-run timeout (`maxRunMs`), and cancel. Every run ends with exactly one `terminationReason` ∈ `proposed | no_decision | max_turns | max_tool_calls | repeated_calls | consecutive_invalid | tool_bytes_exceeded | timeout | model_error | cancelled`. A model answer with no tool call and no proposal is nudged once ("finish by calling propose_decision"); a second such answer ends the run as `no_decision`.

## 4. Tool results

Serialized JSON (BigInt → number, Date → ISO). Results above 8 KB are cut and wrapped as `{ "truncated": true, "originalSize": N, "returnedSize": M, "data": "<prefix>" }` so the model knows it received incomplete data; the same metadata is stored on the `tool_result` step. Untruncated results are returned as-is with `truncated: false` on the step.

## 5. Persistence

Additive migration. `AiExperiment` + `status` (active|archived), `promptVersion` (default `dispatch-v1`), `config`, `createdById`. `AiDecisionRecord` + `status` (queued|running|proposed|incomplete|failed|cancelled), `terminationReason`, `error`, `stats` (modelCalls, toolCalls, uniqueTools, repeatedCalls, invalidCalls, promptTokens, completionTokens, durationMs), `baseline`, `evidence`, `modelConfig`, `promptVersion`, `startedAt`, `completedAt`, `requestedById`, `parentRunId` (replay lineage). New `AiRunStep` (decisionId, seq, kind ∈ system|user|assistant|thinking|tool_call|tool_result|final|error|nudge, name, payload, atMs, durationMs) — one row per interaction, in order. `humanDecision` = `{ verdict: accept|reject|other, driverId?, note?, byDispatcherId }` with `decidedAt`. `actualOutcome` stays null in v0.1.

## 6. Experiment lifecycle

create experiment (name, notes, config) → enqueue run(s) for loads (single, batch of uncovered ≤ 10, or replay of a completed run = new record, same experiment and load, current world state, `parentRunId`) → runs execute one at a time per org, emitting `ai_run_status` and `ai_run_step` → a developer records a verdict → `GET /ai/experiments/:id/evaluation` reports, per run: scenario reference (the seeded `extras.scenario`), deterministic top candidate and the rank of the model's pick, the model's pick and confidence, human verdict, turns, tool calls, unique tools, repeated and invalid calls, latency, tokens, termination reason. Matching the deterministic top or a seeded expectation is shown, never declared "correct".

## 7. Failure is non-destructive

Ollama down, timeouts, malformed JSON, invalid arguments, unknown tools, no decision: the run is persisted as `failed`/`incomplete` with its error step and termination reason; nothing else in the platform changes. The router answers 404 when `OLLAMA_URL` is unset; the routes are never on the API-key allow-list; the queue refuses more than 10 pending runs per org.

## 8. Developer UI (`/ai-lab`, tower tier, "AI Lab (dev)")

Status banner (harness enabled, Ollama reachable, model present). Experiments list and create form (config visible and editable). Experiment page: config card, "Run on load" (uncovered loads with scenario tags), "Run all uncovered (10)", runs table with the evaluation columns. Run page: the vertical timeline USER REQUEST → MODEL → TOOL REQUEST → TOOL ARGUMENTS → TOOL RESULT → MODEL → … → FINAL PROPOSAL, each step with timestamp and duration, thinking collapsible, JSON viewers, truncation badges; the proposal beside the deterministic top candidate; Accept / Reject / Other-driver + note; "Run again"; failures shown plainly. Live via WS with a 2-second poll while running. "Ask Qwen" in the ⚡ Suggest panel starts a run in the most recent active experiment (creating "Scratch" if none) and opens it.

## 9. Out of scope (v0.1)

Twilio/SMS/email, assignment or load writes, Night Shift changes, ClaudeConversation replacement, ML models, vector databases, embeddings, long-term memory, autonomous scheduling, frozen-context replay, outcome tracking, Render/production Ollama.

## 10. Documentation

`docs/qwen-harness-v0.1.md`: architecture, model adapter, agent loop, tool registry, terminal decision contract, persistence, experiment lifecycle, safety boundaries, evaluation methodology, running Ollama locally, running scenarios A–H, known limitations.
