# Fleet app and AI agent audit — 30 September 2026

## Scope and conclusion

Inspected the deployed app at https://fleet-demo-q20y.onrender.com using the repository's demo account, visited all 18 main authenticated navigation routes, opened the Night Shift timeline and driver-ranking modal, checked the demo at desktop and 390px mobile widths, and traced the corresponding source. This was a read-only product audit: no assignments, messages, calls, policy changes, resets, imports, or deployment changes were performed. Existing demo activity continued while the audit ran. This does not certify unexercised write workflows, integrations, security, or every input combination.

The agent functionality exists, but its entry points are fragmented. The deployed Qwen reasoning service is disabled. Night Shift is working on the demo load in shadow mode. The current UI does not give a dispatcher one clear place to discover these capabilities, check readiness, start work, and review outcomes.

## What exists and how to use it today

| Capability | Current entry point | Observed status / behavior |
| --- | --- | --- |
| Driver ranking | Control Tower → Unassigned Freight Backlog → lightning button beside a load | Works. Produces ranked candidates and rejection explanations. This is a rules-based scoring engine, separate from Qwen. The sampled old load rejected all candidates for missed appointments. |
| Qwen dispatch reasoning | More → AI Lab (dev); also Ask Qwen inside the ranking modal when enabled | AI Lab explicitly says “Harness disabled.” `/api/dispatcher/ai/status` returned 404. The UI hides Ask Qwen when disabled. |
| Night Shift monitoring | Control Tower → the load's Shadow / Watching / Attention badge; or Their Board → AGENT column | Opened DEMO-CHI-DET's Shadow badge and saw a populated timeline, itinerary, and supervision controls. Shadow mode records proposed communication without sending it. |
| Monitoring setup | Night Shift → Policies | Policy editor, thresholds, escalation ladder, contacts, shadow/live permissions. Creating a policy is separate from enabling monitoring on a load. |
| Enable a load | Control Tower → inspect a load → Night Shift switch → choose policy | Source-confirmed flow; not toggled during audit. Worker consumes enabled loads on its periodic platform pass. |
| Agent supervision | Open the per-load agent timeline | Call the driver now, I've got it / Hand it back, Stop the agent, dispatcher reply, and conditional customer-email action. These are consequential controls, not a general chat assistant. Not executed during audit. |
| Guided demonstration | Demo | Existing story progressed from In transit to Driver contacted during inspection. It reached “Send John's reply”; audit did not submit a reply. |
| External assistant integration | Night Shift → Settings → API keys; `night-shift-mcp/README.md` | Repository contains an MCP wrapper for external assistants. It is not an in-app chat interface. No key was created and no external client was tested. |

Practical path to see the agent immediately: open `/cockpit`, find John Carter's `DEMO-CHI-DET` load, and click **Shadow**. The status may change as the existing demo progresses. On `/board/broker`, the **AGENT** column provides the other entry point, but it is at the far right of a very wide sheet.

## Priority findings

### 1. Qwen is disabled on the deployed server

**Evidence:** AI Lab displays “Harness disabled” and “Set OLLAMA_URL on the backend to enable the Qwen harness.” The status API returns 404. `fleet-backend/src/lib/aiHarness/config.ts` gates the harness on `OLLAMA_URL`; `fleet-portal/src/components/cockpit/SuggestModal.vue` only renders Ask Qwen when `aiEnabled` is true.

**Effect:** Users cannot discover or run Qwen from the operational screen. A hidden button looks like missing functionality rather than a service that needs configuration.

**Fix:** Expose capability status persistently. Configure a reachable Ollama service with the selected model and verify the status reports reachable/model present before advertising readiness. Setting a URL alone is not proof the model works. The default model in source is `qwen3:8b`. Actual hosting configuration was not inspected or changed.

### 2. No agent overview or clear operational starting point

**Evidence:** `AppShell.vue` places AI Lab under More, labels it “(dev),” and presents Night Shift as a separate navigation item. Night Shift opens policy configuration; actual monitoring lives in per-load drawers. The ranking action is an icon-only lightning button.

**Fix:** Add a primary **AI Agents** entry showing separate cards for Dispatch recommendations and Night Shift monitoring. Each needs a plain explanation, readiness, current work, last meaningful result, and a next action. Show Disabled, Unreachable, Shadow, and Live distinctly. Keep model experiments under an advanced link. Label the ranking action “Find a driver.”

### 3. The demo timeline link does not open a timeline

**Evidence:** Demo → How it works → Night Shift timeline points to `/cockpit`. `HowItWorksLinks.vue` hardcodes that URL. The demo response already exposes `links.agentTimelineLoadId`, but DemoView does not pass it to the links component. `CockpitView.vue` only opens AgentDrawer from in-page clicks.

**Fix:** Add an authenticated per-load timeline route or supported load query parameter, consume the provided load ID, and expose “View agent activity” directly on the demo page.

### 4. Demo labels do not preserve the distinction between AI and fallback

