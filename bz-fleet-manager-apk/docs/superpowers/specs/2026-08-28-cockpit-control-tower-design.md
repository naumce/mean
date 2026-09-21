# Cockpit Control Tower — Design Spec

> **Status:** approved design (2026-08-28), awaiting written-spec review → implementation plan.
> **Visual/behaviour spec:** `mockups/bertschi-master-cockpit.html` (the merged cockpit). Where this document and the
> mockup disagree, this document wins — it maps every cockpit feature onto *real* data.
> **Baseline:** portal 235 tests / 46 files + `vue-tsc` clean; backend 371 / 64 (verify with the chunked recipe in
> `SESSION-STATE.json` → `verification_status.backend`). Everything since commit `2f72c5f` is uncommitted by user rule.

## 0. Goal

Make the Bertschi-style **cockpit** a fully operable screen of the real product: a second Control Tower UI at
`/cockpit`, driven by `fleet-backend`'s dispatch engine and data, with every interaction the mockup shows
(drag-to-dispatch, move/resize, yard hook, ⚡Suggest, tenders, locks, fleet actions, drawer editing, checklists,
messaging, activity feed, GPS radar, Market / Money / Fuel & IFTA / Compliance views) working end-to-end, and an
app-wide light/dark theme where the cockpit palette is the dark preset.

## 1. Rulings (user, 2026-08-28)

| # | Decision | Consequence |
|---|---|---|
| R1 | **New `/cockpit` route, keep the existing `/loadboard` Control Tower** | No rewrite of `LoadboardView`; the cockpit reuses its stores/API. |
| R2 | **Light/dark toggle app-wide** | Semantic CSS tokens over Tailwind `darkMode:'class'`; cockpit components use tokens only. Legacy screens get a `dark:` pass as a slice. |
| R3 | **Illustrative data allowed, labelled** | Market spot benchmarks / forecast, static IFTA tax table, diesel price ship with an *illustrative* badge. Everything else is real. |
| R4 | No commits (standing rule) | Spec + plan live as files; verification gates replace commits. |
| R5 | US only | The mockup's EU toggle is dropped; engine is FMCSA. |

## 2. What exists (do not rebuild)

- **Engine** `fleet-backend/src/domain/dispatch/` — pure `evaluate()` (equipment, hazmat, availability, compliance,
  overlap, HOS w/ breaks, late pickup/delivery), `suggest()` scorer, `computeEconomics()`, mapper. 14 conflict kinds.
- **Commit engine** `routes/dispatcherAssignments.ts` — `POST /assignments` (dryRun / force), Serializable tx, HOS
  decrement + exact snapshot, `Rate` + `DeadheadLeg` + `DispatchConflict` rows, `savedMi`; `DELETE` restores HOS;
  `POST /:id/status` lifecycle `assigned → in_progress → completed`.
- **Read models**: `/loadboard`, `/suggest`, `/drivers/:id/next`, `/yard`, `/alerts`, `/risk`, `/kpis`, `/economics`,
  `/settlements`, `/fleet` + `/fleet/digest` + services/records, `/analytics/*`, `/locations`, `/conversations`.
- **Realtime** `/ws` — dispatcher events `board_update`, `driver_status`, `driver_location`; driver events incl.
  `trip_assignment`, `trip_unassignment`, `trip_started`, `trip_completed`, `general_notification`.
- **Portal**: stores `loadboard` (board data + WS + suggest/preview/assign/unassign/status/cancel/yard/kpis/risk),
  `loadDetail`, `fleet`, `economics`, `analytics`, `tracking`, `messages`, `importer`; pure `lib/board/geometry.ts`
  (UTC), `lib/board/urgency.ts`, `lib/hosFreshness.ts`, `lib/compliance.ts`, `lib/money.ts`, `lib/trend.ts`.

## 3. Gaps the cockpit needs (backend, all additive & org-scoped)

