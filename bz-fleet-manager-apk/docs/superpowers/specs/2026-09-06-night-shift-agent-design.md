# Night-Shift Agent — Design

**Status:** approved in conversation, 2026-09-06. Not yet planned or built.
**Segment:** one load, from the moment a driver's name is typed into the customer's Excel row until the truck arrives. Nothing else.
**Language:** American English everywhere — driver link, messages, voice call, templates, briefings. Other languages are deferred.

---

## 1. What this is

A dispatch operation today runs on an Excel sheet in SharePoint. A load is a row. Someone types a driver's name into it and, from that moment, a human has to watch that truck: where is it, is it on time, why did it stop, does the customer need to know.

The night-shift agent is that human. It reads the row as its brief, resolves the route, computes the plan, invites the driver to share location, watches every ping against the plan, talks to the driver when something is off, writes status back into the same sheet, and briefs the dispatcher — by email, in plain language, with evidence.

**Nobody has to adopt a platform.** The sheet stays the system of record. The driver taps a link; there is no app-store install. The agent bolts onto the workflow that already exists.

### What makes it different from "tracking"

Tracking products show a dot that stopped. This agent knows *whether the stop was supposed to happen*. It knows where the driver's mandatory 30-minute break falls after eight hours of driving, which rest area it recommended for it, and which stops are on the plan. A stop in the break window at a rest area is compliance. A 20-minute stop in Bethany, MO is a question — and the agent asks it, reads the answer, and tells the dispatcher what the driver actually said.

---

## 2. Scope

**In:**
- Reading a load row from a SharePoint/OneDrive Excel sheet via Microsoft Graph, and writing status back to it.
- Inviting the driver by SMS with a link; accept + browser-based location sharing.
- Route resolution (real road, truck-legal) and a plan: ETA, planned stops, HOS break window and recommended rest area.
- Deterministic anomaly detection: unplanned stop, delay, gone dark, off route.
- A bounded, escalating action ladder toward the driver: message → repeat/SMS → voice call → escalate to dispatcher.
- A situation library (the "RAG"): a bounded set of things a driver can be in, each with a response, an escalation level, and what to tell the dispatcher. Free-text driver replies are classified against it.
- A supervised learning loop: corrections from the dispatcher accumulate; the agent *proposes* changes to the library; a human approves them.
- Emails: morning briefing to the dispatcher; immediate escalation email; scheduled status to the customer; **drafted** bad-news email to the customer, sent only on the dispatcher's instruction.
- Reply-able dispatcher emails with a small command vocabulary.
- A replayable end-to-end simulation used for both testing and the stage demo.

**Out (for this segment):**
- Dispatch, load assignment, pricing, the board, the cockpit.
- Inbound customer questions (v2).
- The agent phoning the dispatcher.
- Any bad news reaching a customer without a human tap.
- Any language other than American English.
- Multi-load optimization; the agent reasons about one load at a time.

---

## 3. Approach: rules decide, the model speaks

Whether something is wrong is decided by deterministic code with thresholds. The language model never decides *that* there is a problem — it only decides *how to say it*: composing the message to the driver, reading the driver's free-text reply, writing the briefing, scripting the call.

Why this and not an LLM agent running the loop:
- It is the only version in which "the agent never invents a problem" is literally true. Someone in the room will ask.
- Every action carries the evidence that fired it — the ping, the minutes, the threshold. The briefing is assembled from that evidence, not composed from a summary.
- It is testable the way everything else in this codebase is tested: each rule has a discrimination proof.
- It is cheap. The model runs on events, not on a timer.

This is the same discipline the rest of the platform already runs on ("absent must never render as measured"; "engine-authoritative"), applied to a system that talks.

---

## 4. Lifecycle

```
Row assigned → Invite sent → Accepted → Tracking → Arrived → Closed
                     ↘ (no accept by departure + 30 min) → Attention
```

**Row assigned.** The agent polls the sheet through Graph (delta query on the worksheet; 60 s). A row transitions to *assigned* when its driver cell goes from empty to a name that resolves to a known driver with a phone number. The whole row is the brief: origin, destination, equipment, departure time, transit hours, delivery deadline, customer contact, reference. Missing required cells → the row goes to *Attention* with the list of what is missing; the agent does not guess.