**Evidence:** The completed stage remains “AI recommendation” while How it works says “AI Lab run (not started yet).” The backend intentionally falls back to `suggestForLoad` when the harness is unavailable. The approval button *does* show “Recommended by the dispatch rules — AI unavailable” at that stage, but that explanation is gone in later stages.

**Fix:** Keep recommendation source visible throughout the story. Use “Driver recommendation” as the general stage label and display “AI” or “Dispatch rules” beside the actual result. Distinguish a run that never occurred from one still pending.

### 5. Demo data is stale and its refresh control is unusable

**Evidence:** Sidebar says “No anchor recorded — seed the week first” and disables Move demo to today. Their Board has July rows. Cockpit contains missed-pickup loads and driver data 23 hours to eight days old. The sampled L-51221 ranking reports deadlines roughly 211–222 hours late and no feasible driver.

**Fix:** Repair the seed/anchor lifecycle and ensure the demo has current appointments, driver availability, HOS, equipment, and tracking. Test one valid recommendation and one intentional rejection. Avoid rewriting this shared database until the intended demo reset scope is explicit.

### 6. Agent activity is buried in raw telemetry

**Evidence:** The opened timeline begins with many separate “Ping / ping” entries; useful Would say, anomaly, and plan entries require scrolling. `agentTimeline.ts` fetches all matching updates/events without pagination and the drawer renders the merged list. One recorded message says “You're about -4 minutes behind,” which is confusing.

**Fix:** Default to meaningful events, collapse raw telemetry, paginate history, and show last check, current situation, latest reasoning, and next action at the top. Correct negative-delay wording. In shadow mode, explain “No messages sent” beside the status, not only through the policy editor.

### 7. Screens disagree about operational state

**Evidence:** Cockpit labels several drivers AVAILABLE while Driver Supply labels those same drivers Unavailable. Vehicles is empty while Fleet has tractors/trailers. Trips, the old Board, and Overview are empty while Control Tower contains an active load. Approvals describes trip/sign-proof approvals, not agent recommendations.

**Interpretation:** Some screens use different status definitions or older data models. These observations establish a confusing presentation, not that every underlying record is incorrect.

**Fix:** Define availability consistently or label the distinction explicitly (unassigned versus eligible for dispatch). Remove or clearly separate legacy pages. Do not route users seeking AI approvals to unrelated trip approvals.

### 8. Mobile layout is substantially broken

**Evidence:** At 390 × 844, the fixed 248px sidebar leaves only a narrow strip for demo content. Document width is 491px. The screenshot shows wrapped text, horizontal clipping, and the stage rail consuming the viewport. The shell's fixed sidebar has no mobile collapse.

**Fix:** Use a collapsible mobile navigation drawer and let the main content occupy the viewport. Verify demo actions, policy setup, and agent timeline at mobile widths before treating the web portal as an APK-ready experience. The native APK itself was not inspected.

### 9. Secondary data-quality issues

Fleet lists duplicate service shops and duplicate maintenance records. Analytics shows the Chicago–Detroit recurring lane with 11 runs/$20,350 while its current broker grouping shows one unbrokered $1,850 load. The aggregation/history semantics need investigation; the audit does not establish whether those runs are intentional historical records or duplicate demo artifacts.

## Navigation coverage

| Routes | Result |
| --- | --- |
| `/demo`, `/night-shift`, `/ai-lab` | Demo active; Night Shift policy editor populated; AI harness disabled. |
| `/cockpit`, `/board/broker`, `/supply` | Data rendered; inspected monitoring and ranking entry points; stale data/status inconsistencies noted above. |
| `/fleet`, `/brokers`, `/money` | Populated maintenance, analytics, and financial views; data-quality concerns noted above. |
| `/import` | Import mapping and webhook-key entry points rendered; no upload or key generation performed. |
| `/messages`, `/tracking`, `/drivers` | Conversation list, location rows, and driver list rendered; no communication or editing performed. |
| `/approvals`, `/vehicles`, `/trips`, `/board`, `/overview` | Rendered empty/legacy states despite populated newer operational views. |

## Suggested implementation order

1. Introduce the AI Agents overview, visible readiness states, plain action labels, and direct per-load timeline links.
2. Repair the demo seed anchor and dates; expose recommendation source and shadow-mode behavior throughout the demonstration.
3. Verify model and worker readiness independently; run one isolated end-to-end scenario with controlled communications.
4. Summarize/filter agent events and unify driver-state language.
5. Fix mobile navigation and separate the legacy screens.

## Evidence artifacts

- `output/playwright/agent-timeline.png`: opened Night Shift drawer, shadow mode and raw ping feed.
- `output/playwright/agent-timeline.yml`: timeline including proposed communications.
- `output/playwright/demo-links.yml`: completed recommendation stage, no AI run, and timeline link pointing to `/cockpit`.
- `output/playwright/suggest.yml`: actual driver-ranking results and stale-deadline rejections.
- `output/playwright/demo-mobile.png`: mobile clipping and fixed-sidebar issue.
- `output/playwright/cockpit-loaded.yml`: operational board and backlog.

No application source was changed or deployed in this audit.
