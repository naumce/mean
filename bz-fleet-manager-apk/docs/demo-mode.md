# Demo Mode

One load, end to end, through the real systems. `/demo` is the screen you show a prospect; everything it drives is the production code path — the dispatch checks, the AI harness, a real assignment, the simulation, Night Shift in shadow mode, the Cockpit's own commands. Nothing is faked to fit the story, and nothing can leave the system.

## The story (ten stages on the presenter screen)

| Stage | What actually happens |
| --- | --- |
| Uncovered load | `DEMO-CHI-DET`, Chicago → Detroit, sits open on the Control Tower with no driver. |
| AI recommendation | A harness run (`dispatch-v2`, `qwen3:8b` via local Ollama) investigates the load with the read-only tools and proposes a driver. Without Ollama the step uses the deterministic dispatch recommendation and says so. |
| Human approval | The presenter approves: the portal calls the real `POST /assignments` (pool tractor + trailer), records the verdict on the AI run, and the story switches Night Shift on with the Demo policy. |
| In transit | The simulation runner moves the truck (3 simulated minutes per real second) with wall-clock pings the worker reads as live. |
| Breakdown detected | Shortly after departure the story freezes the truck (simulation mode `stopped`, runner halted, one stationary ping per poll). Night Shift's stop rule needs ≥ 2 pings spanning ≥ 1 minute at one place and a worker tick (≤ 60 s). |
| Driver contacted | The agent's first question to John on this trip (shadow mode: recorded as "would say", not sent). Because the load is a hot load (see below), that question is usually the "running late" one asked at the first ping, a few seconds before or after the stop; Night Shift keeps one open question at a time and would only re-ask ten minutes later, so the story counts it either way and says "had already asked" when it came first. |
| Escalated | The presenter sends John's reply — "Engine warning. Give me 15 minutes." — through the real driver-link endpoint. The keyword classifier reads it as a breakdown (level 3), the agent acknowledges, and escalates immediately with a proposed customer update (the live ETA is past the window). |
| Customer update | "Send customer update" issues the real `send_customer_email` command; in shadow mode with a `.invalid` sink recipient the email is recorded, never sent. If no update was proposed, the stage offers "Continue" instead. |
| Resolved | The story sets the truck back to `auto` and restarts the runner; the stop anomaly resolves on its own. |
| Delivered | The truck approaches the dock, parks with a plan-minute budget, and the story pings the delivery stop until Night Shift records the arrival (≥ 5 min dwell within 0.5 mi) or 7 minutes pass (then the agent is switched off first); the assignment completes and the load is delivered. |

## Three deliberate deviations from the original storyboard

1. **Night Shift escalates immediately on a breakdown reply.** "Engine warning" classifies as `breakdown`; the agent answers the driver and escalates in the same call. There is no 15-minute timer; the "15 minutes" is what the driver says.
2. **The proposed customer update needs an at-risk delivery window.** Night Shift measures its ETA in wall-clock time from the plan and the last ping, while the simulation fast-forwards the truck. A window computed from the plan is never at risk in a nine-minute demo, so at approval the story tightens the delivery window to `now + 3.5 h` — shorter than the road time — and the load is a hot load from departure. Side effect: the agent's `delay` rule (which also fires whenever the ETA passes the deadline) raises a "running late" question first; the breakdown reply still produces the escalation and the draft.
3. **Arrival is Night Shift's own judgement.** The simulation's delivery is a status change; the agent's "arrived" is GPS dwell. The dock hold bridges them honestly; "Skip wait" switches the agent off instead.

## Reset Demo

`POST /demo/story/reset` is idempotent and total. From any state — a running simulation, a live Night Shift trip, queued or running AI runs, an in-progress assignment, load locks — it stops the runner, cancels the AI run, switches the agent off (which queues the worker's `stop`), purges the demo load's runtime rows (trips, events, updates, changes, locks, the assignment with its pricing snapshot, deadhead legs and conflicts) and the demo driver's runtime rows (pings, simulation state, assignments), then recreates the known state: John Carter (available, 20 mi west of the pickup, full hours, ten completed Chicago → Detroit loads, phone set), Demo Customer (`demo-customer@example.invalid`), the `Demo (fast)` policy, the `Demo` AI experiment, pool equipment, and the load itself (same row id every time, stops re-geocoded, appointments relative to now). The story returns to *Uncovered load*.

Two consequences of the worker's 60-second cadence: after a reset, approving within about a minute answers "Night Shift is still releasing the previous demo" until the worker has applied the `stop`; and a worker paused for more than two minutes while holding a live trip can miss it — reset again in that case.

## Safety

- The Demo policy is `shadow: true`, `customerEmailOn: false`, `bossCallOn: false`, `maxCalls: 0`: every message, call and email the agent would send is recorded as a `would_say` event and never leaves the process.
- The customer is `demo-customer@example.invalid` — an address that cannot resolve.
- The driver's reply is proxied only to `${WORKER_URL}/d/<driverToken>/reply` (the worker's own driver-link endpoint).
- Demo routes are `DEMO_MODE`-gated (404 otherwise), dispatcher session only, org-scoped; the story only writes through existing services (assignment lifecycle, agent switch, agent commands, simulation modes/ticks, the AI run queue).