**Invite sent.** Route resolved (Mapbox Directions, truck profile from the equipment cell, falling back to the legal maximum), plan computed (§5), SMS sent to the driver with a short link: load reference, origin → destination, departure, deadline, and an **Accept** button.

**Accepted.** The driver taps Accept in the browser. The page requests geolocation and holds a wake lock while foregrounded; it posts a ping every 60 s while moving and every 5 min while stationary. The agent records the accept time and the device's first fix. Row → *Tracking*.

**Tracking.** Every ping is evaluated against the plan (§6). Status is written to the sheet every 15 min and on every escalation (§8). Anomalies run the action ladder (§7).

**Arrived.** The device is within 0.5 mi of the destination stop and stationary for 5 min; the arrival time is the first ping inside that fence, not the minute it was confirmed. The agent writes arrival time and on-time result and stops asking for location. An **on-time** arrival goes to the customer as routine status. A **late** arrival is bad news: it is drafted for the dispatcher with the note attached (§8) and goes to the customer only on `send the customer email` — never unprompted. Row → *Arrived*.

**Closed.** The dispatcher marks the row closed, or 24 h after arrival. The agent's columns are frozen.

**Attention.** Any state where the agent cannot proceed without a human: missing brief cells, no accept by departure + 30 min, driver number unreachable, sheet write failing. Always accompanied by an escalation email that says exactly what is blocked.

---

## 5. The plan

Computed once at invite and recomputed on every ping:

| Element | Source |
|---|---|
| Route geometry | Mapbox Directions, driving-traffic, truck constraints (height 4.11 m, width 2.59 m, gross 36.29 t unless the equipment cell overrides) |
| Distance, drive time | The same routing answer — the line and the time are one provider response |
| Planned stops | The row's origin and destination; intermediate stops if the sheet has them |
| Mandatory break | FMCSA: 30 min after 8 h driving; positioned along the route by the existing break planner; a recommended rest area from the registry within 35 mi |
| ETA | Departure (actual, once known) + remaining drive time along the route from the current position + remaining mandatory break time |
| Plan line | For any minute *t* after departure, the point along the route the plan expects the truck to be at |

"On time" is the live ETA against the row's deadline **and** the minutes ahead/behind the plan line. Both are written to the sheet. "Behind the plan line but deadline still safe" is a note; "deadline at risk" is an anomaly.

---

## 6. Detection rules

All deterministic. Every fired rule produces an `AgentEvent` of kind `anomaly` with the evidence that fired it.

| Anomaly | Rule | Explicitly NOT an anomaly |
|---|---|---|
| **Unplanned stop** | Stationary (pings within 0.5 mi of the latest) for **15 min or more** (`STOP_MIN`, inclusive), not within 0.5 mi of a planned stop | Any stop at a registered rest area or fuel stop — inside the break window (planned break ± 45 min) it is compliance; outside it, fueling or rest, and a long one is the delay rule's business; any stop shorter than the threshold |
| **Delay** | Live ETA later than the deadline, **or** > 30 min behind the plan line | Slow traffic that has not endangered the deadline — logged as a note, surfaced in the morning briefing only |
| **Gone dark** | No ping for **> 20 min** while Tracking | Last ping at a planned stop or registered rest area and gap < 60 min (phone in a building) |
| **Off route** | > 5 km from the route line for **> 10 min** | A detour that rejoins the route within 30 min — logged, not raised |

Thresholds are constants in one module, named, with the reason for each value beside it. They are not tunable per situation in this segment.

**The break rule is load-bearing.** The agent must be able to say "he is taking his mandatory 30 at the Love's we recommended" and do nothing. Messaging a driver during his legal break is the fastest way to lose the driver, and the agent knows enough to never do it.

---

## 7. Action ladder

Per anomaly, per trip, with cooldowns so no rung repeats inside its window.