| Cockpit feature | Backend addition |
|---|---|
| 🔒 lane locks, `409 ENTITY_ALREADY_LOCKED` | in-memory lock table (realtime.ts) + `POST/DELETE /dispatcher/locks` + WS `lane_lock`/`lane_unlock`; lock check in assignment mutations |
| move / resize a brick | `PATCH /dispatcher/assignments/:id/plan` (restore snapshot → re-evaluate → re-snapshot, one tx) |
| tender → accept / decline | `POST /assignments {tender:true}`, `POST /assignments/:id/tender/accept|decline`; driver WS `trip_tender`; driver API `POST /api/driver/tenders/:id/accept|decline` |
| rest / shop / off / lockout blocks | `FleetAction` model + `GET/POST/PATCH/DELETE /dispatcher/fleet-actions`; engine busy intervals; `lockout` = hard block |
| tractor/trailer lanes, driver↔unit pairing | `Driver.defaultTractorId/defaultTrailerId`; `/loadboard` payload += `tractors[]`, `trailers[]`, `fleetActions[]`, `locks[]`, per-assignment `tractorId/trailerId/status/savedMi` |
| per-leg checklists | `Assignment.checks` (JSON) + `PATCH /assignments/:id/checks` |
| + New Transport Leg | `POST /dispatcher/loads` (reuses `loadIngest` validation + geocoding) |
| messaging in the cockpit, live | `emitToDispatchers(org,'message',…)` from the driver message route; org-scope `dispatcherComms` |
| Fuel & IFTA, Market tabs | `GET /dispatcher/fuel`, `GET /dispatcher/market` (real miles/loads + illustrative constants) |

## 4. Architecture

### 4.1 Frontend module (`fleet-portal`)

```
src/views/CockpitView.vue                 # route /cockpit (+ ?view=board|radar|market|money|fuel|comp)
src/stores/cockpit.ts                     # UI state only (see 4.2); composes data stores
src/stores/theme.ts                       # light|dark|system, persisted, applies <html class="dark">
src/lib/cockpit/geometry.ts               # tz-aware time↔pixel (wraps lib/board/geometry with an org-tz projection)
src/lib/cockpit/windows.ts                # free windows per lane → best 1-click match (pure)
src/lib/cockpit/drag.ts                   # pointer drag machine reducer (pure): move/resize/backlog/resource
src/lib/cockpit/deadhead.ts               # consecutive-leg deadhead connectors (pure; miles from server or haversine)
src/lib/cockpit/lifecycle.ts              # 8-step stepper derivation (pure)
src/lib/cockpit/format.ts                 # hrs(), fmtDayU(), money helpers not already in lib/money.ts
src/components/cockpit/
  CockpitHeader.vue      KpiStrip.vue        CockpitToolbar.vue
  GanttBoard.vue         TimeRulerX.vue      LaneRow.vue         LaneHeadDriver.vue  LaneHeadUnit.vue
  LegBrick.vue           OccupancyBlock.vue  MatchSlot.vue       DeadheadLine.vue    NowLine.vue
  BacklogPanel.vue       YardChips.vue       BoardLegend.vue     BrickPopover.vue
  MasterDrawer.vue       DrawerStepper.vue   DrawerChecklist.vue DrawerEconomics.vue DrawerLegChain.vue
  SuggestModal.vue       LoadFinderModal.vue NewLegModal.vue     FleetHudModal.vue   PlanVerdictModal.vue
  ActivityPanel.vue      ToastStack.vue      MessagesSlideOver.vue
  views/RadarView.vue    views/MarketView.vue views/FuelView.vue views/ComplianceView.vue views/MoneyEmbed.vue
```

- **Reuse first.** Data comes from the existing stores; the cockpit store never re-implements fetches that exist.
  New endpoints get actions on the store that owns the domain (`loadboard` for plan/tender/locks/fleet-actions/
  checks, `messages` for realtime, new `stores/market.ts` for fuel/market).
- **Pure libs are unit-tested** with fixed clocks; components are tested with `@vue/test-utils` + store stubs
  (existing pattern: `createStoreStub`, real `AxiosError` in error mocks).
- Route: `{ path: 'cockpit', name: 'cockpit', component: CockpitView }` under `AppShell`; nav item "Cockpit" first
  in *Operate*. `/` keeps redirecting to `loadboard` until the user flips it (not part of this spec).

### 4.2 `stores/cockpit.ts` (UI state)

