# Two boards, one truth — the Broker Board with the night shift inside

**Date:** 2026-09-07
**Status:** draft for review
**Builds on:** `2026-09-06-night-shift-agent-design.md` (the agent), `2026-09-01-dispatch-service-platform-design.md` (the platform)

## 1. What this is

A broker opens our product and sees their own board: the same columns, in the same order, with the same two-row load they have used for years. Nothing to learn on day one. Behind it, every row is a real load in our database, and the night-shift agent is inside the board: a status pill on every load, its own line under UPDATE, and a drawer with everything it did.

The second board is ours: the cockpit, the map, the time axis, the money view. Same loads, opened the other way. The broker starts on their board; the boss looks at ours; over weeks the dispatcher drifts toward ours because it is better. **Their board is the priority. Ours is where they end up.**

Two front doors, one core: the agent's ladder, library, and honesty rules do not change. What changes is that four of its ports are implemented against the platform instead of a sheet and a link page.

## 2. Scope

In:
- The Broker Board view: a grid that reproduces the customer's layout (§4), editable, importable from their `.xlsx`.
- The data model additions a brokerage row needs (§5).
- The agent in the board: pills, the UPDATE line, the drawer, the morning filter, shadow mode (§6).
- The platform adapters for the agent's loads, location, messenger, and sheet ports (§7).
- The cockpit's Attention lane and the trip panel (§8).
- Import from `.xlsx` now; two-way sync with a live Excel later (§9).

Out (later specs): the Graph sync itself, TMS connectors, billing, the conversational voice call, multi-org onboarding UI. Each is named in §14 with where it plugs in.

## 3. The two boards

| | Broker Board (`/board/broker`) | Control Tower (`/loadboard`, `/cockpit`) |
|---|---|---|
| Looks like | their Excel | our product |
| Unit | the two-row load | the load on a time axis and a map |
| Edits | any cell, inline, like a sheet | drag, assign, plan |
| The agent | pill + UPDATE line + drawer | Attention lane + trip panel |
| Who | the dispatcher, day one | the boss, then the dispatcher |

One load, one record. Editing a cell on either board edits the load. A trip the agent opens on one board is the same trip on the other.

## 4. The Broker Board

### 4.1 Layout: exactly theirs

Columns, in order, from the customer's sheet: `BOL#`, `CUSTOMER / CARRIER`, `TELEPHONE#`, `CONTACT NAME`, `PICK UP`, `PU ZIP`, `DEL ZIP`, `DELIVERY`, `RATE`, `SOLD RATE`, `PROFIT`, `M.C. #`, `LOAD#`, `SHIP DATE`, `****UPDATE****`, `APPT SCHEDULE`. Then two of ours at the far right: `AGENT` (the pill) and `DRIVER CELL` (§5, optional, hidden until a customer turns it on).

Each load is two rows, as in their file:
- **Top row (customer):** BOL#, customer name (their yellow cell), tracking share link in the TELEPHONE# cell, pick-up city, PU ZIP, DEL ZIP, delivery city, RATE, SOLD RATE, PROFIT (computed: RATE − SOLD RATE), "MC" label, load order number, SHIP DATE, UPDATE (the dispatcher's text), `PU:` appointment line.
- **Bottom row (carrier):** carrier name, carrier phone with extension, contact name, MC number, our LOAD#, `DEL:` appointment line.

The grid keeps their colors: orange rows, yellow customer cell, green profit. Column order and names are a per-org layout (§5.4), so a second broker with a different sheet gets theirs.

### 4.2 Behaviour