| Rung | Trigger | Action | Cooldown |
|---|---|---|---|
| 1 | Anomaly fires | **Message** the driver through the link's chat: one sentence of situation, one question. *"You've been stopped 20 min in Bethany, everything OK?"* | 10 min |
| 2 | No reply by cooldown | **Message again**; if the link has not been opened in 30 min, **SMS** the same text | 15 min |
| 3 | No reply by cooldown, **or** delay endangers the deadline | **Voice call** (§10) | 5 min, one retry |
| 4 | No answer to the call, **or** any reply classified level ≥ 2 (§9) | **Escalation email to the dispatcher** with everything the agent did and said, the driver's words verbatim, and — if the deadline is at risk — the drafted customer email. When a dispatcher phone is configured, that phone then **rings with a spoken briefing** (load, driver, reason, last position, whether the email went) and hangs up — it does not listen, so the dispatcher's words are never mistaken for a driver reply (added 2026-09-07) | — |

Rules that hold at every rung:
- One open question at a time. The agent does not stack messages.
- A reply at any rung stops the ladder for that anomaly; the reply is classified (§9) and the situation's own escalation level decides whether the dispatcher hears about it now or in the morning.
- The ladder is per anomaly; a second anomaly starts its own ladder but shares the "one open question" rule.
- Quiet hours are **not** a thing for the driver side: a truck on the road at 3 a.m. has a driver awake at 3 a.m. Quiet hours do apply to the dispatcher's non-escalation emails.
- A send that throws (gateway down) does not climb the ladder: the rung is held and retried on the cooldown. After **3 consecutive failed deliveries on one rung** (`MAX_DELIVERY_FAILURES`), "I could not reach him" is itself the news: **every active ladder on the trip stops as escalated** and the dispatcher hears it once — one dead gateway is one piece of news, not one email per anomaly. A later anomaly with a new key starts a fresh ladder. A failed invite at start is a startup error the operator sees, not a ladder event. (Ruled 2026-09-07 during the first-live-run build.)

---

## 8. What it writes

### The sheet

The agent adds six columns to the worksheet if they are absent, and never touches any other cell:

| Column | Example |
|---|---|
| `Agent Status` | Invited · Accepted · Tracking · Arrived · Attention |
| `Last Position` | *12 mi N of Bethany, MO · 08:42* |
| `ETA` | *11:24* |
| `On Time` | *+18 min* · *−42 min, deadline at risk* |
| `Last Update` | *2026-09-06 08:42* |
| `Agent Log` | Link to a row in the `Agent Log` tab |

`Agent Log` is a separate worksheet tab: one row per `AgentEvent` — time, load, kind, evidence, action. It is the audit trail and the raw material of every email.

Writes are cell-range PATCHes through Graph, every 15 min while Tracking and immediately on any escalation. A write failure puts the row in *Attention* and emails the dispatcher; the agent does not silently fall behind.

### Emails to the dispatcher

**Morning briefing** — fixed time per org (default 06:30 local). One paragraph per active load in plain American English, assembled from the event log: what happened, what the agent did, what it wants. Loads with nothing to report get one line.

**Escalation email** — immediate, on rung 4 or any level ≥ 2 reply. Subject carries the load and the situation. Body carries the full ladder for that anomaly, the driver's words verbatim, and the drafted customer email as an attachment when relevant.

Both are **reply-able**. The agent parses the reply for a small vocabulary and echoes back anything it did not understand instead of acting on it:

| Reply | Effect |
|---|---|
| `leave him` | Suppress further driver-side action on the current anomaly |
| `call me if it gets worse` | Suppress until the next rung-4 trigger |
| `send the customer email` | Send the attached draft as-is |
| `reclassify as <situation>` | Correct the classification (feeds §9's learning loop) |
| `note: …` | Append to the load's log |

### Emails to the customer

**Scheduled status only.** Times set per load in the sheet (defaults: departure, midpoint, one hour before ETA). Fixed template: departed / current ETA / on plan or the measured delay. Never a reason, never a driver's words.

**Bad news is drafted, not sent.** When the deadline is at risk, the agent drafts a customer email stating the measured new ETA and attaches it to the dispatcher's escalation email. It goes only on `send the customer email`. The draft contains nothing the agent did not measure.

---

## 9. The situation library

A bounded set of things a driver can actually be in. Each entry carries a response template, an escalation level, and what to tell the dispatcher.

| Situation | Level | Response to driver | Dispatcher hears |
|---|---|---|---|
| all good / on my way | 0 | *Thanks, drive safe.* | Morning briefing |
| rest / bathroom / food | 0 | *Got it, thanks.* | Morning briefing |
| fuel | 0 | *Got it.* | Morning briefing |
| traffic / weather | 1 | *Thanks — I'll update the ETA.* | Morning briefing; escalation only if deadline at risk |
| police / inspection | 2 | *Understood. Message me when you're rolling.* | Now |
| customer not ready / wrong address | 2 | *Understood, I'm telling dispatch.* | Now |
| breakdown | 3 | *Understood. Are you safe? Dispatch is being notified now.* | Now, with drafted customer email |
| accident | 3 | *Are you OK? Dispatch is being notified now.* | Now, with drafted customer email |
| **unknown** | — | *Sorry, I didn't catch that — dispatch will follow up.* | Now, with the driver's words verbatim |

**Classification.** A driver's free-text reply (chat, SMS, or call transcript) is embedded and matched against the library's example phrasings; the model then confirms or rejects the top match with a confidence. Below the confidence floor, the reply is **unknown**. Unknown is never forced into a bucket.

**The learning loop — supervised.** Every reply is stored with its raw words, its classification, its confidence, the outcome, and any correction the dispatcher made (`reclassify as …`). When a situation accumulates enough corrections or the same unknown phrasing recurs, the agent **proposes** a change — a new example phrasing, a new situation, a different escalation level — in the morning briefing. A human approves it; the library version increments. Rules never rewrite themselves. That is how the library "keeps getting better" and how escalation levels are managed: by a reviewer of a sharpening library, not by an operator of a black box.

---

## 10. The voice call

Twilio Programmable Voice, outbound to the driver's number, en-US text-to-speech and speech-to-text.

Script — generated from the situation template, never free-form:
1. *"Hi, this is the dispatch assistant for [company]. You're about 45 minutes behind for Des Moines. Is everything OK?"*
2. Listen (up to 15 s). Transcript → the same classifier as text (§9).
3. One follow-up at most, from the situation's template. Then: *"Thanks, I'll let dispatch know."*

No answer → hang up without voicemail → retry once after 5 min → rung 4. A call is an `AgentEvent` with the transcript as evidence. If speech-to-text confidence is low, the reply is **unknown**, exactly as with text.

---

## 11. Honesty rules

These sit over everything the agent writes or says:

1. **A measurement is stated as a measurement.** *"Stopped 20 minutes in Bethany, MO."*
2. **A quote is stated as a quote.** *"He said: 'had to use the bathroom.'"* Never *"he had to use the bathroom."*
3. **No answer is reported as no answer.** *"I asked at 02:14; no reply by 02:39."* Never silence, never an assumption.
4. **Nothing in an email that is not an event with evidence behind it.**
5. **Unknown stays unknown.** The agent hands over what it did not understand rather than improvising.
6. **The agent never speaks to a customer about a problem.** Scheduled status only; bad news is a draft.

---

## 12. Data model

```
AgentTrip
  id, orgId, sheetId, rowRef, loadRef
  driverId, driverPhone, driverName
  brief: { origin, destination, equipment, departAt, transitHours, deadlineAt, customerEmail, customerStatusTimes[] }
  plan: { routeGeometry, distanceMi, driveMin, plannedStops[], breakWindow, recommendedRestStop, etaAt }
  state: assigned | invited | accepted | tracking | arrived | closed | attention
  attentionReason?: string
  acceptedAt?, departedAt?, arrivedAt?

AgentEvent  (immutable)
  id, tripId, at
  kind: ping | plan | anomaly | action | reply | escalation | sheet_write | email | call
  evidence: JSON   -- the ping, the minutes, the threshold, the transcript; whatever fired it
  actionTaken?: string

DriverReply
  id, tripId, eventId, at
  channel: chat | sms | call
  rawText
  situationKey | null       -- null = unknown
  confidence
  correctedTo?: situationKey, correctedBy?, correctedAt?

Situation
  key, version, level (0..3)
  examples[]                -- phrasings used for matching
  responseTemplate          -- en-US
  dispatcherNote
  approvedBy, approvedAt

SituationProposal
  id, situationKey | null, proposed: JSON, basis: replyIds[], status: pending | approved | rejected

Briefing
  id, orgId, sentAt, kind: morning | escalation
  tripIds[], body
  replyText?, parsedCommands[]
```

The event log is append-only. Emails, sheet cells and briefings are all rendered from it; none of them holds a fact the log does not.

---

## 13. Simulation, testing, and the demo

**The replay.** A recorded run of Kansas City → Des Moines (I-35, ~193 mi, ~3 h 05 drive) on the real route, with synthetic pings at plausible speed and anomalies injected at chosen minutes.

Preconditions, so the story is internally consistent: departure 06:10; the driver arrives with **6 h 10 min already driven** on his clock from an earlier load, so his 8-hour mark lands ~1 h 50 into this run; plan ETA 09:45 (drive + the 30-min break); sheet deadline 10:15.

| Clock | Min | Event |
|---|---|---|
| 06:10 | 0 | Row assigned; invite; accept; departs on time |
| 07:12 | 62 | Stop in Bethany, MO — 20 min, not on plan. ETA → 10:05, still inside the deadline, and 20 min is under the 30-min plan-line threshold: **stop anomaly only, no delay anomaly** |
| 07:27 | 77 | Rung 1 message sent |
| 07:31 | 81 | Driver replies *"had to use the bathroom, rolling now"* → situation `rest`, level 0 |
| 08:00–08:30 | 110–140 | Mandatory break at the recommended rest area, inside the window — correctly **not** an anomaly, no message |
| 08:44 | 154 | Traffic north of Osceola at 15 mph since 08:30; now 30.5 min behind the plan line → delay anomaly; rung 1 message, no reply. (During the break itself, 08:00–08:30, the ETA credited the minutes already taken and nothing fired.) |
| 08:54 | 164 | Rung 2; no reply |
| 09:09 | 179 | Rung 3 voice call; no answer; retry at 09:14, no answer |
| 09:19 | 189 | Rung 4 escalation email; live ETA 10:36 is past the deadline, so the drafted customer email is attached |
| 09:22 | 192 | Dispatcher replies `send the customer email`; sent with ETA 10:36 |
| 10:36 | 266 | Arrived, 21 min late |

These minutes are produced by the rules from the replay's data (`night-shift/src/replay/kcDesMoines.ts`) and asserted by `tests/replay.test.ts`; the table describes the replay, not the other way round.
| next 06:30 | — | Morning briefing |

Runs at 60× so the three hours play in three minutes on stage. **Nothing on the surface is mocked** — the sheet row really updates, the emails really arrive in a demo inbox, the call really rings a phone. Only time is compressed.

**Tests.**
- Every detection rule: unit tests with discrimination proofs (break the rule, prove the test fails).
- The break exemption specifically: a stop in the window at a rest area must produce no anomaly and no message.
- The ladder: cooldowns, one-open-question, reply-stops-ladder.
- The classifier: a fixture set of realistic replies including misspellings and transcript noise; unknown must stay unknown below the floor.
- Reply-command parsing: unrecognised text is echoed, never executed.
- The replay above, asserted event by event.

---

## 14. Build order

1. Graph worksheet reader/writer; `AgentTrip` from a row; the six columns and the log tab.
2. Driver link: SMS, accept page, browser geolocation, ping endpoint.
3. Plan and detection rules, reusing the existing router, break planner, rest-stop registry, `dwellSegments` and `lateRisk`.
4. Situation library, classifier, driver chat through the link.
5. Morning briefing, escalation email, sheet writes, reply-command parsing.
6. Voice call.
7. The replay harness and the stage demo.

Each step ships something demonstrable on its own.

---

## 15. Assumptions and open points

- The customer's sheet has, or will be given, columns for: reference, origin, destination, equipment, departure, transit hours, deadline, customer email, driver. Column mapping is configured once per org.
- Driver phone numbers are in the sheet or in a small driver tab; the agent does not look them up elsewhere.
- Browser geolocation sharing is adequate for this segment. If drivers keep the tab backgrounded and pings stop, "gone dark" handles it honestly; a native app is a later decision.
- Twilio is the telephony and SMS provider. Microsoft Graph is the sheet API. Both need credentials at the org level.
- Mapbox remains the router; its truck constraints cover dimensions but not hazmat.
- Customer-facing status times default to three per load and are overridable in the sheet.