```ts
view: 'board'|'radar'|'market'|'money'|'fuel'|'comp'
groupBy: 'driver'|'tractor'|'trailer'
days: 1|3|5|7;  dayOffset: number;  pxPerHour: number (10–72);  density: 'comfortable'|'compact'
filter: 'all'|'in_progress'|'haz'|'conflict'|'tendered';  equip: 'all'|TrailerType;  search: string
hazLoud: boolean;  marginView: boolean
selectedLoadId: string|null;  drawerMode: 'idle'|'edit'|'readonly'
locks: Record<laneId,{by:string; dispatcherId:string; since:string}>   // mirrored from WS
activity: ActivityItem[] (max 60, unread count)   // built client-side from WS + local actions
toasts: Toast[]
```
Getters: `boardConfig` (from days/offset/pxPerHour + org tz), `lanes` (driver|tractor|trailer projection over
`loadboard` data), `bricks` (loads → positioned legs incl. multi-day clipping), `occupancy`, `deadheads`, `matches`,
`spottedCount`, `conflictCount`, `kpis` (cockpit strip from `/kpis` + derived deadhead ratio/utilization/HOS gate/
compliance digest).

### 4.3 Theme (`R2`)

- `tailwind.config.js`: `darkMode: 'class'`; `theme.extend.colors` gains semantic tokens backed by CSS variables:
  `bg`, `surface`, `surface-2`, `surface-3`, `line`, `line-strong`, `ink`, `ink-2`, `ink-3`, `brand`, `brand-ink`,
  `brand-wash`, plus status tokens `s-assigned`, `s-progress`, `s-completed`, `s-tendered`, `s-open`, `haz`, `conflict`
  (each with a `-wash`). Values are `rgb(var(--tk-x) / <alpha-value>)`.
- `assets/main.css`: `:root { --tk-bg: 248 250 252; … }` (today's light look) and `.dark { --tk-bg: 4 7 17; … }` (the
  cockpit palette: `#040711`, `#060a14`, `#080c18`, `#020409`, slate-800 borders, etc.).
- `stores/theme.ts`: `mode: 'light'|'dark'|'system'`, `localStorage('fleet.theme')`, `matchMedia` listener,
  `applyTheme()` toggles `document.documentElement.classList('dark')`. Toggle button in `AppShell` header (◐).
- **Cockpit components use only token classes** (`bg-surface`, `text-ink-2`, `border-line`, `bg-s-progress/10`)
  so they render correctly in both modes; the dark preset *is* the mockup. Hard-coded hex is allowed only in the
  token definitions.
- Legacy screens keep `gray-*` classes; S5 adds `dark:` variants (or swaps to tokens) screen by screen.

### 4.4 Backend module layout (`fleet-backend`)

```
src/routes/dispatcherLocks.ts          # POST/DELETE /locks, GET /locks
src/routes/dispatcherFleetActions.ts   # CRUD /fleet-actions
src/routes/dispatcherPlan.ts           # PATCH /assignments/:id/plan, PATCH /assignments/:id/checks (new file — dispatcherAssignments.ts is already 417 lines; the shared commit-tx helpers move to src/lib/commitPlan.ts and both routers use them)
src/routes/dispatcherTenders.ts        # POST /assignments/:id/tender/accept|decline (+ driver side in routes/driver.ts)
src/routes/dispatcherMarket.ts         # GET /fuel, GET /market
src/lib/locks.ts                       # in-memory lock table + TTL sweep (pure-ish; injectable clock)
src/lib/fleetActions.ts                # busy-interval builder shared by assignments/plan/suggest/driverNext
src/lib/checklists.ts                  # default checklist per load (DVIR/PLACARD/RATE/SEAL/PRE-COOL/POD)
src/lib/stateTax.ts                    # static IFTA table (illustrative)
```
Mounted like the other Control Tower routers: `requireAuth + requireDispatcher + attachOrgScope`.

## 5. Data model changes (Prisma, additive; one migration `20260828120000_cockpit`)

```prisma
model Driver {
  // …existing
  defaultTractorId String?   // pairing shown in the lane header; seeds the assignment's equipment
  defaultTrailerId String?
}
model Assignment {
  // …existing; status gains "tendered"
  checks     String?        // JSON [{k,label,ok,at?,by?}] — checklist state (Postgres json later; String for parity with existing JSON-ish columns)
  tenderedAt DateTime?
  respondedAt DateTime?
  declineReason String?
}
model FleetAction {
  id        String   @id @default(uuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id])
  driverId  String?
  tractorId String?
  trailerId String?
  kind      String   // rest | shop | off | lockout
  label     String
  note      String?
  start     DateTime
  end       DateTime
  createdBy String?
  createdAt DateTime @default(now())
  @@index([orgId, start, end])
  @@index([orgId, driverId])
}
```
Rules: exactly one of `driverId | tractorId | trailerId` (Zod `refine`, same pattern as `ServiceRecord`).
`Load.status` already supports `tendered`; `Assignment.status` adds it. No changes to the legacy Trip domain.

