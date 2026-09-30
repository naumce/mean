# Agents Operating Specification

## 1. Purpose

This document describes what the product's two AI-driven capabilities — the Dispatch Assistant and Night Shift — and the rules engine underneath them actually
do, as implemented in this repository on 2026-09-30.

It is written for a dispatcher-turned-buyer, not an engineer: plain language, minimal jargon, and acronyms expanded on first use.

Every factual claim carries a `(source: path:line)` citation to the file that proves it, so any sentence here can be checked against the code directly.

It is not a roadmap or a sales description. Where the implementation stops short of what a reasonable buyer might assume from the product's pitch, that gap is
named in Section 7, not glossed over.

Nothing in this document describes behavior the code does not have; where a claim could not be fully verified, that is stated explicitly rather than assumed.

## 2. The three capabilities

| Capability | Works with (inputs) | Works for / talks to | Authority |
| --- | --- | --- | --- |
| Dispatch Assistant | One uncovered load; read-only facts about loads, drivers, and customers via 17 tools; a deterministic feasibility snapshot taken at run start (source: `fleet-backend/src/lib/aiHarness/baseline.ts:69`) | The dispatcher who requested the run, via the AI Lab or the demo's "Ask AI" step (source: `fleet-backend/src/lib/aiHarness/runner.ts:73`, `fleet-backend/src/lib/demoStory/actions.ts:82`) | Recommends only; cannot write a driver assignment or any other record — a human decides (source: `fleet-backend/src/lib/dispatchTools/invoke.ts:1-9`) |
| Night Shift | One committed assignment already on the board, switched on by a dispatcher; GPS pings; a per-load or org "Standard" policy (source: `night-shift/src/live/platformLoads.ts:266`) | The driver (chat link, SMS, call), the dispatcher (email, optional phone), the customer (email, gated by an at-risk deadline) (source: `night-shift/src/core/agent.ts:521-589`) | Acts within its ladder and policy thresholds automatically; in shadow mode every message, call and email — to the driver, the dispatcher or the customer — is only logged, never sent (source: `night-shift/src/core/agent.ts:691-725`) |
| Rules engine | A load, a driver, a tractor, a trailer, and the driver's hours-of-service (HOS) clocks | Both other capabilities: the Dispatch Assistant reads its ranked output as its only feasible-driver source; the real assignment a dispatcher commits is checked by the same engine (source: `fleet-backend/src/lib/suggestForLoad.ts:70`, `fleet-backend/src/domain/dispatch/evaluate.ts:97`) | Final and deterministic — a block-severity conflict cannot be assigned around by either agent (source: `fleet-backend/src/domain/dispatch/evaluate.ts:1-4`) |

The Dispatch Assistant is advisory only: it can suggest, but every write still goes through the same commit path a dispatcher would use by hand. Night Shift is
supervisory once switched on: it watches and acts on its own within its policy's thresholds, but a dispatcher can silence, correct, or take over it at any
moment through the commands in Section 4. The rules engine sits underneath both, and neither agent has a way to write around a block-severity conflict it
raises.

## 3. Dispatch Assistant

### Trigger

- A run starts only from an explicit human (or demo-scripted) action, never on a schedule.
- A dispatcher starts one from the AI Lab by naming an experiment and a load (source: `fleet-backend/src/routes/dispatcherAiRuns.ts:52`).
- A dispatcher can also batch-run every uncovered load up to a limit of 10 in one call (source: `fleet-backend/src/routes/dispatcherAiRuns.ts:73-93`).
- The demo's "Ask AI" step calls the identical `enqueueRun` function used by the AI Lab (source: `fleet-backend/src/lib/demoStory/actions.ts:82`).
- Each org runs one experiment at a time; up to 10 more wait in that org's own queue, and an 11th request is refused with `QUEUE_FULL` (source:
  `fleet-backend/src/lib/aiHarness/runner.ts:20,91-97`).
- A backend restart leaves any run it was mid-way through stuck at `queued`/`running` in the database; `GET /ai/status` reports these as "orphaned" so a
  dispatcher can cancel and re-run them (source: `fleet-backend/src/lib/aiHarness/runner.ts:178-193`; `fleet-backend/src/routes/dispatcherAi.ts:80-98`).
- An experiment can be retired (`status: archived`) without deleting its past decisions, and its prompt version can only be changed while it has zero recorded
  runs — once it has any, changing it is refused with a `409 HAS_RUNS` (source: `fleet-backend/prisma/schema.prisma:1277`;
  `fleet-backend/src/routes/dispatcherAi.ts:230-239`).

### Inputs and tools

- The model's only source of facts is a read-only manifest of exactly 17 functions, published to the model as JSON Schema (source:
  `fleet-backend/src/lib/dispatchTools/manifest.ts:46-64,189-196`).