- Click a cell, type, Enter. Tab moves right, arrows move, Escape cancels. Paste from Excel fills cells. Undo with Ctrl+Z (one level per cell edit).
- A blank load is one click ("+ load"): two empty rows appear, LOAD# assigned by us.
- PROFIT is never typed. RATE and SOLD RATE are money cells; they accept `$4,000.00` and `4000`.
- Sorting and filtering by any column; the default order is theirs (newest at the bottom, as in the sheet).
- The row pair is atomic: select one, both highlight; delete one, both go (with confirmation naming the LOAD#).
- Free text stays free text. The board never reformats what a human typed into UPDATE or APPT SCHEDULE. It parses them (§5.3), and when it cannot, it says so in the AGENT pill's tooltip, not by rewriting the cell.

### 4.4 Table power (decided 2026-09-08, slice 2)

The grid is built on TanStack Table (headless): the library does selection, sorting, filtering, column state and virtual scrolling; we draw every cell, so the board stays theirs.

- **Selection.** A checkbox gutter on the left of every load (the pair selects as one), select-all in the header, shift-click for a range. A bulk bar appears above the grid with the count and the actions: **Delete** (a confirmation names the LOAD#s), **Archive** / **Unarchive**, **Export selected** (`.xlsx` in their layout). Archived loads are hidden by default; one toggle shows them, greyed.
- **Sorting.** Click a header to sort, click again to flip, shift-click to add a second key. Bottom-row values (carrier, MC, LOAD#) sort too. The default order is the sheet's (`boardLine`).
- **Filtering.** One search box over every cell; a per-column filter under the header on demand; a status filter (open, assigned, delivered, archived).
- **Column tools.** Hide, reorder by drag, resize by drag, remembered per user on that browser. Reset to their layout in one click. Sticky header and sticky BOL# column; a density toggle (their spacing or tight).
- **Feel.** Hover highlight on the pair, selection highlight, keyboard: arrows move, Space selects, Enter edits (§4.2), Escape cancels. Virtual scrolling so a thousand loads stay smooth.
- **Archive semantics.** `Load.status = "archived"` is a board state, not a dispatch state: an archived load is never started by the agent and never shown on the cockpit's active lanes. Delete is permanent and refuses a load with an active assignment or an open agent trip (the row says why).

### 4.3 What it must not do

- No modal per edit, no "save" button, no page reload. It is a sheet.
- No column the customer did not ask for, except AGENT (always) and DRIVER CELL (opt-in).
- No lock-in: `Export .xlsx` produces a file in their layout at any time (§9).

## 5. Data model

### 5.1 Existing tables that already fit

`Load` (orderRef, requiredEquip, revenueCents, brokerName), `LoadStop` (address, lat/lng, geocodeStatus), `Appointment` (windowStart, windowEnd, type), `Carrier` (name, mcNumber), `Assignment`, `Org`, `AgentTrip`, `AgentEvent`. The board is a view over these; it is not a new table of cells.

### 5.2 Additions

On `Load`:
- `bolNumber String?` — BOL#.
- `customerName String?` — the yellow cell.
- `soldRateCents Int?` — SOLD RATE (RATE is `revenueCents`).
- `trackingUrl String?` — the Samsara/Motive/Linxup share link. Human-only; never scraped (§7.2).
- `shipDate DateTime?` — SHIP DATE, a date without a time.
- `updateText String?` — the dispatcher's UPDATE, verbatim.
- `apptText String?` — APPT SCHEDULE, verbatim (the parsed form lives in `Appointment`).

On `Load`, the carrier side of a brokered load (a brokered load has a carrier, not a driver, unless DRIVER CELL is filled):
- `carrierId String?` → `Carrier`.
- `carrierPhone String?` — with extension, as typed.
- `carrierContactName String?`.
- `driverCell String?` — E.164, optional. When present, the agent talks to the driver; when absent, to the carrier contact (§6.3).

On `Appointment`: `type` gains the value `"FCFS"`; `windowStart`/`windowEnd` carry the window.

New `AgentUpdate` (one row per agent line under UPDATE): `loadId`, `atMs BigInt`, `text String`, `kind String` (`status | eta | delivered | attention`). The agent never writes into `updateText`.

New `BoardLayout` per org: ordered column keys, display names, colors, `rowsPerLoad` (2), and which of our columns are shown. Seeded from the customer's header row at import.

### 5.3 Parsing the free text (and refusing to guess)

`APPT SCHEDULE` lines are parsed into `Appointment`:
- `PU: 07/14 - 12:00pm` → PU window 12:00–12:00 on 07/14 (org timezone).
- `DEL: 07/17 - 10:00am` → DEL deadline 10:00 on 07/17.
- `07-15 FCFS`, `08-15:00 fcfs` → type FCFS, window 07:00–15:00 / 08:00–15:00 that day.
- `07/14 - 07-15 FCFS` → date and window.
Year comes from SHIP DATE's year; a DEL earlier than PU rolls to the next day/month only if that makes it later, otherwise it is refused.

When a cell cannot be parsed, the load's agent pill shows **Attention: can't read DEL appointment** and the agent does not start on it. Nothing invents a deadline.

Cities: `PICK UP` + `PU ZIP` geocode to `LoadStop.lat/lng` through the platform's geocoder (ZIP first, city as a check). `geocodeStatus` records `ok | ambiguous | failed`; `failed` is another Attention.

### 5.4 The layout is data

`BoardLayout` is what makes the board "theirs". Import reads the header row and proposes the mapping (§9.1); the dispatcher confirms once. A second customer's board has different columns and the same code.

## 6. The agent in the board

### 6.1 The pill

Every load carries one pill in the AGENT column. States, in the order a night goes:

| Pill | Meaning | Color |
|---|---|---|
| — | not assigned yet, or shadow mode off and agent off for this load | grey |
| Watching | trip started; driver invited or tracking, nothing open | green |
| Asked | a question is open on the driver's page | amber |
| Calling | a voice rung is in progress or just happened | amber |
| Escalated | the dispatcher has been emailed (and called, if configured) | red |
| Delivered | arrived; on time or late shown in the tooltip | green, filled |
| Attention | the agent could not start or continue (missing phone, unreadable appointment, route unusable) | red outline |
| Shadow | the agent is watching but not allowed to talk (§6.5) | blue |

The pill's tooltip is one sentence in plain English from the last event: "Asked at 02:14, no reply yet", "Escalated 02:31: stop unresolved after 2 calls", "Can't read DEL appointment: '08-15:00 fcfs?'".

### 6.2 The UPDATE line

The dispatcher's UPDATE cell stays theirs. Under it, in the same cell area, the agent's latest line renders in their own wording, greyed and prefixed with a small agent mark:

- `EN ROUTE — 40 mi out, ETA 10:20`
- `STOPPED 25 min near Bethany, asked driver`
- `DELIVERED 07/15/2026` (on arrival, exactly their convention, so a human can copy it up into UPDATE with one click)
- `ATTENTION — can't read DEL appointment`

Every line is an `AgentUpdate` row; the history is in the drawer. A human's UPDATE text is never modified by the agent.

### 6.3 Who the agent talks to

Per load: `driverCell` if present, else `carrierPhone` with `carrierContactName` as the name. The invite says who it is talking to ("Hi Milan, this is the dispatch assistant for load 145219…"). The escalation email and the boss's briefing name the carrier and its MC number, because that is what the boss asks first.

### 6.4 The drawer

Click the pill: a drawer slides in from the right, the load stays visible.
- Header: LOAD#, customer, carrier and MC, the tracking share link as a button (opens in a new tab; human use only).
- The ladder as a timeline, newest first: every message with its text, every call with "answered / no answer" and the transcript verbatim, every escalation with its reason, every AgentUpdate line.
- Actions, the same ones the email offers: **Send the customer email** (only when a draft exists), **Call the driver now** (rung 3 on demand), **Stop the agent on this load** (records "stopped by dispatcher", pill goes grey).
- The driver's reply box for the dispatcher: a message typed here goes to the driver's page as the dispatcher, marked as human, and stops the ladder like a driver reply would.

### 6.5 Shadow mode

Per org, default ON for a new customer. The agent starts trips, detects, climbs the ladder, and writes every message it *would* have sent as an `AgentUpdate` of kind `status` with the prefix `would say:`. Nothing reaches a driver, a phone, or a customer. The dispatcher email and the boss's call are also off; the morning briefing is on. Turning shadow off is one switch in settings and is logged. A load can be excluded from the agent individually (§6.4, stop).

### 6.6 The morning filter

A board filter, "Night shift", shows every load the agent touched since the dispatcher's last login, sorted by the highest pill state reached. That is the morning briefing on the board; the email version is the same list.

## 7. Platform adapters for the agent

The agent's `ports/index.ts` does not change. Four adapters replace the standalone ones when the worker runs inside the platform.

### 7.1 Loads in — `PlatformLoads`

A load becomes a trip when: the carrier row is filled (`carrierId` set, a phone present) or an `Assignment` reaches `dispatched`, and PU and DEL appointments parse, and both stops geocode. The brief is built as: `loadRef = LOAD#`, `origin/destination = LoadStop lat/lng + city`, `equipment = requiredEquip`, `departAtMs = PU window start`, `deadlineAtMs = DEL window end`, `driverName/driverPhone` per §6.3, `customerEmail` from the customer record when known else null, `minutesSinceBreakAtDepart` from `HosState` when the driver is ours else null. Polling every 60 s over the org's open loads; the worker keeps a registry keyed by load id; a load that closes or is stopped is removed.

### 7.2 Location — `PlatformLocation`

Our drivers: the latest `DriverLocation` per assignment, read every minute, becomes the ping (the driver app already posts it). Brokered loads: the agent's link page, exactly as today, sent in the invite. The tracking share link in the sheet is never scraped: it is a human-only button. A spike (1 hour) will check whether Samsara, Motive, or Linxup share pages expose a clean data feed; if one does, it becomes a third source behind the same port, with consent recorded on the load.

### 7.3 Messenger — `PlatformMessenger`

Rung 1 (chat): our drivers get the message in the trip's conversation in the app with a push; brokered contacts get it on the link page. Rung 2 (SMS) and rung 3 (call) stay Twilio. The dispatcher's reply box in the drawer writes into the same conversation, marked `author: dispatcher`.

### 7.4 Sheet — `PlatformSheet`

`writeStatus` updates the load's pill state and appends an `AgentUpdate`; `appendLog` is the existing `AgentEvent`. A "sheet write" can no longer fail because of a quota; it can fail because Postgres is down, and the agent's existing Attention path handles that.

## 8. The cockpit side

- **Attention lane:** a strip on the cockpit and the load board listing every load whose pill is Escalated or Attention, newest first, with the one-sentence reason. Click opens the same drawer (§6.4).
- **Trip panel:** the cockpit's trip card gets a "Night shift" section: the pill, the last three ladder lines, the drawer button.
- The map shows the agent's last fix for brokered loads (from the link page) the same way it shows our drivers, marked as "driver link" in the legend.

## 9. Import and sync

### 9.1 Import `.xlsx` (this spec)

Import → choose file → we read the header row and propose the layout (column keys matched by name; unknown columns kept as extra text columns) → preview the first ten loads as row pairs → confirm. Rows become loads; unparseable cells become Attention pills, not import errors. The `ImportBatch` row records the file, counts, and the per-row notes. Re-importing the same file matches loads by LOAD#, then BOL#, and updates instead of duplicating.

### 9.2 Export `.xlsx`

Their layout, their colors, the agent's latest line placed under UPDATE. Always available.

### 9.3 Live Excel sync (next spec)

The Graph adapter from the agent's spec §4: poll the workbook, apply cell changes both ways with last-write-wins per cell and a conflict note in the drawer. Named here so the board's data model does not have to change to allow it: every board cell already maps to a column on a load.

## 10. Honesty and permission rules on the board

- The agent's text is always visibly the agent's (prefix, grey, `AgentUpdate`), and never replaces a human's cell.
- In shadow mode, nothing leaves the building; "would say:" lines are the proof of what it would have done.
- A customer email goes only on the dispatcher's click (drawer or email link), as in the agent's spec §8.
- Stopping the agent on a load is one click and is recorded with who did it.
- The tracking share link is a human-only button; the product never fetches it on the dispatcher's behalf without a consent record.

## 11. API

Under the dispatcher's auth, per org:
- `GET /api/dispatcher/broker-board` → layout + loads as row pairs with pill state and latest agent line.
- `PATCH /api/dispatcher/broker-board/loads/:id` → `{ column, value }` cell edits (server validates by column type; free text stored verbatim; parse results returned).
- `POST /api/dispatcher/broker-board/loads` → new blank pair.
- `DELETE /api/dispatcher/broker-board/loads/:id`.
- `POST /api/dispatcher/broker-board/import` (multipart `.xlsx`) → preview; `POST …/import/confirm`.
- `GET /api/dispatcher/broker-board/export.xlsx`.
- `GET /api/dispatcher/agent/loads/:id/events` → the drawer's timeline.
- `POST /api/dispatcher/agent/loads/:id/actions` → `{ action: "send_customer_email" | "call_driver" | "stop" | "reply", text? }`.
- `GET/PATCH /api/dispatcher/agent/settings` → `{ shadow: boolean, dispatcherPhone, quietHours }`.
- Realtime: the existing socket emits `agent:update` (load id, pill, line) so the pill changes without a refresh.

## 12. Testing

- Grid: a fixture of the customer's rows (anonymized) as the golden import; a test that import → export round-trips their layout byte-for-byte on the cells they typed.
- Parsing: every APPT SCHEDULE form seen in their sheet, plus the refusals.
- Adapters: each port adapter against the platform's test DB with the agent core's fakes elsewhere; the agent's own 190 tests untouched.
- Shadow mode: a full ladder run producing only `would say:` lines and no messenger, phone, or mailer calls.
- Drawer actions: `stop` halts the ladder and records who; `reply` stops the ladder like a driver reply.
- E2E (Playwright): import the fixture, see the pairs, edit a cell, see the pill move as the agent runs at demo speed.

## 13. Build order (each slice ships on its own)

1. **Schema + import + read-only board** — the customer's file appears as their board, pills grey. 1 week.
2. **Editing + export** — it is a sheet. 3 days.
3. **Agent adapters in shadow mode** — pills move, "would say:" lines appear, morning filter. 4 days.
4. **Drawer, actions, live mode switch** — the pitch. 3 days.
5. **Cockpit Attention lane + trip panel** — the second board. 2 days.
6. **Hosting** — always-on, fixed hostname, per-org numbers. 2 days.
Then: live Excel sync, TMS connectors, billing, the conversational call.

## 14. Open points

- Customer email addresses are not in the sheet; the customer record needs one field, or the customer email stays off for brokered loads until it is.
- Whether the boss's briefing call should go to the carrier as well when a carrier's driver is unreachable (today: no).
- After an escalation, the agent goes quiet on that load until a human acts (decided during the live run on 2026-09-07; to be implemented in the agent core before slice 3).
- The Samsara/Motive/Linxup feed spike (§7.2).

## 15. Slice 1 build notes (2026-09-07)

- `Appointment.type` keeps the platform's `pickup | delivery`; a window's first-come nature is `Appointment.kind` (`appointment | fcfs`). This refines §5.2.
- Unknown sheet columns are kept in the layout as `extra` in slice 1, but their values are not persisted yet (`Load.extras` lands in slice 2 with editing). Until then they render empty.
- Fleet loads (no BOL, no customer) appear on the Broker Board too — one truth — but without the yellow customer cell or the "MC" label.
- The npm build of SheetJS (`xlsx@0.18.5`) carries known advisories; acceptable for dispatcher-uploaded files now, to be swapped for a maintained build in the hosting slice.

### Inputs carried into slice 2 (from the slice 1 reviews)

- `Load.extras Json` — store the values of unknown sheet columns and render them (today the layout keeps the column, the values are dropped and the dialog says so).
- `Load.boardLoadNo` — the broker's LOAD# in its own column, so it never collides with a TMS load's `externalId` (slice 1 prefixes `board:` only on a collision and strips it on the board).
- `Load.boardLine` — the sheet's row order as data, replacing the `createdAt` ordering.
- Identifier-less loads (no LOAD#, BOL#, or order number) import as new each time; a fingerprint (customer + pickup + delivery + ship date) or a required LOAD# is a slice 2 decision.
- Layout changes: slice 1 re-saves the layout from every imported file; the mapper UI lets the dispatcher pin an order and rename labels.
- The import runs one load at a time (fine at 50 rows, ~2.5 s at 600); batch the writes before the first 500-load customer.
- Swap the npm `xlsx` build for a maintained SheetJS or ExcelJS in the hosting slice.
- Portal: `workbookForm` exists twice (api.ts and the store) because the specs mock the api module; fold when the store pattern is settled.

## 16. Slice 2A build notes (2026-09-08)

- Grid on TanStack Table v8 (headless); every cell is ours. Column state (visibility, order, sizes, density) lives per browser under `brokerBoard.columns.v1`; the server's layout wins on Reset.
- `Load.boardLine` is the sheet's row order; loads imported before this column exists sort after the sheet's until re-imported.
- Archive is `Load.status = "archived"`, hidden by default, shown greyed with one toggle; a re-import never changes an archived load's status and reports how many it left archived.
- Bulk archive/unarchive/delete are atomic per request and re-assert eligibility inside the write; an unexpected error is a clean 500 with nothing changed.
- The selection is reconciled with the board on every reload, so a bulk action can never name fewer loads than it sends.
- Export selected reproduces their layout and never adds or drops a cell; cells beginning with `=`, `+`, `-`, `@` export as text, not formulas.
- Carried to slice 2B: a "brokered only" or "sheet first" view for mixed orgs; export ignores local column prefs by design; a `col()` fallback for a stored order naming a column the layout no longer has; keyboard navigation (arrows, Space, Enter) with inline editing.

## 17. Decisions of 2026-09-11 — the switch and the setup

Two changes to §6–§8, decided in conversation after the whole flow was run end
to end on the real board.

### 17.1 The agent starts on an explicit switch, not on a rule

§7.1 said a load becomes a trip when the carrier row fills or an Assignment
reaches dispatched. That is replaced. **A load is watched only when a human
flips its Night Shift switch on.** The switch lives on the row (Their Board)
and on the brick (Cockpit); it is one field, `Load.agentEnabled`, and flipping
it is a traced write like any other. The agent never starts on its own.

Why explicit: the dispatcher decides which trucks get a night watcher, and the
act of switching it on is the moment they choose a policy for it. Auto-start
was rejected because it makes the agent a thing that happens to a load rather
than a thing a dispatcher does with one, and because "which loads did the
agent watch last night" must have a human answer.

### 17.2 Policies: the setup screen

The agent's behaviour is a **policy**, configured once and reused, not settings
typed per load. A policy is an org-scoped row with a name and:

- **Thresholds** — minutes stopped before it asks; minutes late before the
  delay ladder; minutes dark before it escalates; off-route miles.
- **Ladder timing** — minutes between rungs; how many driver calls before
  escalation.
- **Contacts** — dispatcher email; dispatcher phone for the briefing call
  (optional); whether the customer status email is on.
- **Permissions** — shadow (watch only, "would say:" lines, nothing sent) or
  live; whether the boss call is allowed; quiet hours.

An org starts with one policy, **Standard**, seeded with the thresholds the
live run of 2026-09-07 used. Two more are expected soon and are not built
now: a high-touch customer policy and a hazmat policy.

The **Night Shift** screen on the Control Tower lists the policies, edits
them, and shows which loads are on which. That screen is the pitch: it is
where a prospect sees that the agent is configurable and supervised, not a
black box. When the switch on a load is flipped on, the dispatcher picks the
policy (default: Standard) in the same gesture.

### 17.3 Supervision, not driving

Once on, a human supervises. The drawer of §6.4 keeps its actions and gains
two that the learning loop of the original spec depends on:

- **Correct** — "that was not a breakdown": re-labels the agent's
  classification of a driver reply. The correction is stored against the
  situation library for the human-approved proposal cycle.
- **I've got it** — the agent keeps watching and logging but stops talking to
  the driver and stops climbing the ladder until a human hands it back.

"Stop the agent on this load" remains and is the same as flipping the switch
off.

### 17.4 What stays as written

§6.1 pills, §6.2 the UPDATE line, §6.5 shadow mode (now a policy field rather
than only an org default), §6.6 the morning filter, §7.2–§7.4 the adapters,
§8 the Cockpit side. Slices 3, 4 and 5 of §13 are built as one plan.

### 17.5 Sequencing note

The driver-phone bridge — the driver app's trip screens read `Trip`, the
Cockpit writes `Assignment`, nothing links them — is a separate, smaller slice
and is NOT a prerequisite here: §7.2 reads our drivers' pings from
`DriverLocation`, which the app posts regardless of `Trip`. It is scheduled
immediately after this plan.