## 6. API contract

All under `/api/dispatcher`, org-scoped, cross-org → 404. Money integer cents, miles float, ISO times.

### 6.1 `GET /loadboard?from&to` (extended, backward compatible)
```jsonc
{
  "lanes": [ { …existing, "defaultTractorId", "defaultTrailerId", "currentTractorId", "currentTrailerId",
               "hazmatEndorsed", "medicalCertExpiresAt", "cycleRemainingMin", "minutesSinceBreak",
               "lastLat","lastLng","lastLocationAt" } ],
  "tractors": [ { "id","unit","make","cab","status","inspectionExpiresAt","registrationExpiresAt","nextServiceAt","currentDriverId" } ],
  "trailers": [ { "id","unit","type","length","status","features","inspectionExpiresAt","registrationExpiresAt","nextServiceAt","currentDriverId" } ],
  "loads":   [ { …existing, "commodity","weightLbs","brokerName","unNumber","stops":[{"sequence","type","address","lat","lng","windowStart","windowEnd","dwellMin"}],
                 "assignment": { …existing, "tractorId","trailerId","status","savedMi","startedAt","completedAt","checks":[…],"tenderedAt" } } ],
  "fleetActions": [ { "id","kind","label","note","start","end","driverId","tractorId","trailerId" } ],   // overlapping the window
  "locks": [ { "laneId","by","dispatcherId","since" } ]
}
```
`currentTractorId/TrailerId` = equipment of the driver's active assignment (in_progress, else next assigned), else the
default pairing. `lastLat/lng` power the radar and the free-window origin.

### 6.2 Locks — `src/lib/locks.ts` + `dispatcherLocks.ts`
- Table: `Map<orgId, Map<laneId, {dispatcherId, name, since, expiresAt}>>`, TTL **90 s**, refreshed by `POST` (heartbeat
  every 30 s from the client while a lane is held), swept every 15 s.
- `POST /locks {laneId}` → `200 {lock}` (own or fresh) | `409 {error:"ENTITY_ALREADY_LOCKED", lock}`.
  `DELETE /locks/:laneId` → 204 (only the holder or an expired lock). `GET /locks` → snapshot.
- Lane id = driver id (locks are per-driver lane; tractor/trailer groupings lock the driver currently paired to that
  unit, else the unit id). Mutations (`POST /assignments`, `PATCH /plan`, `DELETE /assignments/:id`, tender routes,
  fleet-action CRUD on a driver) call `assertNotLockedByOther(org, laneId, dispatcherId)` → 409.
- WS: `lane_lock {laneId,by,dispatcherId,since}` / `lane_unlock {laneId}` to the org; disconnect of a dispatcher
  socket releases their locks (best effort; TTL is the guarantee).

### 6.3 `PATCH /assignments/:id/plan`
Body `{ driverId?, tractorId?, trailerId?, availableAt?, plannedEnd?, force?, dryRun? }`.
Semantics = *unassign + assign* in one Serializable tx: restore the HOS snapshot of the old plan, re-run `evaluate()`
with the new driver/equipment/`availableAt` (busy intervals exclude this assignment), optional `plannedEnd` override
(edge resize; must be ≥ engine `proposedEnd − 15 min`, else 422 `plan_too_short`), then re-snapshot HOS, rewrite
`Rate`/`DeadheadLeg`/`DispatchConflict`. Only `status in (assigned, tendered)`. Response = commit response shape.
Emits `board_update {loadId, assignmentId, driverId, replanned:true}`; if the driver changed, `trip_unassignment` to
the old driver and `trip_assignment` (or `trip_tender`) to the new one.

### 6.4 Tenders
- `POST /assignments {…, tender:true}` → identical to commit but `Assignment.status='tendered'`, `Load.status='tendered'`,
  `tenderedAt=now`, HOS decremented (capacity is held). Emits `trip_tender` to the driver + `board_update {tendered:true}`.
- `POST /assignments/:id/tender/accept` → `assigned`; `POST …/decline {reason?}` → full unassign path (HOS restore,
  load → `open`), `DispatchConflict{kind:'tender_declined', severity:'warn', detail}` for the alerts feed.
  Both emit `board_update`. Driver-side: `POST /api/driver/tenders/:id/accept|decline` (same handlers, driver auth,
  ownership check) so the mobile app can answer later; the cockpit's *Accept/Reject* buttons call the dispatcher routes.