- The 17 tool names: `getLoad`, `searchLoads`, `getUncoveredLoads`, `getDriver`, `searchDrivers`, `getAvailableDrivers`, `getDriverAvailability`,
  `getDriverMetrics`, `getDriverHistory`, `getDriverLocationHistory`, `getCustomer`, `getCustomerHistory`, `getCurrentETA`, `getLoadEvents`, `getAgentEvents`,
  `findFeasibleDrivers`, `getDispatchCandidateDetails` (source: `fleet-backend/src/lib/dispatchTools/manifest.ts:46-64`).
- Before any result reaches the model, `projectForModel` strips a hidden `extras` field (the demo's own scenario answer key) from every result, at any depth
  (source: `fleet-backend/src/lib/dispatchTools/invoke.ts:91-111,227-230`).
- `findFeasibleDrivers`'s output is separately compacted to at most 20 feasible and 15 blocked rows, and rounded, so one call cannot exceed the per-result byte
  cap (source: `fleet-backend/src/lib/dispatchTools/invoke.ts:113-217`).
- A `⚡Suggest` snapshot — the same ranking engine's full output for the load — is captured once at run start as a `baseline`, purely for later comparison; the
  model never sees this snapshot directly (source: `fleet-backend/src/lib/aiHarness/baseline.ts:69-84`).
- The same 17-tool manifest is published, unauthenticated by the model but requiring a dispatcher session, at `GET /api/dispatcher/tools`, so the tool catalogue
  can be inspected independently of any run (source: `fleet-backend/src/routes/dispatcherTools.ts:13-15`).
- Every step of a run's own transcript — the system prompt, the user prompt, each assistant turn (with its private "thinking" text kept separate for display
  only), each tool call, each tool result, the final proposal, any error, and any nudge the loop injected — is persisted in order and never edited afterward
  (source: `fleet-backend/src/lib/aiHarness/runStore.ts:18-27`; `fleet-backend/src/lib/aiHarness/loop.ts:28-31`).

### Model and prompts

- Two prompt versions exist side by side, chosen per experiment: `dispatch-v1`, a single free-form recommendation (source:
  `fleet-backend/src/lib/aiHarness/prompts/dispatch-v1.ts:8-25`).
- `dispatch-v2` additionally requires investigating at least two feasible candidates (when two or more exist) and filing a structured
  strengths/weaknesses/unknowns comparison before proposing (source: `fleet-backend/src/lib/aiHarness/prompts/dispatch-v2.ts:225-260`).
- Both versions are resolved through one profile table; a `promptVersion` not in that table ends the run before any model call rather than guessing (source:
  `fleet-backend/src/lib/aiHarness/prompts/index.ts:47-60`; `fleet-backend/src/lib/aiHarness/loop.ts:146-181`).
- Per-experiment model settings — model name, temperature, context window, turn/tool-call/byte caps, timeouts — live in `AiExperiment.config`, a free-form JSON
  column merged over a fixed default (source: `fleet-backend/prisma/schema.prisma:1277-1282`; `fleet-backend/src/lib/aiHarness/config.ts:10-36`).
- The only model backend wired up is Ollama, a locally-hosted model server; the shipped default model is `qwen3:8b` (source:
  `fleet-backend/src/lib/aiHarness/config.ts:26`; `fleet-backend/src/lib/aiHarness/ollamaAdapter.ts:145-179`).
- The whole `/ai/*` surface, including the AI Lab UI's own status panel, answers 404 unless the `OLLAMA_URL` environment variable is set (`harnessEnabled()`),
  checked fresh on every request rather than once at startup (source: `fleet-backend/src/lib/aiHarness/config.ts:70-76`;
  `fleet-backend/src/routes/dispatcherAi.ts:41-50`).
- Without `OLLAMA_URL`, the demo's own AI-recommendation step silently falls back to the deterministic `⚡Suggest` recommendation and says so on the presenter
  card (source: `fleet-backend/src/lib/demoStory/observe.ts:66-117`).
- The AI Lab's own status panel runs a live preflight check against the configured Ollama server — whether it answers at all, its version, and whether the
  configured model has actually been pulled there — rather than assuming a URL being set means the model is ready (source:
  `fleet-backend/src/lib/aiHarness/ollamaAdapter.ts:191-235`; `fleet-backend/src/routes/dispatcherAi.ts:80-98`).

### Output

- The model ends a run by calling one terminal tool, `propose_decision`, exactly once: a driver id (or `null`), a reason of 20–2000 characters, a confidence
  from 0 to 1, and up to 3 alternatives (source: `fleet-backend/src/lib/aiHarness/decision.ts:13-79`).
