# AI Agents Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two agents visible and honestly represented: an "AI Agents" page that says what each agent can do right now, a per-load "View agent" summary that says what Night Shift noticed, recommends, did and will do next, deep links to it from the Cockpit URL and the demo, and a demo that keeps the recommendation source visible.

**Architecture:** One new read-only backend endpoint (`GET /api/dispatcher/agents/overview`) and one shared pure derivation module (`lib/agentSummary.ts`) that turns a load's persisted Night Shift events into a plain-language summary; the existing per-load timeline response gains that `summary`, so the overview and the drawer read the same truth. The portal adds an `AgentsView` fed by a small Pinia store, a summary block at the top of the existing `AgentDrawer`, a `?load=` deep link on the Cockpit, and a source badge on the demo rail. Night Shift's core is untouched except one message phrase.

**Tech Stack:** Express 4 + Prisma 5 + zod v3 + vitest on real Postgres (backend); Vue 3 + Pinia options stores + vue-router + vitest/jsdom + @vue/test-utils (portal); Night Shift core TypeScript + vitest (one phrase).

**Spec:** `docs/agents-operating-spec.md` (sections 3–4 status vocabularies, section 7 gaps 1, 2, 3, 6, 8, 9) plus the owner's five requirements below.

## Global Constraints

- **Readiness is separate from functionality.** The Dispatch card must never imply drivers cannot be found without a model. Copy: `Rules available · AI not configured` / `Rules available · AI unreachable` / `Rules available · AI ready`.
- **Mode is separate from activity.** Shadow/Live describes communication permissions (from the load's policy); Watching/Waiting for reply/Escalated/Held/Needs attention/Delivered/Off describes activity. A load shows both, always.
- **Never imply an unenforced permission is enforced.** `customerEmailOn`, `quietFrom`, `quietTo` are stored but never read by the agent (spec gaps 6 and 8). Their controls must be visibly marked `Not enforced yet` and disabled; the overview states it. No enforcement is added in this plan.
- **Honest summaries.** "What happens next" is derived only from persisted state (`Load.agentPill`, `AgentEvent`, `AgentUpdate`). Where the agent's in-memory state is not persisted (ladder timers, open-question key), the copy says so (`nextConfidence: 'inferred' | 'unknown'`), never invents a time.
- **Tenant scoping.** The overview endpoint uses the same org scoping as the other dispatcher routes (`outsideOrg`/`orgWhere` from `src/middleware/orgScope.ts`); it distinguishes an unavailable service (`configured: false`) from an empty workload (`configured: true`, counts 0) in every field.
- **No model change.** Qwen stays optional for dispatch reasoning; Night Shift's Claude path (when `ANTHROPIC_API_KEY` is set) and keyword fallback stay as they are.
- **Do not modify** the dispatch engine, the AI harness loop/prompts, the simulation, the seed, Night Shift detection/ladder logic, or Prisma schema. Night Shift is touched only in `night-shift/src/core/phrases.ts` (Task 9).
- **Presenter copy rule** still applies to demo-facing strings: none of `score`, `rank`, `ranking`, `engine`, `deterministic`, `scenario` (`fleet-backend/tests/demo-story-presenter-copy.test.ts`).
- Coding rules of this repo: no `console.log`; immutable updates; files under 800 lines; every new behaviour test-first; backend ESM imports end in `.js`; portal test ids are kebab-case `data-testid`.
- Implementers never commit; the controller commits after review.

---

## Codebase facts every task relies on

- Backend org scoping: `req.orgScope` (string | null; null = unscoped legacy account) set by `attachOrgScope`; helpers `orgWhere(req)`, `outsideOrg(req, orgId)` in `fleet-backend/src/middleware/orgScope.ts:90-97`. Async handlers are wrapped the way `fleet-backend/src/routes/dispatcherDemoStory.ts` wraps them (copy its `asyncRoute` usage and its `orgOrRefuse` pattern where a required org makes sense).
- Per-load Night Shift data: `GET /api/dispatcher/loads/:id/agent` → `timelineFor(loadId, orgId)` in `fleet-backend/src/lib/agentTimeline.ts:38-68`, response type `AgentTimelineBody` `{ enabled, boardLoadNo, policy: {id, name, …}, pill, line, timeline: AgentTimelineEntry[] }`, entries `{ atMs, kind, text, evidence? }`, newest first, unpaginated.
- `Load.agentPill` values: `off | watching | asked | calling | escalated | delivered | attention | shadow | held` (written by the worker and `agentSwitch.ts`).
- Persisted Night Shift facts (`AgentEvent.kind` + `evidence`): `anomaly {kind, key, …}` and `anomaly {key, resolved: true}`; `action {kind: invite|accepted|departed|message|message_again|sms|respond|takeover|handback|dispatcher_post|arrived|hos_infeasible|loop_error, …}`; `reply {rawText, situationKey, …}`; `escalation {reason, draftAttached, deadlineAtRisk, …}`; `email {kind: customer_delay|customer_arrival|arrival_late_draft|nothing_to_send|echo, to, …}`; `call {…}`; `dispatcher_call {…}`; `would_say {channel, to, text}`; `ping {…}`; `plan {…}`; `sheet_write {…}`. The agent's in-memory `openQuestionKey`, `ladders` and `held` are NOT persisted; only these events and the pill are.
- AI status: `GET /api/dispatcher/ai/status` 404s unless `harnessEnabled()` (`fleet-backend/src/lib/aiHarness/config.ts`); `checkOllama(baseUrl, model, fetchImpl?)` in `fleet-backend/src/lib/aiHarness/ollamaAdapter.ts:200` returns `{ reachable, version, models, modelPresent, error }`; `runnerState(orgId)` in `lib/aiHarness/runner.ts` returns `{ running, queued }`; `DEFAULT_HARNESS_CONFIG.model` is the configured model name; `AiDecisionRecord` has `status, driverId, confidence, proposedAt, completedAt, loadId, experimentId, promptVersion`.
- Worker reachability: the backend only knows `process.env.WORKER_URL` is set; no liveness route exists.
- Portal shell: `fleet-portal/src/layouts/AppShell.vue` nav arrays `TOWER_PRIMARY` (line 51), `TOWER_MORE` (line 67, last entry `{ label: 'AI Lab (dev)', to: '/ai-lab' }`), item shape `{ label, to, icon? }`. Router: `fleet-portal/src/router/index.ts`, static imports, children of the `/` AppShell route. View layout convention: root `<div class="flex flex-col gap-6">`, `<h1 class="text-xl font-semibold text-ink">`, `<p class="text-sm text-ink-2">`, tokens `text-ink`, `text-ink-2`, `bg-surface`, `border-line`, `rounded-lg`.
- Portal Night Shift store: `fleet-portal/src/stores/nightShift.ts` — `AgentForLoad`, `AgentTimelineEntry`, `agentFor(loadId)` (`GET /dispatcher/loads/:id/agent`), `command(loadId, kind, payload)`. Drawer: `fleet-portal/src/components/agent/AgentDrawer.vue` (props `loadId, loadNo?, customerName?, carrierName?, carrierMc?`; injects `nightShiftApi`; `KIND_LABELS` at ~339; timeline list at ~410-461; actions row ~379-384).
- Cockpit: `fleet-portal/src/views/CockpitView.vue` opens the drawer via local `agentDrawerLoadId = ref<string | null>(null)` (line ~155); uses `useRouter()` but never `useRoute()`.
- Demo: portal `fleet-portal/src/stores/demo.ts` (`presenterStages` getter ~205-217, `computeStageAction` ~109-155), `types/demo.ts` (`DemoLinks { cockpitLoadId, aiRunId, driverId, agentTimelineLoadId }`, `DemoStory.recommendationSource: 'ai' | 'engine' | null`, `PresenterStageView`), `components/demo/HowItWorksLinks.vue` (props `aiRunId, log`; "Night Shift timeline" hardcoded to `/cockpit`), `StageRail.vue` (renders `stage.title`), `views/DemoView.vue`. Backend `fleet-backend/src/lib/demoStory/types.ts` `STAGES` (~42-53) — `ai_recommendation` card title `AI recommendation`.
- Night Shift settings: `fleet-portal/src/views/NightShiftView.vue` — `toggle-customer-email` switch (~427-439), `policy-quiet-from`/`policy-quiet-to` time inputs (~488-503), `toggle-boss-call` (~470-483), `choose-shadow`/`choose-live` buttons.
- Test conventions: backend `tests/helpers.ts` exports `app`, `resetDb`, `createDriver`, `createDispatcher`, `loginDispatcher`; copy `tests/night-shift-routes.test.ts` (seedOrg + `signDispatcherAccess`). Portal view specs mock the store module (`vi.mock('../stores/demo', …)`) and mount with a memory router; store specs use `setActivePinia(createPinia())` and `vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }))`.
- The "-4 minutes behind" phrase: `night-shift/src/core/phrases.ts:55`, `case "delay"`, interpolates `ev.behindMin` (signed; anomaly evidence also carries `behindPlan: boolean`).

---

### Task 1: Shared agent summary derivation (backend, pure)

**Files:**
- Create: `fleet-backend/src/lib/agentSummary.ts`
- Test: `fleet-backend/tests/agent-summary.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgentActivity = 'off' | 'watching' | 'waiting_reply' | 'escalated' | 'held' | 'attention' | 'delivered';
  export type AgentMode = 'off' | 'shadow' | 'live';
  export interface AgentSummaryInput {
    enabled: boolean;
    pill: string;                 // Load.agentPill
    policyShadow: boolean | null; // null = no policy resolved
    attentionLine: string | null; // newest AgentUpdate of kind "attention", or null
    events: { atMs: number; kind: string; evidence: unknown; actionTaken: string | null }[]; // any order
    nowMs: number;
  }
  export interface AgentSummary {
    mode: AgentMode;
    activity: AgentActivity;
    noticed: string | null;       // newest unresolved anomaly, plain words
    recommends: string | null;    // newest escalation reason (+ " A customer note is drafted." when draftAttached)
    done: string[];               // newest-first, max 5: messages/calls/emails/would_say lines
    next: string;                 // plain sentence
    nextConfidence: 'known' | 'inferred' | 'unknown';
    lastEventAt: number | null;   // max atMs, or null
  }
  export function deriveAgentSummary(input: AgentSummaryInput): AgentSummary;
  ```

Rules the function implements (each is one test):
1. `enabled === false` or `pill === 'off'` → `mode 'off'`, `activity 'off'`, `next = "Night Shift is switched off for this load."`, `nextConfidence 'known'`.
2. `mode` = `'shadow'` when `policyShadow === true`, `'live'` when `false`, `'off'` when null and not enabled; when enabled but `policyShadow === null` → `'shadow'` is NOT assumed: use `'live'` only if `policyShadow === false`; otherwise `'shadow'`? No — unknown policy must not claim either: return `mode 'off'`-style honesty is wrong too. Decision: `policyShadow === null && enabled` → `mode: 'shadow'` is forbidden; add a fourth value is over-engineering, so treat as `'live'` **only** when explicitly `false`; `null` → `'shadow'` **and** `next` prefixed with `"Policy unknown — "`. (Test asserts the prefix.)
3. `pill === 'delivered'` or newest `action` event with `evidence.kind === 'arrived'` → `activity 'delivered'`, `next = "Delivered. Night Shift recorded the arrival; nothing more will be sent."`, `'known'`.
4. `pill === 'held'` or newest of {`takeover`, `handback`} actions is `takeover` → `activity 'held'`, `next = "You have taken over. Night Shift keeps recording but sends nothing until you hand back."`, `'known'`.
5. Newest `escalation` event with no later `reply` or `resolved: true` anomaly after it → `activity 'escalated'`, `recommends` = its `reason` (+ draft sentence), `next = "Escalated to dispatch. It is your decision now; Night Shift will not re-ask the driver about this."`, `'known'`.
6. Newest outbound question (`action` with `evidence.kind` in `message | message_again | sms`, or `call`) with no later `reply` → `activity 'waiting_reply'`, `next = "Waiting for the driver's reply. Night Shift re-asks after its cooldown; the exact time is not recorded here."`, `'inferred'`.
7. `pill === 'attention'` → `activity 'attention'`, `next = attentionLine ?? "Night Shift could not start or continue; see the timeline."`, `'known'` when attentionLine present else `'inferred'`.
8. Otherwise enabled → `activity 'watching'`; if `lastEventAt` is null or older than 3 minutes → `next = "Watching. No report from Night Shift in the last N minutes — it checks once a minute, so it may be down."` with `'unknown'`; else `next = "Watching. Next check within a minute."`, `'known'`.
9. `noticed` = newest `anomaly` event whose `key` has no later `anomaly {resolved: true}` with the same key → its `actionTaken` text if present else `kind` mapped: `unplanned_stop → "Unplanned stop"`, `delay → "Running late"`, `gone_dark → "No GPS for a while"`, `off_route → "Off the planned route"`; null when none.
10. `done` = newest-first lines for `action(message|message_again|sms|respond)` and `would_say` events formatted `"<Sent|Would have sent> <channel>: <text>"`, plus `"Called the driver"`/`"Called the driver (answered)"` for `call` events and `"Emailed <to>: <subject>"` for `email` events; max 5. (Amended after review: one format string did not fit calls and emails.)

- [ ] **Step 1: Write the failing tests** — `fleet-backend/tests/agent-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveAgentSummary, type AgentSummaryInput } from "../src/lib/agentSummary.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const base = (over: Partial<AgentSummaryInput> = {}): AgentSummaryInput => ({
  enabled: true, pill: "watching", policyShadow: true, attentionLine: null, events: [], nowMs: NOW, ...over,
});
const ev = (atMs: number, kind: string, evidence: unknown, actionTaken: string | null = null) => ({ atMs, kind, evidence, actionTaken });

describe("deriveAgentSummary", () => {
  it("switched off", () => {
    const s = deriveAgentSummary(base({ enabled: false, pill: "off" }));
    expect(s).toMatchObject({ mode: "off", activity: "off", nextConfidence: "known" });
    expect(s.next).toBe("Night Shift is switched off for this load.");
  });
  it("mode follows the policy, activity does not", () => {
    expect(deriveAgentSummary(base({ policyShadow: false })).mode).toBe("live");
    expect(deriveAgentSummary(base({ policyShadow: true })).mode).toBe("shadow");
    const unknown = deriveAgentSummary(base({ policyShadow: null }));
    expect(unknown.next.startsWith("Policy unknown — ")).toBe(true);
  });
  it("delivered wins over everything", () => {
    const s = deriveAgentSummary(base({ pill: "delivered", events: [ev(NOW - 60_000, "escalation", { reason: "x", draftAttached: false })] }));
    expect(s.activity).toBe("delivered");
    expect(s.nextConfidence).toBe("known");
  });
  it("taken over", () => {
    const s = deriveAgentSummary(base({ pill: "held", events: [ev(NOW - 30_000, "action", { kind: "takeover" }, "taken over")] }));
    expect(s.activity).toBe("held");
    expect(s.next).toContain("hand back");
  });
  it("escalated with a drafted customer note", () => {
    const s = deriveAgentSummary(base({ pill: "escalated", events: [
      ev(NOW - 300_000, "action", { kind: "message", channel: "chat", text: "Is everything OK?" }, "message"),
      ev(NOW - 120_000, "reply", { rawText: "Engine warning", situationKey: "breakdown" }),
      ev(NOW - 119_000, "escalation", { reason: "driver reports: Driver reports a breakdown.", draftAttached: true, deadlineAtRisk: true }),
    ] }));
    expect(s.activity).toBe("escalated");
    expect(s.recommends).toBe("driver reports: Driver reports a breakdown. A customer note is drafted.");
    expect(s.nextConfidence).toBe("known");
  });
  it("waiting for a reply is inferred, never timed", () => {
    const s = deriveAgentSummary(base({ pill: "asked", events: [
      ev(NOW - 90_000, "anomaly", { kind: "unplanned_stop", key: "unplanned_stop@1" }, "unplanned stop"),
      ev(NOW - 60_000, "action", { kind: "message", channel: "chat", text: "You've been stopped 2 min. Everything OK?" }, "message"),
    ] }));
    expect(s.activity).toBe("waiting_reply");
    expect(s.nextConfidence).toBe("inferred");
    expect(s.next).not.toMatch(/\d+ ?min/);
    expect(s.noticed).toBe("unplanned stop");
  });
  it("a reply closes the question; a resolved anomaly clears what it noticed", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 90_000, "anomaly", { kind: "delay", key: "delay" }),
      ev(NOW - 80_000, "action", { kind: "message", channel: "chat", text: "Late?" }, "message"),
      ev(NOW - 70_000, "reply", { rawText: "traffic", situationKey: "traffic" }),
      ev(NOW - 10_000, "anomaly", { key: "delay", resolved: true }, "resolved on its own"),
      ev(NOW - 5_000, "ping", {}),
    ] }));
    expect(s.activity).toBe("watching");
    expect(s.noticed).toBeNull();
    expect(s.next).toBe("Watching. Next check within a minute.");
  });
  it("attention uses the board line when there is one", () => {
    const s = deriveAgentSummary(base({ pill: "attention", attentionLine: "ATTENTION — no driver or carrier phone on file" }));
    expect(s.activity).toBe("attention");
    expect(s.next).toBe("ATTENTION — no driver or carrier phone on file");
    expect(s.nextConfidence).toBe("known");
  });
  it("silence is reported as uncertainty, not as watching", () => {
    const s = deriveAgentSummary(base({ events: [ev(NOW - 10 * 60_000, "ping", {})] }));
    expect(s.nextConfidence).toBe("unknown");
    expect(s.next).toContain("10 minutes");
  });
  it("done lists sends and would-have-sent lines, newest first, max five", () => {
    const events = Array.from({ length: 7 }, (_, i) => ev(NOW - (7 - i) * 1000, "would_say", { channel: "chat", to: "+1", text: `msg ${i}` }));
    const s = deriveAgentSummary(base({ events }));
    expect(s.done).toHaveLength(5);
    expect(s.done[0]).toBe("Would have sent chat: msg 6");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd fleet-backend && npx vitest run tests/agent-summary.test.ts` → FAIL: cannot find module `../src/lib/agentSummary.js`.

- [ ] **Step 3: Implement** `fleet-backend/src/lib/agentSummary.ts` (pure, no Prisma import):

```ts
// Night Shift's persisted facts → one plain-language summary. Shared by the
// per-load timeline (GET /loads/:id/agent) and the AI Agents overview so the
// drawer and the overview can never disagree. The worker's in-memory ladder
// timers and open-question key are NOT persisted, so anything about "when"
// is marked inferred/unknown rather than invented.
export type AgentActivity = "off" | "watching" | "waiting_reply" | "escalated" | "held" | "attention" | "delivered";
export type AgentMode = "off" | "shadow" | "live";
export interface AgentSummaryEvent { atMs: number; kind: string; evidence: unknown; actionTaken: string | null }
export interface AgentSummaryInput {
  enabled: boolean; pill: string; policyShadow: boolean | null; attentionLine: string | null;
  events: AgentSummaryEvent[]; nowMs: number;
}
export interface AgentSummary {
  mode: AgentMode; activity: AgentActivity; noticed: string | null; recommends: string | null;
  done: string[]; next: string; nextConfidence: "known" | "inferred" | "unknown"; lastEventAt: number | null;
}

const SILENCE_MS = 3 * 60_000;
const QUESTION_KINDS = new Set(["message", "message_again", "sms"]);
const DONE_ACTION_KINDS = new Set(["message", "message_again", "sms", "respond"]);
const ANOMALY_WORDS: Record<string, string> = {
  unplanned_stop: "Unplanned stop", delay: "Running late", gone_dark: "No GPS for a while", off_route: "Off the planned route",
};

const rec = (e: unknown): Record<string, unknown> => (e && typeof e === "object" ? (e as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function deriveAgentSummary(input: AgentSummaryInput): AgentSummary {
  const events = [...input.events].sort((a, b) => b.atMs - a.atMs); // newest first
  const lastEventAt = events.length ? events[0].atMs : null;
  const done = doneLines(events);
  const noticed = noticedLine(events);
  const off = !input.enabled || input.pill === "off";
  const mode: AgentMode = off ? "off" : input.policyShadow === false ? "live" : "shadow";
  const policyPrefix = !off && input.policyShadow === null ? "Policy unknown — " : "";

  if (off) return { mode, activity: "off", noticed, recommends: null, done, next: "Night Shift is switched off for this load.", nextConfidence: "known", lastEventAt };

  const newestAction = (kinds: Set<string>) => events.find((e) => e.kind === "action" && kinds.has(String(rec(e.evidence).kind)));
  if (input.pill === "delivered" || newestAction(new Set(["arrived"]))) {
    return { mode, activity: "delivered", noticed, recommends: null, done, next: policyPrefix + "Delivered. Night Shift recorded the arrival; nothing more will be sent.", nextConfidence: "known", lastEventAt };
  }
  const supervision = newestAction(new Set(["takeover", "handback"]));
  if (input.pill === "held" || (supervision && rec(supervision.evidence).kind === "takeover")) {
    return { mode, activity: "held", noticed, recommends: null, done, next: policyPrefix + "You have taken over. Night Shift keeps recording but sends nothing until you hand back.", nextConfidence: "known", lastEventAt };
  }
  const escalation = events.find((e) => e.kind === "escalation");
  if (escalation && !events.some((e) => e.atMs > escalation.atMs && (e.kind === "reply" || (e.kind === "anomaly" && rec(e.evidence).resolved === true)))) {
    const ev = rec(escalation.evidence);
    const recommends = (str(ev.reason) ?? "Escalated to dispatch.") + (ev.draftAttached === true ? " A customer note is drafted." : "");
    return { mode, activity: "escalated", noticed, recommends, done, next: policyPrefix + "Escalated to dispatch. It is your decision now; Night Shift will not re-ask the driver about this.", nextConfidence: "known", lastEventAt };
  }
  const question = events.find((e) => (e.kind === "action" && QUESTION_KINDS.has(String(rec(e.evidence).kind))) || e.kind === "call");
  if (question && !events.some((e) => e.kind === "reply" && e.atMs > question.atMs)) {
    return { mode, activity: "waiting_reply", noticed, recommends: null, done, next: policyPrefix + "Waiting for the driver's reply. Night Shift re-asks after its cooldown; the exact time is not recorded here.", nextConfidence: "inferred", lastEventAt };
  }
  if (input.pill === "attention") {
    return { mode, activity: "attention", noticed, recommends: null, done, next: policyPrefix + (input.attentionLine ?? "Night Shift could not start or continue; see the timeline."), nextConfidence: input.attentionLine ? "known" : "inferred", lastEventAt };
  }
  if (lastEventAt === null || input.nowMs - lastEventAt > SILENCE_MS) {
    const minutes = lastEventAt === null ? null : Math.round((input.nowMs - lastEventAt) / 60_000);
    const gap = minutes === null ? "since it was switched on" : `in the last ${minutes} minutes`;
    return { mode, activity: "watching", noticed, recommends: null, done, next: policyPrefix + `Watching. No report from Night Shift ${gap} — it checks once a minute, so it may be down.`, nextConfidence: "unknown", lastEventAt };
  }
  return { mode, activity: "watching", noticed, recommends: null, done, next: policyPrefix + "Watching. Next check within a minute.", nextConfidence: "known", lastEventAt };
}

function noticedLine(events: AgentSummaryEvent[]): string | null {
  const resolvedKeys = new Set(events.filter((e) => e.kind === "anomaly" && rec(e.evidence).resolved === true).map((e) => String(rec(e.evidence).key)));
  const open = events.find((e) => e.kind === "anomaly" && rec(e.evidence).resolved !== true && !resolvedKeys.has(String(rec(e.evidence).key)));
  if (!open) return null;
  const kind = String(rec(open.evidence).kind ?? "");
  return open.actionTaken ?? ANOMALY_WORDS[kind] ?? kind;
}

function doneLines(events: AgentSummaryEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const ev = rec(e.evidence);
    if (e.kind === "would_say") lines.push(`Would have sent ${String(ev.channel ?? "message")}: ${String(ev.text ?? "")}`);
    else if (e.kind === "action" && DONE_ACTION_KINDS.has(String(ev.kind))) lines.push(`Sent ${String(ev.channel ?? "message")}: ${String(ev.text ?? "")}`);
    else if (e.kind === "call") lines.push(ev.answered === true ? "Called the driver (answered)" : "Called the driver");
    else if (e.kind === "email") lines.push(`Emailed ${String(ev.to ?? "")}: ${String(ev.subject ?? ev.kind ?? "")}`);
    if (lines.length === 5) break;
  }
  return lines;
}
```
(Note for the implementer: the resolved-anomaly rule in `noticedLine` intentionally treats a later `resolved: true` for the same key as closing it even though the array is newest-first — build `resolvedKeys` from all events first, as written.)

- [ ] **Step 4: Run tests** → all pass. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Report** (controller commits).

---

### Task 2: Summary on the per-load timeline response

**Files:**
- Modify: `fleet-backend/src/lib/agentTimeline.ts` (add `summary` to `AgentTimelineBody`, computed by `deriveAgentSummary`)
- Test: `fleet-backend/tests/night-shift-routes.test.ts` (extend the existing `GET /loads/:id/agent` test) or a new `tests/agent-timeline-summary.test.ts`

**Interfaces:**
- Consumes: `deriveAgentSummary` (Task 1).
- Produces: `AgentTimelineBody.summary: AgentSummary` — the portal (Task 5) reads `summary.mode`, `summary.activity`, `summary.noticed`, `summary.recommends`, `summary.done`, `summary.next`, `summary.nextConfidence`.

- [ ] **Step 1: Failing test** — seed an org, a load with `agentEnabled: true`, `agentPill: "asked"`, a policy with `shadow: true`, an `AgentTrip` with events (`anomaly unplanned_stop`, then `action message`), request `GET /api/dispatcher/loads/:id/agent` with a bearer token and assert:

```ts
expect(res.status).toBe(200);
expect(res.body.summary).toMatchObject({ mode: "shadow", activity: "waiting_reply", nextConfidence: "inferred" });
expect(res.body.summary.noticed).toBe("unplanned stop"); // the anomaly's actionTaken text in the fixture
```
Also one assertion for a switched-off load: `summary.activity === "off"`.

- [ ] **Step 2: Run** → FAIL (`summary` undefined).

- [ ] **Step 3: Implement** — in `timelineFor`, after the existing merge, build the input from data already loaded (`load.agentEnabled`, `load.agentPill`, `policy?.shadow ?? null`, newest `AgentUpdate` with `kind === "attention"` → `attentionLine`, the trip's `AgentEvent` rows mapped to `{ atMs: Number(e.atMs), kind, evidence, actionTaken }`, `nowMs: Date.now()`) and add `summary: deriveAgentSummary(input)` to the returned body. Do not change any existing field. Keep the file under 800 lines; if `timelineFor` grows past ~60 lines, extract `summaryInputFrom(load, policy, updates, events, nowMs)`.

- [ ] **Step 4: Run** the test file, then the full backend suite once; `npx tsc --noEmit`.

- [ ] **Step 5: Report.**

---

### Task 3: `GET /api/dispatcher/agents/overview`

**Files:**
- Create: `fleet-backend/src/routes/dispatcherAgents.ts`
- Create: `fleet-backend/src/lib/agentsOverview.ts` (query + shaping; the route stays thin)
- Modify: `fleet-backend/src/app.ts` (mount the router next to the other dispatcher routers, same auth middleware)
- Test: `fleet-backend/tests/agents-overview.test.ts`

**Interfaces:**
- Consumes: `harnessEnabled`, `DEFAULT_HARNESS_CONFIG`, `checkOllama`, `runnerState` (aiHarness); `deriveAgentSummary` (Task 1); `orgWhere`/`req.orgScope`.
- Produces (portal Task 4 depends on this exact shape):

```ts
export interface AgentsOverview {
  generatedAt: string; // ISO
  dispatch: {
    rules: { available: true };                      // always true: the rules engine has no external dependency
    model: {
      configured: boolean;                            // OLLAMA_URL set
      reachable: boolean | null;                      // null when not configured
      modelPresent: boolean | null;
      model: string | null;                           // configured model name when configured
      error: string | null;
    };
    activity: {
      running: { runId: string; loadId: string | null; startedAt: string | null } | null;
      queued: number;
      lastRun: { runId: string; loadId: string | null; status: string; driverId: string | null; driverName: string | null; confidence: number | null; completedAt: string | null; promptVersion: string | null } | null;
    };
  };
  nightShift: {
    service: { configured: boolean; lastActivityAt: string | null };  // WORKER_URL set; newest AgentEvent/AgentUpdate in the org
    activity: { watching: number; waitingReply: number; escalated: number; held: number; attention: number; delivered: number; off: number; total: number };
    mode: { shadowLoads: number; liveLoads: number; livePolicies: number };
    enforcement: { customerEmailOn: "not_enforced"; quietHours: "not_enforced" };
    loads: Array<{ loadId: string; boardLoadNo: string | null; pill: string; mode: "shadow" | "live" | "off"; activity: string; next: string; nextConfidence: "known" | "inferred" | "unknown"; lastEventAt: string | null }>; // enabled loads only, ordered: attention/escalated first, then waiting_reply, then the rest by lastEventAt desc, max 25
  };
}
```

Behaviour:
- Route: `dispatcherAgentsRouter.get("/agents/overview", asyncRoute(async (req, res) => …))` under the dispatcher auth like `dispatcherNightShift.ts`. Tenant: `orgWhere(req)` on every query; an unscoped account (`req.orgScope === null`) sees all orgs (same as the rest of the app).
- `dispatch.model`: if `!harnessEnabled()` → `{ configured: false, reachable: null, modelPresent: null, model: null, error: null }`; else call `checkOllama(process.env.OLLAMA_URL!, DEFAULT_HARNESS_CONFIG.model)` and map. `activity.running/queued` from `runnerState(orgId)` when `req.orgScope` is set (else `{ running: null, queued: 0 }`); `lastRun` = newest `AiDecisionRecord` by `proposedAt` in scope with `status` not in `queued|running`, driver name joined.
- `nightShift.service.configured = Boolean(process.env.WORKER_URL)`; `lastActivityAt` = max of newest `AgentEvent.atMs` (through trips of loads in scope) and newest `AgentUpdate.atMs`.
- Per enabled load (where `agentEnabled: true` OR `agentPill !== 'off'`): load `{ id, boardLoadNo, agentPill, agentEnabled, agentPolicy: { shadow } }`, its newest `attention` update, and the newest trip's events (bounded: last 200 by `atMs desc`) → `deriveAgentSummary`; counts by `activity`; `mode` counts; `livePolicies` = count of `AgentPolicy` in scope with `shadow: false`.
- Empty workload with a configured worker → `service.configured: true`, all counts 0, `loads: []`. Unconfigured worker → `configured: false` and counts still computed from the DB (the DB may hold history).

- [ ] **Step 1: Failing tests** (`tests/agents-overview.test.ts`, copy `seedOrg`/token pattern from `tests/night-shift-routes.test.ts`; mock `checkOllama` with `vi.mock("../src/lib/aiHarness/ollamaAdapter.js", …)` returning `{ reachable: true, version: "0.34", models: ["qwen3:8b"], modelPresent: true, error: null }`; control `OLLAMA_URL`/`WORKER_URL` per test and restore them in `afterEach`):

```ts
it("unconfigured everything: rules available, model not configured, worker not configured, empty workload", async () => {
  delete process.env.OLLAMA_URL; delete process.env.WORKER_URL;
  const { token } = await seedOrg();
  const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.dispatch.rules).toEqual({ available: true });
  expect(res.body.dispatch.model).toEqual({ configured: false, reachable: null, modelPresent: null, model: null, error: null });
  expect(res.body.nightShift.service).toEqual({ configured: false, lastActivityAt: null });
  expect(res.body.nightShift.activity.total).toBe(0);
  expect(res.body.nightShift.enforcement).toEqual({ customerEmailOn: "not_enforced", quietHours: "not_enforced" });
});
it("configured worker with no loads is an empty workload, not an unavailable service", async () => {
  process.env.WORKER_URL = "http://127.0.0.1:3010";
  const { token } = await seedOrg();
  const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);
  expect(res.body.nightShift.service.configured).toBe(true);
  expect(res.body.nightShift.loads).toEqual([]);
});
it("model configured and reachable", async () => {
  process.env.OLLAMA_URL = "http://127.0.0.1:11434";
  const { token } = await seedOrg();
  const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);
  expect(res.body.dispatch.model).toMatchObject({ configured: true, reachable: true, modelPresent: true, model: expect.any(String) });
});
it("counts activity and mode per load using the shared summary, attention first", async () => {
  // seed: load A shadow policy pill asked with an unanswered message → waitingReply; load B live policy pill attention with an attention update; load C pill off
  …
  expect(res.body.nightShift.activity).toMatchObject({ waitingReply: 1, attention: 1, off: 1, total: 3 });
  expect(res.body.nightShift.mode).toMatchObject({ shadowLoads: 1, liveLoads: 1 });
  expect(res.body.nightShift.loads[0].loadId).toBe(loadB.id);
});
it("is tenant scoped: another org's loads and runs never appear", async () => { … expect(res.body.nightShift.activity.total).toBe(0); expect(res.body.dispatch.activity.lastRun).toBeNull(); });
it("requires a dispatcher session", async () => { expect((await request(app).get("/api/dispatcher/agents/overview")).status).toBe(401); });
```

- [ ] **Step 2: Run** → FAIL 404.
- [ ] **Step 3: Implement** `lib/agentsOverview.ts` (`buildAgentsOverview(req-scope, deps)` with `checkOllama` injectable for tests) and the router; mount in `app.ts`.
- [ ] **Step 4: Run** the test file, full backend suite, `tsc`.
- [ ] **Step 5: Report.**

---

### Task 4: Portal — agents store, AI Agents page, navigation

**Files:**
- Create: `fleet-portal/src/stores/agents.ts`, `fleet-portal/src/stores/agents.spec.ts`
- Create: `fleet-portal/src/views/AgentsView.vue`, `fleet-portal/src/views/AgentsView.spec.ts`
- Create: `fleet-portal/src/components/agents/DispatchAssistantCard.vue`, `fleet-portal/src/components/agents/NightShiftCard.vue`, `fleet-portal/src/components/agents/AgentLoadRow.vue`
- Modify: `fleet-portal/src/router/index.ts` (route `{ path: 'agents', name: 'agents', component: AgentsView }`), `fleet-portal/src/layouts/AppShell.vue` (`TOWER_PRIMARY` gains `{ label: 'AI Agents', to: '/agents' }` right after Control Tower; `TOWER_MORE`'s `AI Lab (dev)` stays but the Agents page links it as "Advanced: AI Lab")
- Modify: `fleet-portal/src/types/agents.ts` (create; mirror `AgentsOverview` from Task 3 exactly)

**Interfaces:**
- Consumes: `GET /dispatcher/agents/overview` via `api.get` (`fleet-portal/src/lib/api.ts`).
- Produces: store `useAgentsStore` with state `{ data: AgentsOverview | null; loading: boolean; error: string | null }`, action `load()`, getters `dispatchStatus` and `nightShiftStatus` (below).

Status copy (getters, unit-tested in `agents.spec.ts`):
- `dispatchStatus` → `{ headline, detail }`:
  - not configured → `headline: 'Rules available · AI not configured'`, `detail: 'Drivers are found and checked by the dispatch rules. Add a model server to get reasoned recommendations.'`
  - configured, unreachable → `'Rules available · AI unreachable'`, detail includes the error text.
  - reachable, model missing → `'Rules available · AI model not installed'`.
  - reachable + present → `'Rules available · AI ready'`; if `activity.running` → detail `'Thinking about load …'`; else if `lastRun` → `'Last run: <driverName ?? "no driver"> (confidence <n.nn>) · <status>'`.
- `nightShiftStatus` → `{ headline, detail }`:
  - `service.configured === false` → `'Not configured'`, detail `'No worker address is set, so nothing is being watched.'`
  - configured, `total === 0` → `'Ready · nothing watched yet'`.
  - otherwise `headline` = `'<watching+waitingReply> watching · <attention+escalated> need attention'` and `detail` = mode line `'<shadowLoads> in shadow mode (messages recorded, not sent) · <liveLoads> live'` + `' · Last report <ageLabel(lastActivityAt)>'`.

Page layout (`AgentsView.vue`): h1 "AI Agents", subtext "What each agent can do right now, and what it is doing." Two cards side by side (stack under `md:`). Each card: title, headline (`data-testid="dispatch-headline"` / `nightshift-headline"`), detail, a "Mode vs activity" explainer line on the Night Shift card (`Shadow/Live is what it may send. Watching/Waiting/Escalated is what it is doing.`), the enforcement notice (`data-testid="nightshift-enforcement"`: `Customer email and quiet-hours settings are not enforced yet — communication is governed by Shadow/Live only.`), and actions: Dispatch → `RouterLink to="/cockpit"` labelled `Find a driver`, `RouterLink to="/ai-lab"` labelled `Advanced: AI Lab`; Night Shift → `RouterLink to="/cockpit"` `Open Control Tower`, `RouterLink to="/night-shift"` `Policies`. Below the cards: the load list (`AgentLoadRow` per entry): board number, mode badge, activity badge, `next` text with a small `?` marker and title `Inferred from the timeline` / `No recent report` when `nextConfidence !== 'known'`, and a `RouterLink :to="`/cockpit?load=${loadId}`"` labelled `View agent` (`data-testid="view-agent-<loadId>"`). Loading and error states: `data-testid="agents-loading"`, `agents-error"`. Poll every 15 s while mounted (`setInterval`, cleared on unmount), like the demo view.

- [ ] **Step 1: Failing store spec** (`agents.spec.ts`): mock `../lib/api`; `load()` calls `api.get('/dispatcher/agents/overview')`; getter cases above (four dispatch, three night shift) with fixture overviews.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement store + types.** **Step 4: Run** → PASS.
- [ ] **Step 5: Failing view spec** (`AgentsView.spec.ts`, mock the store module like `DemoView.spec.ts`): renders both headlines from the getters; renders the enforcement notice; renders one `view-agent-<id>` link per load with `href` ending in `/cockpit?load=<id>`; shows the uncertainty marker only when `nextConfidence !== 'known'`; shows `agents-error` when `error` set.
- [ ] **Step 6: Implement** view + cards + row; add route + nav entry. Add a router spec assertion or extend `AppShell.spec.ts` if it exists: primary nav contains `AI Agents` → `/agents`.
- [ ] **Step 7: Run** `npx vitest run src/stores/agents.spec.ts src/views/AgentsView.spec.ts` (+ shell/router specs), then `npx vue-tsc -b`.
- [ ] **Step 8: Report.**

---

### Task 5: Portal — "View agent" summary in the drawer, technical details collapsed

**Files:**
- Create: `fleet-portal/src/components/agent/AgentSummaryPanel.vue`, `fleet-portal/src/components/agent/AgentSummaryPanel.spec.ts`
- Modify: `fleet-portal/src/stores/nightShift.ts` (`AgentForLoad` gains `summary: AgentSummary`; add the `AgentSummary` type mirroring Task 1's), `fleet-portal/src/components/agent/AgentDrawer.vue` (render the panel above the actions row; add the `Technical details` toggle), its spec.

**Interfaces:**
- Consumes: `GET /dispatcher/loads/:id/agent` now carrying `summary` (Task 2).
- Produces: `AgentSummaryPanel` props `{ summary: AgentSummary; shadow: boolean }`, sections with test ids `summary-noticed`, `summary-recommends`, `summary-done`, `summary-next`, `summary-mode`, `summary-activity`.

Behaviour:
- Panel renders five labelled rows: **What it noticed** (`noticed ?? 'Nothing unusual right now.'`), **What it recommends** (`recommends ?? 'No recommendation pending.'`), **What it has done** (list of `done`, or `'Nothing sent yet.'`; in shadow mode a one-line note `Shadow mode: these were recorded, not sent.`), **What happens next** (`next`, plus `(inferred from the timeline)` or `(no recent report)` suffix when `nextConfidence` is `inferred`/`unknown`), and the **Mode · Activity** badges. **Your actions** are the drawer's existing buttons — do not duplicate them; the panel's last row is the heading `Your actions` only if the buttons render directly under it; otherwise omit the heading.
- Timeline: default filter hides kinds `ping`, `sheet_write`, `plan`; a `Technical details` toggle button (`data-testid="timeline-technical-toggle"`) shows them and a count `(<n> hidden)`. Existing behaviour otherwise unchanged (correct picker, polling).

- [ ] **Step 1: Failing panel spec**: mounts with a `waiting_reply` summary → the five rows and the inferred suffix; with `done: []` → `Nothing sent yet.`; with `shadow: true` → the shadow note.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement the panel.** **Step 4: Run** → PASS.
- [ ] **Step 5: Failing drawer spec additions**: with a fixture `AgentForLoad` containing three `ping` entries and one `anomaly`, the timeline shows 1 item and the toggle reads `Technical details (3 hidden)`; clicking shows 4; the panel receives the fixture's `summary`.
- [ ] **Step 6: Implement** in the drawer (extend `AgentForLoad`; a `showTechnical` ref; a `visibleTimeline` computed).
- [ ] **Step 7: Run** the two specs, then `npx vue-tsc -b`. **Step 8: Report.**

---

### Task 6: Cockpit `?load=` deep link and the demo's agent links

**Files:**
- Modify: `fleet-portal/src/views/CockpitView.vue` (read `route.query.load` on mount and on query change → `agentDrawerLoadId`; when the drawer closes, remove `load` from the query with `router.replace`), its spec.
- Modify: `fleet-portal/src/components/demo/HowItWorksLinks.vue` (new prop `agentTimelineLoadId: string | null`; "Night Shift timeline" → `RouterLink :to="`/cockpit?load=${agentTimelineLoadId}`"` when present, else the plain `/cockpit` with the existing note), its spec.
- Modify: `fleet-portal/src/views/DemoView.vue` (pass `:agent-timeline-load-id="demo.data?.links.agentTimelineLoadId ?? null"`; add a `View agent activity` button, `data-testid="demo-view-agent"`, visible once the story stage is past `awaiting_approval`, linking to the same deep link), its spec.

**Interfaces:**
- Consumes: `DemoLinks.agentTimelineLoadId` (already in the response).

- [ ] **Step 1: Failing Cockpit spec**: mount with a memory router at `/cockpit?load=L1` → the `AgentDrawer` stub receives `loadId === 'L1'`; navigating to `/cockpit` closes it.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `useRoute()` + `watch(() => route.query.load, …, { immediate: true })`; on `@close`, `router.replace({ query: { ...route.query, load: undefined } })`.
- [ ] **Step 4: Failing demo specs**: `HowItWorksLinks` with `agentTimelineLoadId: 'L1'` renders `href` ending `/cockpit?load=L1`; `DemoView` shows `demo-view-agent` only when `story.stage` is one of the post-approval stages and links the same target.
- [ ] **Step 5: Implement.** **Step 6: Run** specs + `vue-tsc`. **Step 7: Report.**

---

### Task 7: Recommendation source visible through the demo

**Files:**
- Modify: `fleet-backend/src/lib/demoStory/types.ts` (`STAGES` `ai_recommendation` title `AI recommendation` → `Driver recommendation`, narration `Deciding who should run this load.` unchanged), `fleet-backend/tests/demo-story-presenter-copy.test.ts`/`dispatcher-demo-story.test.ts` expectations if any assert the old title.
- Modify: `fleet-portal/src/types/demo.ts` (`PresenterStageView` gains `badge?: 'AI' | 'Dispatch rules'`), `fleet-portal/src/stores/demo.ts` (`presenterStages` sets `badge` on the `ai_recommendation` tile from `story.recommendationSource`: `'ai'` → `'AI'`, `'engine'` → `'Dispatch rules'`, null → undefined), `fleet-portal/src/components/demo/StageRail.vue` (renders `stage.badge` as a small pill, `data-testid="stage-badge-<id>"`), specs.

- [ ] **Step 1: Failing specs**: store — `presenterStages` badge for both sources and none before a recommendation; rail — badge rendered only when present. Backend — presenter copy test still passes with the new title; any test asserting `'AI recommendation'` updated to `'Driver recommendation'`.
- [ ] **Step 2–4: Run, implement, run** (`npx vitest run src/stores/demo.spec.ts src/components/demo`; backend `npx vitest run tests/demo-story-presenter-copy.test.ts tests/dispatcher-demo-story.test.ts`).
- [ ] **Step 5: Report.**

---

### Task 8: Mark unenforced policy controls

**Files:**
- Modify: `fleet-portal/src/views/NightShiftView.vue` (the `toggle-customer-email` switch and the `policy-quiet-from`/`policy-quiet-to` inputs get `disabled`, an `aria-describedby` note `data-testid="not-enforced-note"` reading `Not enforced yet — Night Shift does not read this setting. Messages are governed by Shadow/Live only.`; values still round-trip so saving a policy does not drop them), its spec.
- Modify: `docs/agents-operating-spec.md` section 4 "Who it talks to" — one sentence pointing at the UI marking; gaps 6 and 8 gain `UI marks the control "Not enforced yet" (2026-09-30)`.

- [ ] **Step 1: Failing spec**: the switch has `disabled`, both inputs have `disabled`, the note is present; submitting the form still sends `customerEmailOn`/`quietFrom`/`quietTo` unchanged from the loaded policy.
- [ ] **Step 2–4: Run, implement, run** + `vue-tsc`. **Step 5: Report.**

---

### Task 9: Honest delay wording in Night Shift

**Files:**
- Modify: `night-shift/src/core/phrases.ts` (`case "delay"`: when `ev.behindMin <= 0` or `ev.behindPlan === false`, say `You're on pace, but this delivery is at risk of missing its window at <destination>. Is everything OK?`; otherwise the existing sentence with `Math.abs` not needed since positive).
- Test: `night-shift/tests/phrases.test.ts` (create if absent; else extend).

- [ ] **Step 1: Failing test**: `questionFor({ kind: "delay", evidence: { behindMin: -4, behindPlan: false } }, ctx)` contains `on pace` and never a negative number; `behindMin: 12, behindPlan: true` keeps `12 minutes behind`.
- [ ] **Step 2–4: Run, implement, run** `npm test` and `npm run typecheck` in `night-shift`. **Step 5: Report.**

---

### Task 10: Docs and demo guide

**Files:**
- Modify: `docs/agents-operating-spec.md` (sections 3 and 4 status vocabularies → replace "this document's own proposal" with the shipped vocabulary: Dispatch `Rules available · AI not configured / unreachable / model not installed / ready`; Night Shift mode `Shadow | Live` + activity `Watching | Waiting for reply | Escalated | Held | Needs attention | Delivered | Off`; gap 1, 2, 3, 9 marked resolved with the date), `docs/demo-mode.md` ("How it works" links now open the load's own timeline; `View agent activity` button).

- [ ] **Step 1: Edit.** **Step 2: `grep -c "Resolved 2026-09-30" docs/agents-operating-spec.md` ≥ 4.** **Step 3: Report.**

---

## Self-review

- Spec coverage: gap 1 → Task 4; gap 2 → Tasks 1, 2, 5; gap 3 → Task 6; gaps 6, 8 → Task 8 (marking only, as required); gap 9 → Tasks 3, 4, 10; owner requirement "readiness vs functionality" → Task 4 copy; "mode vs activity" → Tasks 1, 3, 4, 5; "unenforced marked unavailable" → Tasks 4 (notice), 8; "honest next" → Task 1 rules 6, 8 and Task 5 suffixes; "tenant-scoped, unavailable vs empty" → Task 3 tests 1–2, 5. Audit finding 4 → Task 7; finding 6 → Tasks 5, 9.
- Type consistency: `AgentSummary` fields (`mode, activity, noticed, recommends, done, next, nextConfidence, lastEventAt`) identical in Tasks 1, 2, 3 (`loads[]` uses `mode, activity, next, nextConfidence, lastEventAt` as ISO string), 4, 5. `AgentsOverview` identical in Tasks 3 and 4. `agentTimelineLoadId` identical in Task 6 and the existing `DemoLinks`.
- No placeholders: Task 3's per-load seeding test body is abbreviated with `…` for brevity of the plan; the implementer writes the seed using the fixtures from `tests/night-shift-routes.test.ts` and the event shapes in "Codebase facts".