- Yard/overlap/HOS treat `tendered` like `assigned` (`ACTIVE_STATUSES` += `tendered`).

### 6.5 Fleet actions — `dispatcherFleetActions.ts`
`GET /fleet-actions?from&to`, `POST /fleet-actions {kind,label,note?,start,end,driverId|tractorId|trailerId}`,
`PATCH /fleet-actions/:id`, `DELETE /fleet-actions/:id`. Zod: `end > start`, one target.
Engine integration (`src/lib/fleetActions.ts`): `busyIntervalsFor(org, {driverId|tractorId|trailerId}, excludeAssignmentId?)`
merges active assignments + fleet actions. `evaluate()` is unchanged; `lockout` actions additionally raise a
`{kind:'lockout', severity:'block', detail:label}` conflict from the route layer when the proposed plan starts before
`end` (surfaced as the blocked reason in ⚡Suggest, like compliance). `rankDrivers.ts` and `driverNext` use the same
builder. Emits `board_update {fleetAction:true}`.

### 6.6 Checklists — `PATCH /assignments/:id/checks {k, ok}`
Default list built at commit/tender (`src/lib/checklists.ts`): `DVIR`, `RATE` (label carries revenue), `SEAL` (#
derived), `POD`; `+PLACARD` when hazmat, `+PRE-COOL` when Reefer. Lifecycle side-effects: `status → in_progress`
sets `DVIR/SEAL/PLACARD/PRE-COOL` ok; `completed` sets all; POD toggles the derived stepper's last step.
Response `{checks}`; emits `board_update {checks:true}`.

### 6.7 `POST /loads` (manual leg)
Body = one `loadRowSchema` row (`externalId` optional → generated `L-<n>`), plus optional `stops[]` (≥2) to allow
multi-stop; geocodes via `geocode.ts`; 201 `{load}`; emits `board_update {created:true}`.

### 6.8 Messaging realtime
Driver `POST …/messages` (in `routes/messages.ts`; verify exact path at task time) → `emitToDispatchers(orgId,
'message', {conversationId, driverId, driverName, preview, at})`. `dispatcherComms.ts` gains `orgWhere` scoping
(`Conversation.driver.orgId`). `GET /conversations` already returns `unread`.

### 6.9 Fuel & Market — `dispatcherMarket.ts`
- `GET /fuel?from&to` → from `Rate` snapshots + org cost model: `{gallons, fuelSpendCents, mpg, fscRecoveredCents,
  jurisdictions:[{state, miles, gallons, rateCentsPerGal, taxCents}], totalTaxCents, illustrative:{taxTable:true}}`.
  Miles per state apportioned half origin / half destination from stop addresses (`parseCityState`).
- `GET /market` → `{origins:[{city, loadsOut, rpmCents, loadToTruck}], equipment:[{type, myLoads, myRpmCents,
  spotRpmCents, forecastRpmCents}], idle:{tractors, trailers, drivers}, illustrative:{spot:true, forecast:true}}`.
  `spotRpmCents` / `forecastRpmCents` are constants in `src/lib/marketBench.ts` (labelled).

### 6.10 Realtime event additions
To dispatchers: `lane_lock`, `lane_unlock`, `message`, and richer `board_update` payloads (`replanned`, `tendered`,
`accepted`, `declined`, `fleetAction`, `checks`, `created`). To drivers: `trip_tender {loadId, assignmentId}`.

## 7. UI specification (mockup → real data)

### 7.1 Header
Brand + dispatcher name (auth store) + lock state ("PESSIMISTIC LOCK: ON") + hotkeys hint; **Spot** input (search =
`cockpit.search`: matches load reference/origin/destination/commodity/broker/driver/unit; matches glow, others
dim; lane headers match on name/unit/location); view tabs (`?view=`); group seg; day seg (1/3/5/7 → `pxPerHour`
presets 60/22/14/11); zoom slider; ◀ range ▶ (`dayOffset`); 💬 (unread from `messages` store) and 🔔 (activity
unread); live clock (real `Date.now()` in org tz) + diesel price from the org cost model; theme toggle;
**+ New Transport Leg** → `NewLegModal`.