- `dispatch-v2` additionally checks confidence against how many unresolved unknowns the chosen driver's own comparison entry carries: 0.90+ confidence requires
  none, 0.70+ requires fewer than three (source: `fleet-backend/src/lib/aiHarness/protocol.ts:322-336`).
- Every proposal's supporting evidence — which tools ran, which drivers were actually inspected, every feasibility row seen, which tool results actually mention
  the recommended driver — is reconstructed after the fact purely from the run's own persisted transcript, never from the model's prose (source:
  `fleet-backend/src/lib/aiHarness/evidence.ts:193-222`).
- A run ends with exactly one termination reason: `proposed`, `no_decision`, `max_turns`, `max_tool_calls`, `repeated_calls`, `consecutive_invalid`,
  `tool_bytes_exceeded`, `timeout`, `model_error`, `cancelled`, or `internal_error` (source: `fleet-backend/src/lib/aiHarness/loop.ts:33-50`).

### Guardrails

- A recommended or alternative driver who does not exist in the org, or who is not in that run's own feasible set, is rejected before it can be persisted — the
  model is told exactly which id failed and why, and may retry (source: `fleet-backend/src/lib/aiHarness/decision.ts:149-167,197-210`).
- Every tool in the manifest is read-only by construction, and the loop itself "never calls `applyLoadChange`, never touches assignments/loads/drivers" (source:
  `fleet-backend/src/lib/aiHarness/loop.ts:28-31`; `fleet-backend/src/lib/dispatchTools/invoke.ts:1-9`).
- Loop protection caps tool calls (default 30), consecutive invalid calls (default 3), identical repeated calls (fixed at 3), and total tool-result bytes
  (default 64 KB); each cap ends the run with its own named reason, checked in a fixed order so the outcome is deterministic (source:
  `fleet-backend/src/lib/aiHarness/config.ts:24-36`; `fleet-backend/src/lib/aiHarness/loopGuards.ts:16-39`).
- A run also carries a wall-clock deadline (`maxRunMs`, default 10 minutes) and a per-model-call timeout, both enforced by racing the actual model call against
  a timer, not just trusting it to answer in time (source: `fleet-backend/src/lib/aiHarness/config.ts:24-36`;
  `fleet-backend/src/lib/aiHarness/loopGuards.ts:69-143`).
- If a single model call's prompt tokens pass 85% of the configured context window, the run is flagged `contextPressure` so a run whose context was silently
  truncated by Ollama is visible rather than silently wrong (source: `fleet-backend/src/lib/aiHarness/loop.ts:66-74`).
- Every run's stats record how many model calls and tool calls it made, how many distinct tools it used, how many calls repeated or were invalid, token counts,
  and how many of the load's own feasible candidates it actually investigated — recorded for every run, whether or not the prompt version enforces a minimum on
  that last number (source: `fleet-backend/src/lib/aiHarness/loop.ts:54-81`).

### Authority and hand-off

- The Dispatch Assistant never creates an assignment itself.
- A dispatcher who accepts its recommendation still calls the ordinary assignment endpoint, `POST /api/dispatcher/assignments`, which re-runs the full rules
  engine against the chosen driver/tractor/trailer independently of anything the model said (source:
  `fleet-backend/src/routes/dispatcherAssignments.ts:232-330`).
- A separate endpoint, `POST /api/dispatcher/ai/runs/:id/decision`, records the dispatcher's verdict (`accept` / `reject` / `other`) onto
  `AiDecisionRecord.humanDecision` — this is metadata about the run, not part of committing the assignment (source:
  `fleet-backend/src/routes/dispatcherAiRuns.ts:171-217`).
- Only the scripted demo path wires these two together automatically, setting `humanDecision` at the moment its own assignment call succeeds (source:
  `fleet-backend/src/lib/demoStory/actions.ts:113-122`) — see Gap 5.

### Completion

- `AiDecisionRecord.status` is one of `queued`, `running`, `proposed`, `incomplete`, `failed`, or `cancelled` (source:
  `fleet-backend/prisma/schema.prisma:1321`).
- `incomplete` covers every abnormal ending except a genuine failure (`model_error`/`timeout`/`internal_error`, which become `failed`) or an explicit
  `cancelled` (source: `fleet-backend/src/lib/aiHarness/loopGuards.ts:41-52`).
- A run can be replayed (re-enqueued against the same load, linked by `parentRunId`) once it has stopped moving on its own (source:
  `fleet-backend/src/routes/dispatcherAiRuns.ts:219-241`).

### Status vocabulary for the UI

No such fixed vocabulary exists in the product today (see Gap 9); the following is this document's own proposal, derived from state the backend already exposes:

- **Not configured** — `harnessEnabled()` is false, i.e. `OLLAMA_URL` is unset (source: `fleet-backend/src/lib/aiHarness/config.ts:74-76`).
- **Ready** — enabled, with an empty queue for the org (source: `fleet-backend/src/lib/aiHarness/runner.ts:68-71`).
- **Thinking** — a run's status is `queued` or `running`.
- **Proposed** — a run's status is `proposed`.
- **Failed** — a run's status is `failed`, `incomplete`, or `cancelled` (source: `fleet-backend/src/lib/aiHarness/loop.ts:52`).

## 4. Night Shift

### Trigger

- Night Shift never starts itself. A dispatcher switches an agent on for a specific load through `POST /api/dispatcher/loads/:id/agent`, which sets
  `agentEnabled: true` and the board pill to `watching` inside one transaction (source: `fleet-backend/src/routes/dispatcherNightShift.ts:210-247`;
  `fleet-backend/src/lib/agentSwitch.ts:38-70`).
- Once a minute, the worker asks the database for every `agentEnabled` load it is not already watching (source:
  `night-shift/src/live/platformLoads.ts:342-358`).
- A load already `delivered` or `off` is skipped — the worker never auto-restarts a finished or switched-off load (source:
  `night-shift/src/live/platformLoads.ts:354`).
- Eligible loads are grouped by org so each org's policy table is read once per tick, not once per load (source:
  `night-shift/src/live/platformLoads.ts:360-390`).
- A load only actually starts once `buildBrief` can resolve it: a pickup and a delivery stop, both geocoded, both with an appointment window, and a phone number
  for the driver or, failing that, the carrier (source: `night-shift/src/live/platformLoads.ts:186-229`).
- Any failure to start — an unresolvable brief, or a policy that cannot be found — writes an `attention` pill and an `AgentUpdate` line explaining why, and is
  retried on the next poll; one bad load never blocks the rest of the tick (source: `night-shift/src/live/platformLoads.ts:279-285,364-390`).

### Inputs

- `buildBrief`/`buildContext` assemble the trip's brief from the load's stops, appointment windows, hazmat/commodity/customer notes, and the driver's hours
  (source: `night-shift/src/live/platformLoads.ts:186-259`).
- Because an `Assignment`'s hours-of-service fields are already debited by the plan it committed, `clocksAtRunStart` inverts that debit before the brief is
  built: it prefers a real post-commit hours import, else the assignment's own pre-commit snapshot, else a best-effort arithmetic restore — so the trip opens
  with the hours the driver actually had at departure, not hours already spent twice (source: `night-shift/src/live/platformLoads.ts:73-120`).
- Location updates arrive as GPS pings, fed to every running trip on each tick (source: `night-shift/src/live/platformPings.ts`;
  `night-shift/src/live/worker.ts:97-114`).
- Every trip's behavior is governed by a policy: the load's own assigned policy, or the org's "Standard" policy as fallback — a load whose policy cannot be
  resolved at all fails to start (source: `night-shift/src/live/platformLoads.ts:266-277`).
- A policy's fields — `stopMin`, `delayMin`, `darkMin`, `darkAtStopMin`, `offRouteMi`, `offRouteMin`, `rungGapMin`, `maxCalls`, `dispatcherEmail`,
  `dispatcherPhone`, `customerEmailOn`, `shadow`, `bossCallOn`, `quietFrom`, `quietTo` — mirror the database `AgentPolicy` row field-for-field, by design
  (source: `night-shift/src/core/policy.ts:1-53`).
- A brand-new "Standard" policy defaults to `shadow: true` in both the database default and the code's own default object, so an org's agent runs as a rehearsal
  — plan, detect, climb the ladder, log every line it would have sent — until a dispatcher reviews the log and turns shadow off (source:
  `fleet-backend/prisma/schema.prisma:1021`; `night-shift/src/core/policy.ts:55-85`).

### Detection rules

Four deterministic rules run every tick, each returning named evidence or nothing — no rule ever guesses (source: `night-shift/src/core/detect.ts:1-4`):

- **Unplanned stop** — stationary for `policy.stopMin` minutes (15 by default), away from every planned stop and every registered rest/fuel stop (source:
  `night-shift/src/core/detect.ts:18-52`; default in `night-shift/src/core/policy.ts:66`).
- **Delay** — the live ETA is past the deadline, or more than `policy.delayMin` minutes (30 by default) behind the plan line (source:
  `night-shift/src/core/detect.ts:63-88`; default in `night-shift/src/core/policy.ts:67`).
- **Gone dark** — no ping for `policy.darkMin` minutes (20 by default), or `policy.darkAtStopMin` (60 by default) if the last ping was at a stop, where a phone
  can lose GPS indoors (source: `night-shift/src/core/detect.ts:93-108`; defaults in `night-shift/src/core/policy.ts:68-69`).