## Timing

Roughly 6–10 real minutes: the AI step (one to three minutes with `qwen3:8b`), a worker tick after approval (≤ 60 s), the stop detection (1–2 min), the reply and escalation (immediate), the customer update (applied at the next worker poll), transit to the dock (~1.5 min), the arrival dwell (5–7 min, or skip). The status line always says what the story is waiting on.

## Observed timeline (local dry run through the customer-update path, real time from Reset)

| Real time | What happened on the presenter screen |
| --- | --- |
| 0:00 | Reset Demo → *Uncovered load*; Ask AI |
| 1:37 | AI recommends John Carter (confidence 0.85, `qwen3:8b`) |
| 1:39 | Approve → real assignment, Night Shift on: "Tight customer window: delivery due by 13:05" |
| 1:51 | The truck stops near Chicago (breakdown; simulation clock frozen) |
| 4:21 | Night Shift flagged the stop |
| 4:25 | Night Shift messaged the driver (shadow: recorded as "would say") |
| 4:28 | John's reply → escalation: "driver reports a breakdown; a customer update is proposed" |
| 4:28 | Send customer update → the real `send_customer_email` command; recorded at the next worker tick as a shadow email to the demo sink |
| 4:34 | Resolved → the truck is moving again |
| 7:00 | At the dock (Night Shift watching for the arrival) |
| 12:22 | Delivered. Night Shift recorded the arrival (and a shadow arrival notice to the sink) |

An earlier run that skipped the customer update delivered at 13:01. The AI step and the two worker ticks (stop detection, arrival) move these by a minute or two from run to run; the order never changes.

## Running it

Local: backend with `DEMO_MODE=true`, `OLLAMA_URL=http://127.0.0.1:11434` (optional — the fallback works without it) and `WORKER_URL=http://127.0.0.1:3010`; the Night Shift worker in `MODE=platform` against the same database (its config requires Twilio/SMTP/Mapbox/`LINK_SECRET`/`TZ` plus `SECRET_BOX_KEY` and Google OAuth values in platform mode — placeholder values are fine in shadow mode; on Windows Git Bash drops `TZ`, so start the worker from PowerShell or through `cmd /c "set TZ=… && npx tsx src/live/worker.ts"`). Render: the worker and backend already run; set `DEMO_MODE=true` and `WORKER_URL` to the worker's internal address; the AI step falls back to the dispatch recommendation there.

Presenter tips: warm the model a few minutes before you start (`ollama run qwen3:8b` once, or any AI Lab run) — a cold model can push the AI step past its time budget, in which case the story falls back to the deterministic recommendation and says so on the card; open `/demo`, press **Reset Demo**, then follow the single button per stage; keep the page open (its 3-second poll is the story's heartbeat); "How it works" links the AI Lab run, the Control Tower, the Driver Supply map and the Night Shift timeline for anyone who asks.

## Known limitations

- Wall-clock detection: the stop needs real minutes; nothing in Night Shift is shortened for the demo.
- The `delay` question may precede the stop question (deviation 2).
- The story's heartbeat is the open page; with the page closed nothing advances (and a very long dock hold ends by the timeout path with a `gone_dark` line on the timeline).
- One demo per organisation at a time.
- Great-circle simulated paths cross Lake Michigan; the Demo policy's `offRouteMi 25` keeps the off-route rule quiet.
- Night Shift's trip-start hours check reads the driver's clocks after the assignment has already reserved this run's on-duty time, so its timeline opens with an "hours cannot carry this run" escalation (shadow). The story ignores it; it is a pre-existing double count between the dispatch engine and the agent, not a demo defect.
- Because the load is hot from departure, the first question can read "about -4 minutes behind" (ahead of plan, past the customer deadline) — Night Shift's own wording, left untouched.
- The simulation is org-wide: every other assignment in the demo org advances (and can complete) while the demo runs, and Reset rewinds only the demo load, the driver and the ten history loads. Use a dedicated demo org, or re-run the world seed when the rest of the board should look fresh.
- One backend instance per org: the story's per-org mutex is in-process. With two backend instances both would tick and ping. Render runs one.