### 7.2 KPI strip (8 tiles)
| Tile | Source |
|---|---|
| Empty Mi Avoided (ROI PROOF) | `kpis.economics.emptyMilesSavedMi` × `allInCentsPerMi` |
| Committed Gross · N Active | sum revenue of `assigned/tendered/in_progress` in window (client) |
| Net Fleet Margin · % | `kpis.economics.marginCents`, `avgMarginPct` |
| Avg $/Loaded Mi · vs mkt | `ratePerLoadedMiCents`; "vs mkt" from `/market` equipment row (illustrative badge) |
| Deadhead Ratio | `kpis.economics.deadheadPct`, `deadheadMi` |
| Fleet Utilization | lanes with an active assignment today ÷ lanes not locked-out/off (client) |
| HOS Safety Gate | count of lanes whose planned drive today > `driveRemainingMin` (client, mirrors lane HOS bar) — red when > 0 |
| Inspection Alert | `fleet/digest` `expiredCount` / `dueSoonCount`; click → Compliance tab |

### 7.3 Board
- **Ruler**: day bands (TODAY / WEEKEND tags), hour ticks (3h, all hours when `pxPerHour > 40`), NOW flag.
- **Lane header (driver)** — avatar (initials, colour by driver id hash), name → `FleetHudModal`, status dot
  (`driver_status`), `#unit cab` (current tractor), 💬 with unread, trailer unit/type (current trailer) •
  telemetry (last ping speed/age from `tracking`; reefer setpoint from trailer `features`), badge row
  (compliance chips from clocks via `lib/compliance.ts`: DOT/REG/MED/PM; hazmat ✓ — the mockup's CSA score and
  subcontractor tag have no real source and are omitted), status pill derived (ENGINE LOCK / ROLLING / SERVICE DUE / RESTING / TENDERED /
  LOADING / AVAILABLE), lock badge (`locks[laneId]`). Clocks strip: 📍 last position city (reverse from nearest
  gazetteer city) + age; `DRV` = `driveRemainingMin`; `CYC` = `cycleRemainingMin`; HOS bar = planned drive today vs
  DRV; 📞 last check-call = last message/ping age; `⏱ to break` = `480 − minutesSinceBreak`; lane revenue/margin.
  HOS freshness chip (`hosFreshness`) is kept.
- **Lane header (tractor/trailer)** — unit, make/cab or type/length, DOT/REG/PM chips, paired driver, pill
  (IN SHOP / ROLLING / ASSIGNED / BOBTAIL; REG EXPIRED / DROPPED / HOOKED).
- **Brick** — step bar (4 segments from `lifecycle.ts`), id + equipment tag + broker + hazmat + badges
  (CONFLICT from `/alerts` block rows for the load, ≠ equipment if `trailer.type ≠ requiredEquip`, NO HZ ENDT,
  REG EXP, ⏰ LATE from `/risk`, ⏳ TENDERED — the mockup's +DET detention tag has no real source and is omitted),
  rate + $/mi, route + commodity/weight, checklist
  line (`assignment.checks`), margin; progress underline for `in_progress` (elapsed share of plan); stop dots;
  multi-day legs clip to the window; width-tiered content (≥230 full, ≥110 mid, else id).
- **Occupancy** — `fleetActions` by kind; lockout renders the full-width red block with `Unlocked: <end>`.
- **Deadhead connectors** — between consecutive legs of a lane when `prev.destination ≠ next.origin`; miles =
  `next.assignment.deadheadMi` when the next leg's deadhead originates at prev's drop (server), else haversine×1.2
  between stop coords (client, labelled ~).
- **Match slot** — `windows.ts` computes free windows from legs + fleet actions + `lastLocationAt`; best backlog
  load within 60 mi whose duration fits and whose pickup window isn't missed → "⚡ 1-Click Match" (commit via
  the normal drop flow, `availableAt = window.start`); else "Free in <city>" + ⚡ Match → `LoadFinderModal`
  (`/drivers/:id/next`).
- **Now line** at real now (org tz); Space / ⏱ button scrolls to it.
- **Backlog** — open + tendered-without-lane loads, urgency chip (`urgency.ts`), NEW badge for loads created in the
  last 10 min (webhook/`created`), ⚡ Suggest; draggable. **Yard** — `/yard` chips, draggable. **Legend**.