- **Off route** — more than `policy.offRouteMi` miles (3.1 by default) from the route line for at least `policy.offRouteMin` minutes (10 by default) (source:
  `night-shift/src/core/detect.ts:117-138`; defaults in `night-shift/src/core/policy.ts:70-71`).
- Arrival is judged separately from these four, by GPS dwell near the destination (source: `night-shift/src/core/constants.ts:47-49`; see Completion below).
- A fifth, separate case escalates on its own timer rather than a detection rule: a load not accepted by the driver within 30 minutes of its planned departure
  is flagged to attention and escalated once (source: `night-shift/src/core/agent.ts:356-358`; threshold in `night-shift/src/core/constants.ts:52`).
- A demo/pitch-only `NIGHT_SHIFT_TIME_SCALE` environment variable can compress the stop rule and ladder cooldowns for a live demonstration; delay, gone-dark,
  and off-route thresholds are never scaled, since they are "claims about the road, not about patience" (source: `night-shift/src/core/constants.ts:5-25`).

### Communication ladder

- The ladder has rungs 0 through 4 (source: `night-shift/src/core/ladder.ts:7`).
- Rung 1 messages the driver over the chat link.
- Rung 2 falls back to SMS if the link was never opened within 30 minutes, else repeats the chat message (source: `night-shift/src/core/ladder.ts:46-51`;
  `night-shift/src/core/constants.ts:45`).
- Rung 3 calls the driver, retrying up to `policy.maxCalls` times (2 by default; 0 skips calling entirely and escalates straight from rung 2) (source:
  `night-shift/src/core/ladder.ts:52-61`; default in `night-shift/src/core/policy.ts:73`).
- Rung 4 escalates to the dispatcher and stops acting on that anomaly (source: `night-shift/src/core/ladder.ts:62-63`).
- Cooldowns between rungs 0→1 and 1→2 are fixed at 10 and 15 minutes; the gap between call retries at rung 3 is `policy.rungGapMin` (5 minutes by default)
  (source: `night-shift/src/core/constants.ts:42-43`; `night-shift/src/core/ladder.ts:59`; default in `night-shift/src/core/policy.ts:72`).
- The agent tracks one open question per anomaly and closes it the moment any reply arrives, from the driver or from the dispatcher posting on the driver's
  behalf (source: `night-shift/src/core/agent.ts:200-202,262-267`).
- Reply understanding is keyword-based by default: `matchByKeywords` scores a reply's words against a fixed phrase library and requires a whole-word phrase
  match, discarding a below-floor speech-to-text confidence as "unknown" rather than guessing (source: `night-shift/src/core/situations.ts:47-72`;
  `night-shift/src/core/agent.ts:173-189`; floor in `night-shift/src/core/constants.ts:55`).
- A language model is used instead of the keyword classifier whenever the worker process has an `ANTHROPIC_API_KEY` configured — a Claude model, not the Ollama
  harness the Dispatch Assistant uses. It becomes both the reply classifier and the conversation engine for phone calls; the keyword classifier is the fallback
  only when no key is set (source: `night-shift/src/live/worker.ts:63-79`; `night-shift/src/core/agent.ts:180-189`). See Gap 4.
- Three consecutive failed delivery attempts on the same rung (nothing reached the driver at all, e.g. a dead messaging gateway) is itself escalated to the
  dispatcher as its own news, rather than retried forever (source: `night-shift/src/core/constants.ts:67-70`; `night-shift/src/core/agent.ts:509`).

### Who it talks to

- The driver — chat link, SMS, or call — gated by the ladder above (source: `night-shift/src/core/agent.ts:697-716`).
- The dispatcher — always by email, and additionally by a spoken phone briefing when the policy's `bossCallOn` is true (source:
  `night-shift/src/core/agent.ts:521-589`; default in `night-shift/src/core/policy.ts:82`).
- The customer — by email only, and only when the delivery deadline is actually computed to be at risk and a customer email address is on file for the load; the
  draft is attached to the dispatcher's escalation email and is sent only once the dispatcher explicitly instructs "send the customer email," never
  automatically (source: `night-shift/src/core/agent.ts:540-559,209-236`). See Gap 6 on the `customerEmailOn` policy field.
- A customer draft is deliberately withheld (with the dispatcher told why) when the truck's last known position is more than 5 minutes old — a delay claim is
  never written from a stale fix (source: `night-shift/src/core/agent.ts:538-554`; threshold in `night-shift/src/core/constants.ts:38`).
- In shadow mode, every one of `sendText`/`placeCall`/`sendMail` is replaced by a logged "would say" line instead — nobody hears or receives anything (source:
  `night-shift/src/core/agent.ts:691-725`).

### Dispatcher controls

- A dispatcher issues one of `stop`, `call`, `reply`, `correct`, `takeover`, `handback`, `send_customer_email` through `POST
  /api/dispatcher/loads/:id/agent/commands` (source: `fleet-backend/src/routes/dispatcherNightShift.ts:264-283`).
- Each command is written as an `AgentCommand` row and applied by the worker on its next poll, in the order it was written (source:
  `night-shift/src/live/commands.ts:29-59`).
- `stop` also turns the switch off, so a drawer Stop and the board switch always agree (source: `night-shift/src/live/commands.ts:61-76`).
- `takeover`/`handback` mute and resume the ladder's own actions while anomalies are still detected and recorded throughout (source:
  `night-shift/src/live/commands.ts:78-91`; `night-shift/src/core/agent.ts:240-254`).
- `reply` posts the dispatcher's own words to the driver's page and closes whatever question is open, exactly as a driver reply would (source:
  `night-shift/src/live/commands.ts:98-111`).
- `correct` re-labels the trip's last classification for the record only; it does not touch the running agent's state (source:
  `night-shift/src/live/commands.ts:116-135`).

### Records

- `AgentTrip` is one row per trip, holding its brief and status (source: `fleet-backend/prisma/schema.prisma:988-998`).
- `AgentEvent` rows are the full transcript per trip; kinds observed in the code include `ping`, `anomaly`, `action`, `call`, `escalation`, `reply`, `email`,
  `dispatcher_call`, `sheet_write` (source: `fleet-backend/prisma/schema.prisma:1047-1057`; kinds as used throughout `night-shift/src/core/agent.ts`).
- `AgentUpdate` is the board-facing line per load; its documented kinds are `status | eta | delivered | attention | would_say` (source:
  `fleet-backend/prisma/schema.prisma:1059-1071`).
- `Load.agentPill` is one of `off | watching | asked | calling | escalated | delivered | attention | shadow | held` (source:
  `fleet-backend/prisma/schema.prisma:745`; every write site confirmed in `night-shift/src/live/platformSheet.ts:17-27` and
  `night-shift/src/live/commands.ts:74,82,90,109`).

### Completion

- Arrival is GPS dwell within 0.5 miles of the destination, sustained for 5 minutes — the agent's own judgment, independent of any status change elsewhere in
  the system (source: `night-shift/src/core/constants.ts:47-49`).
- Arrival moves the board pill to `delivered` and, if a customer email is on file, either sends an on-time arrival note immediately or drafts a late one for the
  dispatcher to approve (source: `night-shift/src/core/agent.ts:591-629`).
- A dispatcher's `stop` command, or the load's switch being turned off, ends the trip and sets the pill to `off` (source:
  `night-shift/src/live/commands.ts:61-76`; `fleet-backend/src/lib/agentSwitch.ts:47-56`).
- A load that is switched off or reaches `delivered` is also stopped by the worker's own sync pass on its next poll even if no explicit command was ever queued
  (source: `night-shift/src/live/platformLoads.ts:314-340`).

### Status vocabulary for the UI

- The actual pill vocabulary already used on the board is `off | watching | asked | calling | escalated | delivered | attention | shadow | held` — richer than a
  five-value summary (source: `fleet-backend/prisma/schema.prisma:745`).