### 7.4 Master drawer (right, sticky)
Idle state (tips + latest activity). Selecting a leg acquires the lane lock; if another dispatcher holds it →
read-only mode with the holder's name. Sections: header (id · PESSIMISTIC LOCK · ✕), route + status/equip/haz
chips, quick actions (💬 Message driver → slide-over; ▶ Advance = `/status`; 🎯 Locate; ↩ Unassign; 🗑 Cancel
load w/ undo; Accept/Reject when tendered), lifecycle stepper (derived), physical asset specs (tractor/trailer +
clocks), route milestones (stops with ETAs from the plan; editable only when `open`), schedule & assignment
(driver/tractor/trailer selects → `PATCH /plan` when assigned; start/end → `/plan availableAt/plannedEnd`), freight
(open-only, `PATCH /loads/:id`), checklists (`PATCH /checks`), economics & cost model (live: dry-run `/plan` or
`/assignments` with the draft, debounced 400 ms; deltas vs saved), order legs chain (Collection → this leg →
Delivery derived from stops), footer: **Save changes** (diff-gated), ⚡ Push to driver app (`POST /drivers/:id/
notify`), Print rate con (`window.print()` on a print-styled drawer).

### 7.5 Modals
- `SuggestModal` — `/suggest?loadId`: ranked rows (#1 emerald, feasible amber, infeasible red with reason), each
  row *Commit & Assign* / *📤 Tender*; footer shows the org cost model.
- `PlanVerdictModal` — the drop/move verdict when the dry-run has blockers (conflict list ✗/⚠, economics, Force).
- `LoadFinderModal` — `/drivers/:id/next` ranked loads for a lane.
- `NewLegModal` — `POST /loads` with live economics preview (dry-run pricing computed client-side from cost model +
  haversine until the server prices it; label "est.").
- `FleetHudModal` — driver/unit specs + compliance from `/fleet` rows; Message button.

### 7.6 Views
- **Radar** — schematic SVG (real stop coords projected into the window's bounding box; routes coloured by status;
  in-progress pin at elapsed share along the curve; driver pins from `/locations` + `driver_location`) + telemetry
  table. Real tiles remain INC-M (out of scope).
- **Market** — `/market` (illustrative badge on spot/forecast columns).
- **Money** — embeds the existing `MoneyView` content (extract its body into `MoneyPanel.vue` used by both routes).
- **Fuel & IFTA** — `/fuel` (illustrative badge on the tax table).
- **Compliance & Maint** — digest cards + issues list + the three tables (`fleet` store; Log-service stays in `/fleet`).
- **Messages slide-over** — inbox + thread (`messages` store) with quick replies; realtime via `message` WS.

### 7.7 Activity feed & toasts
Client-side: every WS event and local action becomes an `ActivityItem {kind, title, sub, loadId?, at, read}`;
bell dropdown lists them; toasts (max 4, 5 s) for the same; clicking jumps to the leg (`jumpToTrip`). Persisted
`/alerts` rows are merged in as `conflict` items on load.

## 8. Interaction flows (engine-authoritative, never optimistic)

| Gesture | Calls | Outcome |
|---|---|---|
| Drop backlog card on lane at X | `POST /locks` → `POST /assignments {dryRun}` (`availableAt=xToTime(X)`, equipment = lane pairing or `/suggest` pick) → feasible ⇒ `POST /assignments`; blocked ⇒ `PlanVerdictModal` → Force | brick lands, toast, drawer opens on the new leg |
| Move brick (lane/time) | `PATCH /plan {driverId?, availableAt, dryRun}` → commit or verdict | same |
| Edge resize | `PATCH /plan {plannedEnd}` (right) / `{availableAt}` (left) | |
| Drag yard chip on lane | tractor/trailer → `PATCH /drivers/:id {defaultTractorId|defaultTrailerId}` (+ `PATCH /plan` for that lane's assigned legs when equipment changes); driver chip on unit lane → same pairing from the other side | |
| ⚡ Commit / Tender | `POST /assignments` (`tender`) | |
| Accept / Reject | `/tender/accept|decline` | |
| Advance | `POST /assignments/:id/status` | |
| Lock refused | any mutation → 409 `ENTITY_ALREADY_LOCKED` → red toast, board re-fetch | |

Every mutation is followed by the existing `loadboard.load()` refresh (plus kpis/alerts/risk/yard), as today.

## 9. Time & geometry

- Day window **06:00–24:00** in the **org timezone** (`auth.dispatcher.org.timezone`; fallback `America/Chicago`).
  `lib/cockpit/geometry.ts` projects ISO instants to "wall minutes since window start" using `Intl.DateTimeFormat`
  parts (pure, memoised per day), then delegates to the existing math. `xToTime` returns an instant (ISO) for
  `availableAt`. 15-minute snapping retained.
- `NOW` is real; tests inject `nowMs`.

## 10. Error handling

- All API errors surface via `extractApiErrorMessage` into a conflict-styled toast; 422 verdicts open
  `PlanVerdictModal`; 409 lock → lock toast + refresh; WS disconnect → header LIVE pill turns grey ("reconnecting")
  and re-fetch on reconnect (existing store logic).
- Drawer edits are diff-gated; leaving the cockpit releases held locks (`DELETE /locks`), and the TTL covers crashes.

## 11. Testing & gates

- Backend: route tests per new endpoint (Supertest, org-scope + 409 lock + tender lifecycle + plan restore/re-snapshot
  exactness + fleet-action busy intervals + lockout block), unit tests for `locks.ts` (TTL/sweep with fake clock),
  `checklists.ts`, `stateTax.ts`; mapper/rankDrivers busy-builder tests. Run with the chunked recipe.
- Portal: unit tests for every `lib/cockpit/*` (fixed clock/tz), component specs (LegBrick tiers/badges, LaneHead
  pill derivation, MatchSlot, MasterDrawer diff-gate + lock read-only, SuggestModal ranking render, KpiStrip), store
  specs (`cockpit` getters, `theme`), view smoke (CockpitView mounts with stubs). Gates: `npx vitest run`, `npx vue-tsc
  --noEmit`, `npm run build`.
- Live: extend `smoke-control-tower.mjs` with lock 409, plan move, tender accept/decline, fleet-action block; seed
  `seed-demo.mjs` gains fleet actions (Maria rest + PM, Dale lockout), pairings, a tendered load, checklists.
- Demo film: one cockpit scene (S5).

## 12. Slices & acceptance

| Slice | Delivers | Done when |
|---|---|---|
| **S0** Theme | tokens, `darkMode:'class'`, `theme` store, shell toggle, shell/nav on tokens | toggle flips the whole shell; existing screens still pass their specs |
| **S1** Read-only cockpit | route, header, KPI strip, toolbar, ruler, driver lanes (composite headers), bricks, now-line, deadheads, window/zoom/density/filters/spot, legend, backlog, yard, activity feed, radar; loadboard payload extension (§6.1, minus locks/fleet actions) | live seed renders like the mockup in dark; all counts/labels traceable to API fields |
| **S2** Interactions | drag-to-dispatch, move/resize (`/plan`), yard hook (pairing), SuggestModal, LoadFinder, MasterDrawer (inspect/edit/advance/unassign/cancel/message/push), locks + presence, PlanVerdictModal, toasts | every §8 row works live; lock 409 demonstrated with two sessions |
| **S3** Fleet actions & grouping | `FleetAction` CRUD + engine busy/lockout, tractor/trailer grouping, free windows + match slots, checklists + stepper, tenders (+driver routes), NewLegModal, FleetHud | Maria's rest/PM + Dale's lockout render and block; tender round-trip; 1-click match commits |
| **S4** Views | Market, Fuel & IFTA, Compliance, Money embed, MessagesSlideOver + `message` WS, comms org-scope | tabs live; illustrative badges present |
| **S5** Dark pass + polish | `dark:`/tokens on legacy screens, print stylesheet, cockpit film scene, README/SESSION-STATE update | every route renders correctly in both modes |

## 13. Out of scope (explicit)

Real map tiles (INC-M), EU/ADR mode, IFTA filings, invoicing/settlement persistence, ELD/TMS live integrations,
driver mobile UI for tenders/checklists (routes are provided), replacing `/loadboard`, changing the `/` redirect.

## 14. Risks

- **HOS re-snapshot on `/plan`** is the trickiest tx (restore → evaluate → decrement); it must be exact and covered
  by a round-trip test (`plan` back to the original produces identical `HosState`).
- **Locks are in-memory** — a multi-instance deploy needs Redis later; acceptable for the single-container compose.
- **Timezone projection** changes how the cockpit reads vs `/loadboard` (UTC); both are correct, but window
  boundaries differ — the cockpit passes tz-aware `from/to` to the API.
- **Tailwind Play vs build**: cockpit classes are compiled by the real Tailwind build; arbitrary values from the
  mockup (`text-[9px]`, `bg-[#020409]`) are replaced by tokens/utilities.