- Collapsed for a simple status read-out, this document proposes: **Not configured** (`off`, no policy assigned yet); **Watching**
  (`watching`/`asked`/`calling`); **Shadow mode** (`shadow`, or any of the above while the load's `AgentPolicy.shadow` is true); **Needs attention**
  (`attention`/`escalated`/`held`); **Delivered** (`delivered`).
- No such collapsed vocabulary exists in the product today — this mapping is this document's own proposal (see Gap 9).

## 5. Rules engine

- One deterministic function, `evaluate()`, checks a proposed (load, driver, tractor, trailer) combination and produces a plan plus a list of conflicts; it is
  pure — no clock, no database read inside it (source: `fleet-backend/src/domain/dispatch/evaluate.ts:1-4,97-100`).
- The independent checks that exist: equipment match, hazmat endorsement, driver availability, tractor availability, and trailer availability (source:
  `fleet-backend/src/domain/dispatch/checks.ts:17-53`).
- A time-window overlap check is applied separately to the driver, the tractor, and the trailer, so none can be double-booked (source:
  `fleet-backend/src/domain/dispatch/checks.ts:55-72`).
- A full hours-of-service clock walk and break-placement calculation runs alongside the checks above (source:
  `fleet-backend/src/domain/dispatch/evaluate.ts:14-16`; `fleet-backend/src/domain/dispatch/hos.ts`).
- An appointment-timing/compliance check (tight or late arrivals) also runs as part of the same evaluation (source:
  `fleet-backend/src/domain/dispatch/evaluate.ts:14`; `fleet-backend/src/domain/dispatch/compliance.ts`).
- A block-severity conflict makes the pairing infeasible outright; a warn-severity conflict (e.g. a tight arrival) does not (source:
  `fleet-backend/src/domain/dispatch/evaluate.ts:96`).
- `suggestForLoad` runs this same engine against every driver in the org, via `rankOrgDrivers`, to produce the ranked-and-blocked candidate list shown on the
  board and used everywhere else in the product (source: `fleet-backend/src/lib/suggestForLoad.ts:70-133`).
- The Dispatch Assistant's `findFeasibleDrivers` and `getDispatchCandidateDetails` tools call this exact pipeline — the model is never shown a second,
  independent ranking (source: `fleet-backend/src/lib/dispatchTools/manifest.ts:159-162`; `fleet-backend/src/lib/suggestForLoad.ts:6-14`).
- The harness enforces "a model never overrides these checks" in code, not just in the prompt: a proposed or alternative driver id who is not in that run's own
  feasible set is rejected before it can ever be persisted (source: `fleet-backend/src/lib/aiHarness/decision.ts:149-167`).
- Night Shift does not call this engine directly. It starts from an assignment the engine has already approved, and only reuses its lower-level hours-of-service
  and geo-distance math (not the feasibility checks themselves) for its own itinerary and ETA calculations (source: `night-shift/src/domain.ts:21-23`).
- The same `domain/dispatch` folder also holds pricing and compliance-adjacent modules that are not feasibility checks and do not gate whether a driver can be
  assigned — margin/rate economics, fuel-price advice, IFTA (International Fuel Tax Agreement) mileage attribution, and rest-stop option lookups (source:
  `fleet-backend/src/domain/dispatch/economics.ts`, `fuel.ts`, `fuelAdvice.ts`, `iftaAttribution.ts`, `restOptions.ts`, `restConflict.ts`). These are listed
  here only to be precise about what "the rules engine" does and does not include.

## 6. Demo Mode as the reference scenario

- Demo Mode (`/demo`) drives one load, `DEMO-CHI-DET`, end to end through every real system described above — the same rules-engine checks, the same AI harness,
  a real `POST /assignments` call, and Night Shift running in shadow mode (source: `docs/demo-mode.md:3,11-13`).
- A simulated truck stands in only for GPS movement; nothing about the dispatch decision, the assignment commit, or the agent's detection/ladder logic is faked
  (source: `docs/demo-mode.md:3`).
- The demo departs from its original storyboard in two documented ways: the delivery window is tightened at approval so a ten-minute demo can put the
  deadline genuinely at risk (the one thing the demo manipulates), and Night Shift escalates immediately on a breakdown reply — which is Night Shift's real
  behaviour, not a demo shortcut (source: `docs/demo-mode.md:20-25`; `night-shift/src/core/agent.ts`).
- `POST /demo/story/reset` is documented as idempotent and total — it stops the simulation, cancels any AI run, switches the agent off, and purges and recreates
  the demo load/driver/customer/policy/experiment from a known state (source: `docs/demo-mode.md:26-28`).
- Documented safety measures for the demo: every message, call, and email the agent would send is recorded as a `would_say` event and never leaves the process,
  because the demo's own policy is `shadow: true` with `customerEmailOn: false`, `bossCallOn: false`, `maxCalls: 0`; the demo customer's address
  (`demo-customer@example.invalid`) cannot resolve; a driver's reply is proxied only to the worker's own driver-link endpoint; and every demo route is gated
  behind a `DEMO_MODE` flag, a dispatcher session, and the caller's own org (source: `docs/demo-mode.md:34-37`).
- It has run end to end on the production deployment (2026-09-29, 11 minutes from Reset to Delivered) with the AI step on its rules fallback (source:
  `docs/demo-mode.md`, observed timeline).

## 7. Gaps between this specification and the implementation

1. **No unified "AI Agents" status surface exists.** There is no page listing the Dispatch Assistant and Night Shift together with their current status. The AI
   Lab (`/ai-lab`) is a developer console for experiments and runs; `/night-shift` is a policy-configuration screen with Connect/Policies/Usage/Settings tabs,
   not a live status board (source: `fleet-portal/src/router/index.ts:81,92-94`; `fleet-portal/src/views/NightShiftView.vue:11-23`).

2. **No per-load "View agent" panel.** A load's own agent timeline lives only inside the Cockpit's `AgentDrawer`, opened by an in-page click from `CockpitView`
   — there is no dedicated route or standalone page for it (source: `fleet-portal/src/components/agent/AgentDrawer.vue`;
   `fleet-portal/src/components/demo/HowItWorksLinks.vue:13-16`).

3. **The demo's "Night Shift timeline" link is generic, not per-load.** `HowItWorksLinks.vue`'s "Night Shift timeline" link opens the plain `/cockpit` route
   rather than deep-linking to the specific load's drawer, because no such deep link exists yet in the codebase — the component's own comment says so (source:
   `fleet-portal/src/components/demo/HowItWorksLinks.vue:13-16,50`).

4. **Reply understanding is keyword-based only when no language-model key is configured.** The keyword classifier (`matchByKeywords`) is the fallback, not the
   only path: a real language model (Claude, via `ANTHROPIC_API_KEY`) classifies replies and drives phone conversations instead whenever that key is set on the
   worker process — a materially different behavior from "the platform is keyword-based" (source: `night-shift/src/live/worker.ts:63-79`;
   `night-shift/src/core/situations.ts:47-72`; `night-shift/src/core/agent.ts:180-189`).

5. **The Dispatch Assistant's human verdict is not wired into the real assignment flow.** `POST /api/dispatcher/assignments` — the actual, non-demo path a
   dispatcher uses to commit a driver — never writes to `AiDecisionRecord.humanDecision`. That field is set only by the separate AI Lab endpoint `POST
   /api/dispatcher/ai/runs/:id/decision` (which records a verdict without creating an assignment), or by the scripted demo's own action code. A dispatcher who
   accepts an AI recommendation through the ordinary assignment screen leaves no record on the run that it was accepted (source:
   `fleet-backend/src/routes/dispatcherAssignments.ts:232-330` — no `humanDecision` write anywhere in this file;
   `fleet-backend/src/routes/dispatcherAiRuns.ts:184-217`; `fleet-backend/src/lib/demoStory/actions.ts:113-122`).

6. **`AgentPolicy.customerEmailOn` is defined but never read by the agent.** The field exists on the database model and the `Policy` type, and is populated from
   the database into every trip's policy object, but nothing in `night-shift/src/core/agent.ts` checks it before drafting or offering a customer email. The
   actual gate observed in the code is only "deadline at risk and a customer email address is on file" (source: `night-shift/src/core/policy.ts:38-39`;
   `night-shift/src/live/platformLoads.ts:168,274`; no read of this field found anywhere in `night-shift/src/core/agent.ts:521-559` or elsewhere in
   `night-shift/src`). The dispatcher's own explicit "send the customer email" step still gates the actual send either way, so no email escapes automatically as
   a result of this gap.

7. **Shadow is per policy, not a global switch.** The worker serves every agent-enabled load in the org under whichever policy that load is assigned; two loads
   under different policies can run simultaneously, one in shadow and one live, on the same worker process (source: `night-shift/src/live/worker.ts:70-87`;
   `night-shift/src/core/policy.ts:41-45`).

8. **`AgentPolicy.quietFrom`/`quietTo` are defined, editable in the portal, and never enforced.** A dispatcher can set a "do not call or text" window in the
   Night Shift settings screen, and it is carried all the way down into every trip's `Policy` object, but no code in `night-shift/src/core` reads either field
   before sending a message, placing a call, or advancing the ladder — a repository-wide search found no consumer of these two fields anywhere outside their own
   definition, the database mapping, and the portal's settings form (source: `night-shift/src/core/policy.ts:49-52,83-84`;
   `night-shift/src/live/platformLoads.ts:171-172,275`; `fleet-portal/src/views/NightShiftView.vue:63-64,490-499`). This is the same "policy field exists but is
   not read by the agent" pattern as Gap 6.

9. **The status vocabularies in Sections 3 and 4 are this document's own proposal, not existing UI copy.** No fixed set of these labels exists in the frontend
   today; they are derived from state the backend already exposes, to give a buyer a plain-language read-out.

10. **No language model runs in production.** The Render service's environment has no `OLLAMA_URL` and no `ANTHROPIC_API_KEY` (checked against the live
    service configuration on 2026-09-29, not from a file in this repository), so in production the Dispatch Assistant always falls back to the rules
    recommendation and Night Shift always uses the keyword classifier. Both are documented, deliberate states, not failures — but a buyer shown the AI Lab
    locally should know the hosted demo is running without a model.

11. **Resolved on 2026-09-28: the trip-start hours double count.** Night Shift used to read the driver's hours after the assignment had already reserved
    the run, so every trip opened with a false "hours cannot carry this run" escalation. `clocksAtRunStart` now restores the pre-commit clocks (source:
    `night-shift/src/live/platformLoads.ts:73-120`), verified on live trips locally and on the production deployment. Listed here because older notes and
    timelines still show that escalation.
