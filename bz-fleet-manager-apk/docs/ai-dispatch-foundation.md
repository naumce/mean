# AI Dispatch Foundation

What the AI-dispatch laboratory now contains, what stays deterministic and why, how to drive the demo, and what is deliberately not built yet.

Every claim below was checked against the code as committed on `feat/dispatch-control-tower` (the twelve feature commits `a9b75b1`..`8347126`, plus the review-fix commit `7c91f19`).

## 1. What this is

This feature turns the existing Control Tower dispatch board into a laboratory for testing AI-assisted dispatch ideas without actually running one.

It adds an evidence-based picture of every driver (where they'll be free, how they've actually performed, what they prefer), a real `Customer` entity instead of free text on a load, a "why this driver" context line on every dispatch candidate, a deterministic demo world with 14 named scenarios, a lightweight simulation to move that world forward in time, and a catalogue of 17 read-only functions a future AI model could call.

Log in as `w@fleet.com` / `pass123` — the demo organization is "Great Lakes Freight Co". From there:

- Click **Driver Supply** in the left nav (`/supply`) to see every driver's status, location, load, HOS and equipment on a map and in a table.
- Open a load on the Control Tower board and click **⚡ Suggest** to see the same evidence attached to each ranked driver.
- Open a driver's row on Driver Supply, then their drawer, to copy their personal `/driver/:token` link — a page a driver (or you, standing in for one) can open to toggle location sharing and availability, or feed it a test position.

Two facts hold everywhere in this feature.

First, **no LLM is wired into dispatch**: there is no `@anthropic-ai/sdk` import, no prompt, and no model call anywhere under `fleet-backend/src` for any of it — confirmed by searching the whole tree. (Night Shift's own, separate, pre-existing use of Claude for phone conversations and reply classification is untouched and out of scope; see `docs/current-system-architecture.md` §0 and §6 for that system.)

Second, **the deterministic engine still decides**: `fleet-backend/src/domain/dispatch/*` — the code that scores and ranks drivers — has a `git diff` of zero across all twelve commits of this feature. Everything described below is new data, an additive field, or a read of data that already existed.

`docs/current-system-architecture.md` §8 separately marks existing decision sites in the *rest* of the platform with `[AI CANDIDATE]` — it proposes nothing, and this feature builds none of them. This document only covers what actually shipped.

## 2. What was added

### Data model (`fleet-backend/prisma/schema.prisma`)

| Model / fields | Purpose |
|---|---|
| `Driver` (additive) | `firstName`, `lastName`, `homeBaseCity`, `homeBaseState`, `preferredLanguage` (default `"en"`), `languages[]`, `yearsExperience`, `timezone`, `endorsements[]`, `equipmentTypes[]` — profile and qualification data for matching and display. **`Driver.name` remains the one field every existing screen reads for a driver's display name**; `firstName`/`lastName` are additive and are rendered only by the new driver page's greeting (they are also returned, unrendered, by `GET /drivers` and the `getDriver` tool). |
| `DriverAvailability` (1–1 with `Driver`) | `acceptingLoads`, `availabilityStatus`, `availableAt/Lat/Lng/City/State`, `locationSharingEnabled`/`UpdatedAt`, `shareToken` (unique, authenticates the driver page), `source` (`manual`/`derived`/`simulation`). One row per driver; a missing row is a valid, documented state — there is no database trigger that creates one. |
| `DriverPreference` (1–1) | `maxTripMiles`, `preferredRegions[]`, `preferredLanes[]`, `avoidRegions[]`, `avoidLanes[]`, `homeTimeTarget`, `willingToDriveNight`, `willingToRelocateMiles`, `preferredEquipment[]`. Read only as candidate *context* (§6) — never a feasibility filter. |
| `Customer` | `name` (unique per org), contact fields, `preferredCommunicationChannel`, `priority` (`standard`/`high`), notification thresholds. `Load.customerId` is a **nullable** foreign key (`onDelete: SetNull`) that the load writer **derives** from `Load.customerName` — see §5. `Load.customerName`/`customerEmail` remain the columns every existing write path actually writes. |
| `SimulationState` (one row per org) | `running`, `speed`, `simMinutesAdvanced`, `lastTickAt`, `seed` — the simulation's own clock. |
| `SimDriverState` (1–1) | `mode` (`auto`/`stopped`/`dark`/`offroute`/`idle`), `modeUntil`, `offsetLat`/`offsetLng` — a perturbation layered on top of a driver's real/derived position, never a replacement for it. |
| `AiExperiment` / `AiDecisionRecord` | An append-only audit schema for a future AI harness: a named run, and one record per decision it proposed (context, tool calls/results, proposed vs. human decision, eventual outcome). `AiDecisionRecord.loadId`/`driverId` are plain indexed strings with no foreign key, so an audit trail survives the load or driver it refers to being deleted. **Nothing writes to either table yet** — there is no `.create`/`.update`/`.upsert` call against either model anywhere in `fleet-backend/src`. |

The migration back-fills three things on existing rows, each guarded so it only ever fires once:

- `Driver.firstName`/`lastName` split an existing `name` on the first space (`lastName` is `null`, not `""`, when there was no second word).
- `Driver.homeBaseCity`/`homeBaseState` are parsed out of `homeBase` only when it already matches the literal shape `"City, ST"` — a freeform `homeBase` value is left alone rather than mis-parsed.
- One `Customer` row is created per distinct, non-blank `Load.customerName` already on the org's loads (`primaryEmail` taken from the first non-null `customerEmail` sharing that name), immediately followed by pointing every matching `Load.customerId` at the row it created.

### Services (`fleet-backend/src/lib/`)

| File(s) | What it does |
|---|---|
| `driverAvailability.ts` | `projectAvailability`, `deriveStatus`, `availabilityFor` — the one shared "where and when will this driver be free" projection (§3). |
| `customers.ts` + `onTime.ts` | `customerHistory`; the shared late/on-time arithmetic (`isLateAssignment`, `lateMinutes`, `deliveryWindowEndOf`) that both `customers.ts` and `driverMetrics.ts` import rather than each defining its own copy. |
| `driverMetrics.ts` + `driverResponseMetrics.ts` + `driverHistory.ts` | `driverMetrics`/`driverMetricsBatch` (§4); the Night-Shift-evidence parsing isolated into its own file; the plain completed-assignment list behind `GET /drivers/:id/history`. |
| `dispatchTools/*` (9 files) | The 17 read-only functions plus the zod manifest (§7). |
| `candidateContext.ts` | Builds the `CandidateContext` block attached to ranked dispatch rows (§6). |
| `suggestForLoad.ts` | The `/suggest` pipeline (load → candidate pool → ranking) extracted out of the route into a plain, directly-callable function. |
| `assignmentLifecycle.ts` | `transitionAssignment`, extracted from `POST /assignments/:id/status` — now the one status-change path shared by a dispatcher's own Start/Deliver click and the simulation's tick. |
| `simulation/engine.ts`, `movement.ts`, `runner.ts` | `tick()`; pure geometry (great-circle interpolation, position-along-route, east-offset conversion); one `setInterval` per org. |
| `lanes.ts` additions | `laneRunsByDriver` (new) and `laneRunCounts` (new). `laneFamiliarity` — the function the suggest score actually uses — is untouched and now simply calls `laneRunsByDriver` for its raw counts. |

### HTTP routes

Every route below sits under `/api/dispatcher` or `/api/driver-page`, except `GET /driver/:shareToken`, which is mounted at the app root (see the table).

All `/api/dispatcher` routes pass through one structural gate (`apiKeyAuth` → `requireAuth, requireDispatcher, attachOrgScope` → `apiKeyAllowList`, `app.ts:176-184`) before reaching any router. None of the routes below are on the API-key allow-list (`middleware/apiKeyAuth.ts`), so an `x-api-key` caller (e.g. Night Shift's own MCP tools) cannot reach any of them — only a dispatcher's bearer session can.

| Route(s) | File | Auth |
|---|---|---|
| `GET /drivers/availability`, `GET/PATCH /drivers/:id/availability`, `GET /drivers/:id/metrics`, `GET /drivers/:id/history`, `GET/PATCH /drivers/:id/preference` | `dispatcherDriverSupply.ts` | dispatcher session |
| `GET/POST /customers`, `GET/PATCH /customers/:id`, `GET /customers/:id/history`, `GET /customers/:id/loads` | `dispatcherCustomers.ts` | dispatcher session |
| `GET /tools` | `dispatcherTools.ts` | dispatcher session (deliberately excluded from the API-key allow-list — see §7) |
| `GET /loads/:id/candidates/:driverId` (new); `GET /suggest` (pre-existing path, now also returns `context` per candidate) | `dispatcherSuggest.ts` | dispatcher session |
| `GET /sim/state`, `POST /sim/tick`, `POST /sim/start`, `POST /sim/stop`, `POST /sim/drivers/:id/mode`, `POST /sim/reset` | `dispatcherSim.ts` | dispatcher session **and** `DEMO_MODE === "true"` (else 404 — see §9) |
| `GET /driver/:shareToken` (HTML page) | `driverAvailabilityPage.ts`, mounted directly on `app` (not under `/api/dispatcher`) | none — authenticated by the `shareToken` in the URL, rate-limited to 120 requests/minute |
| `GET/PATCH /api/driver-page/:shareToken/availability`, `POST /api/driver-page/:shareToken/ping` | `driverAvailabilityPage.ts` | same — `shareToken` only, rate-limited |

Mount order matters for the driver page: `app.use(driverPageRouter)` sits at `app.ts:263`, immediately before `mountHosting(app)` at `:266`. The SPA's catch-all fallback only takes over a `GET` when nothing earlier matched a route, so if the driver page router were mounted after `mountHosting`, every `/driver/:token` request would silently return the SPA's `index.html` instead of the page.

### Portal (`fleet-portal/src/`)

| Piece | File(s) |
|---|---|
| Driver Supply view | `views/DriverSupplyView.vue`, `stores/driverSupply.ts` — a map (`components/tracking/FleetMap.vue`, driver markers colored by status) plus a filter bar (status, equipment, language, home-base state, accepting-loads-only) above a 10-column table |
| Driver Supply row | `components/supply/DriverSupplyRow.vue` — NAME · STATUS · CURRENT · CURRENT LOAD · DELIVERY ETA · PROJECTED AVAILABILITY · HOS · EQUIPMENT · LANGUAGES · HOME BASE |
| Driver drawer | `components/supply/DriverDrawer.vue` plus four sections: `DriverAvailabilityControls.vue` (toggle/status/PATCH), `DriverEvidencePanel.vue` (metrics, nulls rendered as "—", top-5 lane experience), `DriverPreferencesForm.vue`, `DriverHistoryList.vue` (last 10 loads); `DriverSimulationControls.vue` (per-driver mode, gated on `sim.available`) |
| Suggest panel context | `components/cockpit/CandidateContextCell.vue`, wired into the existing `SuggestModal.vue` under every candidate row, including blocked/infeasible ones |
| Simulation controls | `stores/sim.ts`, `components/sim/SimControls.vue` — mounted above the map on Driver Supply and at the end of the Cockpit toolbar; renders nothing once its first probe of `GET /sim/state` comes back 404 |
| Typed endpoints | `lib/api.ts` — Driver Supply, preference, and simulation functions added in the file's existing typed-function convention (now 796 lines; see §12) |
| Nav | `router/index.ts` (`path: 'supply'`, name `driver-supply`), `layouts/AppShell.vue` (`Driver Supply` entry in `TOWER_PRIMARY`, right after `Control Tower` — tower tier only, absent on a sheet-tier org) |

No dedicated Customer-management screen was built in the portal. The `Customer` entity is reachable through its backend routes and through anywhere `customerName` already surfaced (the Cockpit's Night Shift drawer, the new driver-history rows), not through a new page.

### Seed

`fleet-backend/seed-world.mjs` (CLI entry + `seedWorld(prisma, {scale, now})`) plus 24 helper modules under `fleet-backend/seed-world/` — PRNG, geometry, time, names, cities, shared constants, targets, scenarios, cast, customers, economics, lanes, agent evidence, detention, pings, drivers, history, named history, the two scenario builders and their `scenarioLoads.mjs` orchestrator, fleet, and purge.

`start.sh` recognizes `SEED_DEMO=seed-world.mjs` alongside the two pre-existing seed scripts.

## 3. How a driver's availability is derived

Every availability read (`GET /drivers/:id/availability`, Driver Supply, the Suggest panel's context, the driver page) goes through one function, `availabilityFor()` in `src/lib/driverAvailability.ts`, which merges a driver's explicit `DriverAvailability` row (if any) with a computed projection.

**The projection** (`projectAvailability`) is exactly the rule `dispatcherDriverNext.ts` used to inline, now shared:
1. If the driver has a current active assignment, take that assignment's **last geocoded delivery stop** — the position becomes that stop's lat/lng/city/state, and the "available at" instant becomes the assignment's `plannedEnd`.
2. Otherwise, if the driver has a last GPS ping (`Driver.lastLat/lastLng`), use that position, available "now".
3. Otherwise, no position is known at all (`basis: "none"`).

**The five statuses**, derived in this exact order (`deriveStatus`):
1. A row with `source === "manual"` whose `availabilityStatus` is `OFF_DUTY` or `UNAVAILABLE` wins outright and stops here.
2. Otherwise, an active assignment → `AVAILABLE_SOON` when its `plannedEnd` is within 4 hours of now, else `ON_LOAD`.
3. Otherwise, `acceptingLoads` → `AVAILABLE`.
4. Otherwise → `UNAVAILABLE`.

**What "manual override" means.** A row counts as a manual status override only when a dispatcher's `PATCH` explicitly included `availabilityStatus` in its body.

A `PATCH` that sets only `acceptingLoads` or a location field writes `source: "derived"` on a fresh row (or leaves an existing row's `source`/`availabilityStatus` untouched on update) — it never silently creates or clears an override. This rule was tightened once during Task 2's review: the first version wrote `source: "manual"` on any `PATCH` at all, which meant a driver's very first toggle (before any dispatcher had set a status) could freeze them at the schema's own `UNAVAILABLE` default forever.

Location fields (`availableLat/Lng/City/State/At`) are simpler: any individually non-null value on the row wins over the projection field-by-field, regardless of `source`. In practice only a dispatcher's manual `PATCH` ever sets them: the simulation (§9) writes only `availabilityStatus` and `source: "simulation"` on its own upserts, always clearing these five columns to `null` — so the live projection stays authoritative for every non-manual row: the last geocoded delivery stop plus the assignment's `plannedEnd` while the driver is on a load, else the driver's last ping and (within 3 miles) its nearest known place.

**What the driver's own toggles do and do not do.** The driver page's `PATCH .../availability` body only ever contains `acceptingLoads` and/or `locationSharingEnabled` — it has no `availabilityStatus` field at all, so a driver toggling their own page can never create or clear a manual status override. It only changes whether they're accepting loads and whether they're sharing location, and stamps `locationSharingUpdatedAt` only when sharing actually changes.

**`source` values**: `"manual"` (a dispatcher `PATCH` that explicitly set `availabilityStatus`), `"derived"` (any other dispatcher `PATCH`, or a driver's own toggle), `"simulation"` (Task 8's tick, written for any row that isn't already `"manual"`), and the reported value `"none"` (no `DriverAvailability` row exists at all — a property of the returned view, never a value stored in the database).

Concretely: a driver who is `in_progress` on a load whose `plannedEnd` is six hours away reads `ON_LOAD`. The moment that same load's `plannedEnd` comes within four hours — with nothing else about the assignment changing — the identical driver reads `AVAILABLE_SOON`. Only the clock moved.

Separately from the projection above, `DriverAvailabilityView.current` reports the driver's raw last ping (`lat`/`lng`/`at`) plus `near` — the nearest gazetteer-known place to that ping (`geocode.ts`'s `nearestKnownPlace`, `null` beyond a 150-mile ceiling, so a ping in the middle of nowhere is reported as "no known place nearby" rather than a wrong guess). This is what Driver Supply's CURRENT column actually renders; it is a fact about the ping, independent of the projected/available fields described above.

## 4. Evidence, not opinions

`driverMetrics()`/`driverMetricsBatch()` (`src/lib/driverMetrics.ts`) compute every number from rows that already existed before this feature — completed `Assignment`s and their stops/appointments, `scanDetention`'s own claims, and the Night Shift agent's `AgentTrip`/`AgentEvent` trail.

- **On-time / late** (`onTimeRate`, `onTimeLoads`, `lateLoads`, `averageDelayMinutes`): a completed assignment is late when `completedAt` is after the delivery window end (the last stop typed `"delivery"`'s `Appointment.windowEnd`, or the load's last stop's own appointment if none is typed `"delivery"`). A completed load with **no** delivery window at all is excluded from both the numerator and denominator — never silently counted as on-time.
- **Detention** (`averageDetentionMinutes`): the mean of `scanDetention`'s claims for that driver's stops over the trailing 365 days, counting **only claims with an owed amount** (`claim !== null`) — a real, well-evidenced dwell that stayed inside the agreed free window (`claim: null`) does not pull this average toward zero. The candidate-context path (§6) opts out of this scan entirely (`includeDetention: false`) since nothing there displays it; a skipped scan reports `null`, never `0`.
- **Response time / rate** (`averageResponseMinutes`, `responseRate`): replayed from `AgentEvent` rows on the driver's `AgentTrip`s. A text "ask" (an `action` event whose evidence kind is `message`, `message_again`, or `sms` — a phone `call` is a separate event kind and never counts as a text question) opens one open question; a second ask before any reply does not open a second one. The next `reply` event on that trip, whatever it says, closes it. `averageResponseMinutes` is the mean minutes-to-close over every closed question (`null` if none ever closed — never `0`, which would claim a reply that never happened); `responseRate` is closed/opened (`null` if nothing was ever asked).
- **No-response incidents**: `escalation` events whose reason text contains "unresolved" or "could not reach".
- **Breakdown / accident incidents**: `reply` events whose `situationKey` is `"breakdown"`/`"accident"`, counted regardless of whether that reply happened to close an open question.
- **Night loads**: completed assignments whose `plannedStart` falls at or after 20:00, or before 06:00, in the **org's own timezone** (`Intl.DateTimeFormat`, defaulting to `America/Chicago` when `Org.timezone` is unset).
- **Lane experience**: the driver's top 10 lanes by completed-run count (ties broken by most recent), keyed by pickup/delivery stop **type** — the same convention the suggest score's lane-familiarity weight uses, not the coarser by-position rule `customerHistory` uses for its own lane list.
- Attribution of an `AgentTrip` to a driver uses the load's assignment of **any** status, not just completed — a Night Shift trip is normally still open while its load is `in_progress`. A trip whose load has no assignment at all belongs to nobody.
- `evidence: {assignments, agentTrips, agentEvents}` reports how much raw material backs the numbers above — evidence about the evidence.

A driver who has never had an agent text message sent to them at all (no `AgentTrip`, or one with no ask) shows `responseRate: null` and `averageResponseMinutes: null` — never `0`. The difference between "never asked" (`null`) and "asked and it just hasn't been answered yet" is preserved throughout `DriverMetrics`; nothing here collapses "no evidence" into a number that looks like bad evidence.

`driverMetricsBatch(orgId, driverIds, nowMs?, opts?)` is the function the batch caller (§6's candidate context) actually uses; `GET /drivers/:id/history` reads `lib/driverHistory.ts` and computes no metrics at all. `driverMetrics()` for one driver is implemented as a one-element call to `driverMetricsBatch`, never a second copy of the aggregation.

Its query count is fixed regardless of how many `driverIds` are requested: one `assignment.findMany` covering every requested driver, one `org.findUnique` for the timezone, one `agentTrip.findMany` covering every load those assignments touch, and (unless `opts.includeDetention` is `false`) one `scanDetention` call — never one of these per driver. Each `LaneExperience` entry returned is `{laneKey, originCity, destCity, runs, lastRunAt}`.

No subjective or self-reported driver field exists anywhere in this feature — no "reliability", "rating", or "recommended" column, on `Driver`, `DriverMetrics`, or `CandidateContext`. **Nationality is never a field or a ranking input anywhere in the schema or the scoring/context code** — `languages[]`/`preferredLanguage` exist solely for communication.

## 5. Customers

`Customer` (schema, §2) is resolved from `Load.customerName` — the free-text column Broker Board, paste, import, and sheet sync all already wrote — by `deriveCustomer()`, wired into `loadWriter.ts`'s `applyLoadChange`, the one function every load write in the system goes through (board edits, paste, import, webhook, sheet sync, and the Night Shift agent's own writes all call it).

On any write:

1. A direct `customerId` in the patch wins: `null` detaches (`Load.customerId` set to `null`); a real id is validated against the org before being applied.
2. Otherwise, if `customerName` is part of *this* write and its value actually changed, the customer is found-or-created by exact trimmed name (`@@unique([orgId, name])`, no case folding) — a blank name **detaches** the load from its customer. This reverses the plan's original "leave untouched" text; the reasoning recorded in the ledger is that it mirrors the existing carrier-detach behavior and keeps customer history honest.
3. Otherwise, if the load's `customerId` is still `null` but its stored `customerName` is non-blank, the load bootstraps a link the moment *anything else* about it is saved. This is what lets a load written before this feature existed (or written by import/sheet-sync, which have no idea `Customer` rows exist) catch up with zero changes to those callers.

`customerHistory(orgId, customerId)` returns:

- `totalLoads` / `completedLoads` / `lateLoads` — plain counts over every load linked to the customer.
- `onTimeRate` — the same late rule as §4 (`completedAt` vs. delivery-window end), `null` when nothing is evaluable.
- `commonLanes` — the top 5 lanes by run count, keyed by first/last stop **position** (deliberately coarser than the driver-lane rule in §4, which keys by stop **type**; this is a display-only rollup, not a scoring input).
- `detentionEvents` — claims with an owed amount only (`claim !== null`), over a trailing **180-day** window — a different lookback from `driverMetrics`'s 365 days, since the two answer different questions (a customer's recent pattern vs. a driver's whole track record).
- `lastLoadAt` — the most recent load's `createdAt`, not `shipDate`, since `shipDate` can itself be a cell the writer refused to read.

`PATCH /customers/:id` renaming a `Customer` does **not** cascade to `Load.customerName` on loads already linked to it (confirmed: `dispatcherCustomers.ts`'s update handler writes only the `Customer` row) — only the writer's own read of a freshly-saved `customerId` re-syncs a load's display column. A renamed customer's older, untouched loads keep showing the old name on the board until something else about them is saved again.

## 6. Dispatch candidates: what stays deterministic and why

`fleet-backend/src/domain/dispatch/*` — feasibility checks, scoring, and ranking order — was not edited by a single line anywhere in this feature (`git diff` across all twelve commits is empty for that directory).

The original plan expected `suggest.ts` to gain one optional passthrough field; the actual implementation found it unnecessary. A ranked row's `Candidate.context` type already existed as `EvalContext`, so the enrichment below is attached entirely in `lib/rankDrivers.ts`'s post-`suggest()` row map, never inside the engine itself.

Proof that feasibility, score, and order are unchanged: `tests/candidate-context.test.ts` pins the exact scores, feasibility flags, blocked reasons, and ordering for a fixed three-driver fixture from *before* any of this feature's code existed, and re-asserts the identical hard-coded numbers after every change — no assertion in that test was ever edited to make it pass.

The `context` block (`CandidateContext`, `src/lib/candidateContext.ts`), field by field:

| Field | What it is |
|---|---|
| `availability` | The full `DriverAvailabilityView` from §3 |
| `estimatedArrivalAtPickupMs` | `availability.availableAt` + deadhead miles at 50 mph |
| `hosRemaining` | `{driveMin, windowMin, known}` — `known: false` when the driver has no `HosState` row at all |
| `lane` | `{key, label}` — label is always `"Origin City, ST > Dest City, ST"`, the same format `DriverPreference.avoidLanes` entries must use to match |
| `laneRuns` | This driver's completed runs on `lane.key` |
| `onTimeRate`, `responseRate`, `noResponseIncidents` | Straight from `DriverMetrics` (§4) |
| `homeTime` | `{homeBaseCity, homeBaseState, deliveryToHomeMi, withinRelocate}` — miles from the load's last delivery stop to the driver's home base |
| `preferences` | `null` when the driver has no `DriverPreference` row; otherwise `{maxTripMiles, willingToDriveNight, preferredEquipment, matchesEquipmentPref, laneAvoided, regionAvoided}` |
| `qualifications` | `{equipmentTypes, endorsements, hazmatEndorsed}` |

**Preferences are context, never rules**: a driver whose `avoidLanes` matches this exact lane is still ranked and scored as if the preference did not exist; `laneAvoided`/`regionAvoided` are for display only, never a filter. This is stated directly in `candidateContext.ts`'s own header comment and proven by the same pinned-score test above — the fixture's Driver One has an `avoidLanes` entry matching the test's own lane and still scores and ranks exactly as if it were absent.

Both flags match case- and whitespace-insensitively against the lane label / state code, so `"chicago, il > nashville, tn"` and `"Chicago, IL > Nashville, TN"` are the same lane as far as `laneAvoided` is concerned.

`context` appears in four places: the **⚡ Suggest panel** (`GET /suggest`, including blocked/infeasible rows — a Task 10 review fix made blocked rows render it too, not just feasible ones), the **driver-next list** (`GET /drivers/:id/next`), the **candidate-details route** (`GET /loads/:id/candidates/:driverId`), and the read-only tool `findFeasibleDrivers` (§7, which is `suggestForLoad` under the hood).

`rankOrgDrivers`'s two commit-path callers, in `dispatcherAssignments.ts` (lines 398 and 1045 — the actual assignment/replan commit paths, as opposed to the read-only ranking paths above), pass no `contextInput` argument at all and see no behavior or query-count change.

A driver with no completed assignments at all still gets a full `CandidateContext` row: `onTimeRate`/`responseRate` read `null`, `laneRuns` reads `0` — "no evidence yet" is itself a fact this block reports about a new driver, never something that quietly disappears from the row.

Building `context` for a whole candidate pool is one additional batch per request — `availabilityFor`, `driverMetricsBatch`, a `driverPreference.findMany`, a driver-rows-with-HOS query, and `laneRunsByDriver`, all run together and never repeated per candidate. That batch explicitly skips the detention scan (`includeDetention: false`, §4) since `CandidateContext` never surfaces `averageDetentionMinutes` — nothing would ever read the number a full scan would have computed.

## 7. The read-only tool boundary (for a future model harness)

`GET /api/dispatcher/tools` publishes this table (from `toolManifestJson()`, `src/lib/dispatchTools/manifest.ts`) — 17 plain TypeScript functions, each a thin wrapper over an existing service:

| Tool | Params | Description |
|---|---|---|
| `getLoad` | loadId | Returns one load with its ordered stops, appointments, linked customer, and current assignment; use when you already know the load's id and need its full detail. Returns null if the load does not exist. |
| `searchLoads` | status?, customerId?, fromMs?, toMs?, uncovered?, limit? | Returns loads matching optional status/customer/pickup-window/coverage filters, newest first; use to find loads by criteria rather than by id. |
| `getUncoveredLoads` | — | Returns open loads with no active assignment whose pickup window has not been over for more than 24 hours, soonest pickup first; use to see what still needs a driver. |
| `getDriver` | driverId | Returns one driver's profile (qualifications, home base, last known position) and current availability, without performance metrics; use when you already know the driver's id. |
| `searchDrivers` | status?, equipment?, language?, state?, acceptingLoads?, limit? | Returns drivers matching optional availability-status/equipment/language/state/accepting-loads filters; use to find drivers by criteria rather than by id. |
| `getAvailableDrivers` | — | Returns drivers who are AVAILABLE or AVAILABLE_SOON and accepting loads, soonest-available first; use when looking for who could take a new load right now. |
| `getDriverAvailability` | driverId | Returns one driver's current availability (status, where and when they will be free); use for a quick availability check without the rest of their profile. |
| `getDriverMetrics` | driverId | Returns one driver's evidence-derived performance metrics (on-time rate, detention, response behavior, lane experience); use when judging how a driver has actually performed. |
| `getDriverHistory` | driverId, limit? | Returns one driver's completed assignments, most recently completed first, each with lane and on-time detail; use to review what a driver has actually run. |
| `getDriverLocationHistory` | driverId, sinceMs | Returns a driver's raw location pings since a given time, oldest first; use to trace where a driver has actually been. |
| `getCustomer` | customerId | Returns one customer's profile and how many loads it has; use when you already know the customer's id. |
| `getCustomerHistory` | customerId | Returns one customer's volume, on-time rate, common lanes, and detention history; use when judging a customer's track record. |
| `getCurrentETA` | loadId | Returns the load's best-known current ETA — the agent's live itinerary when one exists, else the assignment's planned end while that assignment is still active or completed (never a canceled one), else none; use for the freshest delivery-time estimate. |
| `getLoadEvents` | loadId | Returns a load's change history and agent status updates merged into one timeline, oldest first; use to see everything that has happened to a load. |
| `getAgentEvents` | loadId | Returns the Night Shift agent's own trip and event trail for a load, newest trip first with its events oldest first; use to inspect the agent's raw evidence. |
| `findFeasibleDrivers` | loadId | Returns every org driver ranked for a specific load — feasible candidates scored, infeasible ones with a reason; use when deciding who should take a load. |
| `getDispatchCandidateDetails` | loadId, driverId | Returns one specific driver's ranking row for one specific load; use to inspect a single candidate after findFeasibleDrivers has already been called. |

`GET /api/dispatcher/tools` responds with one JSON object, `{ tools: [...] }` — one entry per row above, each shaped `{ name, description, readOnly: true, params }`, where `params` is that tool's zod schema converted to a standard JSON Schema object (`type: "object"`, a `properties` entry per parameter with its own type and `description`, and `required` listing the non-optional ones) via zod v4's `z.toJSONSchema`.

**The contract**: every function's org comes from the caller's own auth context — none of the 17 accept `orgId` (or `nowMs`) as a parameter, so a future invoke layer supplies the tenant from the authenticated session exactly the way every dispatcher route already does; a model can never ask for another org's data by passing a different id.

Asking about another org's load/driver/customer id returns `null` (or `[]` for a list); nothing throws. Read-only is enforced by a static test (`tests/dispatch-tools.test.ts`) that scans every one of the 9 files under `src/lib/dispatchTools/` for forbidden Prisma method names (`create`, `update`, `upsert`, `delete`, their `*Many` variants, `$executeRaw(Unsafe)`, `$queryRawUnsafe`) and asserts zero matches.

**What a harness would still need** that does not exist today: an invoke endpoint (nothing calls these 17 functions on a model's behalf), any prompt, and a write path for the `AiExperiment`/`AiDecisionRecord` audit tables (§2) — the schema exists for exactly this purpose, but nothing populates it yet.

The tools route is also dispatcher-session-only today (§2's routes table) — it is not on the API-key allow-list Night Shift's own MCP server uses, so a harness authenticating that way would need it added.

The 17 functions live in 9 files under `src/lib/dispatchTools/` — the exact count the static read-only scan asserts it reached, so an empty or misdirected directory read can't pass vacuously:

- `loads.ts` — `getLoad`, `searchLoads`, `getUncoveredLoads`.
- `drivers.ts` — the seven driver-facing functions.
- `customers.ts` — `getCustomer`, `getCustomerHistory`.
- `eta.ts` — `getCurrentETA`.
- `events.ts` — `getLoadEvents`, `getAgentEvents`.
- `dispatch.ts` — `findFeasibleDrivers`, `getDispatchCandidateDetails`.
- `limit.ts` — the shared list-size clamp, `MAX_LIST_LIMIT = 200`.
- `manifest.ts` — the table above; the only file in the codebase importing `zod/v4` (everything else uses zod v3).
- `index.ts` — re-exports.

Every one of the 17 is a thin wrapper over a service this document already describes elsewhere — `dispatchTools/` adds no new query logic of its own.

## 8. The demo world and its 14 scenarios

`node seed-world.mjs` (or `SEED_DEMO=seed-world.mjs` at container boot) builds a dedicated org, "Great Lakes Freight Co" (`America/Detroit`), from one deterministic PRNG stream (`mulberry32`, seeded `"fleet-world-2026"`).

The run is **idempotent**: every row tagged under that org is purged and rebuilt from scratch on every invocation — two full-scale runs against the dev database produced byte-identical phase counts in about 6.8 seconds each.

A `scale` parameter multiplies only the *bulk* counts (generic drivers, generic historical/current loads); the 15-driver scenario cast and its dedicated history are always built in full regardless of scale.

At full scale (`scale: 1`, the verified dev-DB run):

- 20 customers (3 high-priority)
- 165 drivers (15 scenario cast + 150 bulk)
- 3,225 loads (3,000 historical over the past 180 days + 225 current/future/scenario)
- 6,450 load stops and 6,450 appointments
- 3,137 assignments
- 7,942 driver location pings
- 622 agent trips and 1,163 agent events

The 14 named scenarios (from `seed-world/scenarios.mjs`, cross-checked against `scenarioOpen.mjs`/`scenarioActive.mjs`/`cast.mjs`):

| Code | Load ref | Title | Where to look | How to see it in the UI |
|---|---|---|---|---|
| A | `W-A-RELIABLE` | Reliable driver near an uncovered load | Milan Petrovski is available about 40 miles from this Toledo pickup with a 96% on-time record on 50 completed loads. | Open the load on the Cockpit board, click ⚡ Suggest — Milan's row shows his on-time rate in the context line. |
| B | `W-B-CLOSER` | A closer driver with a spotty response history | Dwayne Okafor is only 15 miles away, but 3 unanswered check-ins and a 61% response rate are worth weighing against the shorter deadhead. | A separate load from the same Toledo pickup point as A — open `W-B-CLOSER`, ⚡ Suggest — Dwayne's context line reads "no-reply ×3" and a reply rate near 61% (11 of 18 replied). |
| C | `W-C-SOON` | Covered soon by a driver finishing nearby | Ana Kovacs is still inbound to Detroit but is projected to be free well before this same-city noon pickup. | ⚡ Suggest on the Detroit noon-pickup load, or open Driver Supply and find Ana directly — her status is ON_LOAD with a projected Detroit arrival ahead of the pickup window. |
| D | `W-D-HOS` | Nearby driver is short on drive time | Ray Delgado is close to this load but has only 90 minutes of drive time left on his clock. | ⚡ Suggest on this load — Ray's context line shows his HOS drive-remaining minutes (90). |
| E | `W-E-EQUIP` | Equipment mismatch on the closest driver | Tomasz Nowak is the nearest driver, but this load needs a Reefer and he only runs Flatbed. | ⚡ Suggest on this load — Tomasz appears as the nearest driver but blocked, with an equipment-mismatch reason; his context still renders alongside the blocked row. |
| F | `W-F-LANE` | A driver who already knows this lane | Marcus Webb has run the Chicago to Nashville lane 14 times — deep lane experience worth surfacing. | ⚡ Suggest on this load — Marcus's context line reads "lane runs 14". |
| G | `W-G-HOME` | A load that gets a driver home for the weekend | Lena Fischer is based in Grand Rapids and wants to be home on weekends — this load delivers there on Friday. | ⚡ Suggest on this load — Lena's context line reads "0 mi to home" (the load delivers to her Grand Rapids home base). The "home-time fit" chip needs a `willingToRelocateMiles` preference, which the cast does not set. |
| H | `W-H-PRIORITY` | High-priority customer needs delay notice | Meridian Foods is a high-priority account that requires a delay notification the moment this load is at risk. | Open the load in Cockpit — its customer shows as "Meridian Foods"; the priority/delay-notification flags themselves are only visible through the API (`GET /api/dispatcher/customers/:id`), since no dedicated Customers page exists in the portal yet. |
| I | `W-I-LATE` | A load running behind plan | This driver's most recent pings show them roughly 90 minutes behind the planned schedule. | Open Driver Supply and find Hassan Farah — his CURRENT/PROJECTED AVAILABILITY reflect pings placed behind the plan's expected position. |
| J | `W-J-ANOMALY` | An open anomaly the agent already flagged | The agent logged an unplanned-stop anomaly on this in-progress load and is waiting on the driver. | Open the load on the Cockpit board — its agent pill reads "asked", with an open unplanned-stop anomaly visible in the Night Shift drawer. |
| K | `W-K-STOP` | Truck stopped somewhere unplanned | The last four pings sit in the same spot for 25 minutes, at a location that isn't a planned stop. | Open Driver Supply and find Owen Bracken — his last several pings sit at one non-stop location. |
| L | `W-L-DARK` | No signal from the truck in over an hour | This driver's last ping is 70 minutes old — worth a check-in. | Open Driver Supply and find Ivy Novak — her ping age shows well past normal freshness. |
| M | `W-M-DETENTION` | A completed load with billable detention | Dwell pings at the delivery stop show well over 200 minutes billable past the 120-minute free window. | Open Grace Adeyemi's driver history/evidence panel, or the customer's history — the completed Kansas City→Wichita load carries 220 billable detention minutes. |
| N | `W-N-OFFROUTE` | Off the planned route | The last three pings sit about 6 miles off the great-circle line between pickup and delivery. | Open Driver Supply and find Petar Ilic, or view the load on the map — the last few pings sit visibly off the St. Louis→Omaha line. |

`SimDriverState` rows are pre-set for the three scenarios whose premise is a driver behavior rather than a one-time position: K (`stopped`), L (`dark`), N (`offroute`).

A few more things worth knowing about the cast:

- Two more drivers exist without a lettered scenario: Boris Yankov and Chidi Okonkwo, whose only job is to carry breakdown/accident reply evidence into `driverMetrics` — 6 breakdowns and 2 accidents across the two of them (ruling 5 in the build ledger).
- Every scenario driver's id is computed from a SHA1-based `stableId("driver:" + externalId)`, never Prisma's random default, so the same driver gets the same id on every reseed — a saved test fixture or a direct `GET /drivers/:id` call by that id keeps working across resets. The org id is likewise stable (confirmed identical between two consecutive full-scale runs).
- The one exception is each driver's `shareToken` (the driver-page link, §1): the seed never sets it explicitly, so it falls back to the schema's random `@default(uuid())` and regenerates on every reseed. **A copied `/driver/:token` link stops working once `POST /sim/reset` runs** — re-copy it from the driver's drawer afterward.

## 9. The simulation

`tick(orgId, minutes, wallNowMs)` (`src/lib/simulation/engine.ts`) advances one org's fiction by `minutes` simulated minutes:

1. Loads (or creates) that org's `SimulationState` and computes `simNowMs = wallNowMs + (simMinutesAdvanced + minutes) * 60_000` — a notional "what time is it in the fiction" value. Nothing about the real process clock ever changes.
2. **Starts due assignments**: every `assigned` assignment whose `plannedStart` has passed `simNowMs` transitions to `in_progress`, each through its own call to `transitionAssignment` — the same function a dispatcher's own Start button calls.
3. **Advances in-progress assignments**: any driver's expired `modeUntil` is reset to `auto` first. Then, for each `in_progress` assignment, one of two things happens:
   - If `plannedEnd` has passed `simNowMs`, it transitions to `completed`, with a final ping at the delivery stop unless the driver's mode is `dark`/`idle`.
   - Otherwise, a ping is computed by walking the load's geocoded stops by cumulative distance to the assignment's elapsed fraction, then adjusted by `SimDriverState.mode` — `auto` (the true position), `stopped` (re-ping the last known spot, ignoring the route), `offroute` (the true position plus a stored offset), `dark`/`idle` (no ping at all).
4. Persists the clock advance (`simMinutesAdvanced`, `lastTickAt`) as its own write, after every transition attempt this tick — one failed transition never costs the rest of the tick its progress.
5. Emits `load_changed` for every load that transitioned and `driver_location` for every ping written.
6. Re-derives and upserts `DriverAvailability` for every driver touched this tick, skipping any row whose `source` is already `"manual"` — a dispatcher's own override always wins. The upsert writes ONLY `availabilityStatus` and `source: "simulation"`; `availableAt/Lat/Lng/City/State` are always cleared to `null`, never a snapshot of this tick's projection — so the live projection (§3: last geocoded drop + `plannedEnd` while on a load, else the last ping and its nearest known place) stays authoritative for every non-manual row, including once the driver's next assignment changes what that projection reports.

**Two clock rules, deliberately different:**
- `Assignment.startedAt`/`completedAt` are stamped in **simulated** time (`simNowMs`), so a load "delivered" after hours of fast-forwarded driving is judged on-time/late against `Appointment.windowEnd` on the same fictional timeline `plannedStart`/`plannedEnd` already live on. This rule was reversed once during review: the first version stamped these at real wall-clock time, which would have made a fast-forwarded delivery read as on-time simply because little real time had passed; the final ruling moved them to simulated time.
- Every `DriverLocation` ping is stamped in **real wall-clock** time (Prisma's own `createdAt` default, never overridden), so Night Shift's own ping-freshness checks see a ping as current no matter how far the simulated clock has moved.

**Per-driver modes** (`SimDriverState.mode`, set via `POST /sim/drivers/:id/mode {mode, minutes?, offsetMi?}`): `auto` (true position), `stopped` (re-pings the last known position), `dark` (writes no ping; assignments still progress and complete), `offroute` (true position plus a stored lat/lng offset, converted from `offsetMi` as a due-east displacement), `idle` (writes no ping).

A mode can be time-boxed (`minutes`, 1–1440) — once `modeUntil` passes, the next tick resets it to `auto` on its own. `offsetMi` (0–50) only means anything for `offroute` and is silently zeroed for every other mode rather than carrying a stale value forward. Every `/sim/*` body is zod-validated: `tick.minutes` 1–1440 (integer), `start.speed` 1–120 (integer).

Concretely: pressing Start at `speed: 30` on a load whose plan spans 4 hours advances that load roughly 12.5% of the way to delivery for every real second that passes. A dispatcher watching Driver Supply or the board during a run sees that driver's pin visibly move once per second, and sees the load flip to `completed` once its `plannedEnd` is crossed in simulated time.

`POST /sim/start {speed}` starts a per-org `setInterval` (`simulation/runner.ts`): one real second becomes `speed` simulated minutes, calling `tick(orgId, speed)` once per second. A tick still running when the next second fires is **skipped, not queued** — two overlapping ticks on the same org would otherwise race each other's reads of `simMinutesAdvanced`. `POST /sim/stop` clears it; a process restart forgets every running simulation (nothing auto-starts on boot).

**`DEMO_MODE` gating**: every `/sim/*` route 404s — not merely refuses — unless `process.env.DEMO_MODE === "true"`, checked at request time, exactly the pattern `dispatcherDemo.ts` already uses. This sits on top of the same dispatcher-session gate every other `/api/dispatcher` route has.

**`POST /sim/reset`** spawns `node seed-world.mjs` as a real child process — the same command a human runs, not an in-process re-import — under one global in-flight lock (a second reset request gets `409` while one is running), with a 5-minute child timeout that kills a hung reseed and releases the lock. A non-zero exit code or a spawn error leaves `SimulationState` untouched and only logs a warning; only a clean exit resets it to defaults. The reseed always rebuilds the one fixed demo org, whichever org's dispatcher pressed the button. Running `node seed-world.mjs` from a shell also clears that org's `SimulationState` — before that fix, a CLI reseed kept the previous session's `simMinutesAdvanced`.

**One transaction per transition**: each assignment's transition runs inside its own `prisma.$transaction`, not one shared transaction for the whole tick.

This was also reversed once during review — the original tick shared one transaction across every transition, which meant a single dispatcher-held lock or a concurrent write could poison every later statement in that same transaction (Postgres aborts the whole transaction after one failed statement). The final version isolates each transition; a failure there is caught, logged, and counted in the tick's `skipped` total, never thrown.

**HOS is never touched**: the simulation writes assignment status/timestamps, location pings, and availability rows — it never reads or writes `HosState`, and `domain/dispatch/hos.ts` has zero diff across this whole feature.

**A restarted process reports `running: false`**: `GET /sim/state`'s `running`/`speed` come from the live in-process runner map (`simulation/runner.ts`), never from the persisted `SimulationState.running` column — a process restart has no timer for any org, so the endpoint says so even if the database still says `true` from before the restart.

## 10. Backward compatibility

| Risk (from the plan) | Actual outcome |
|---|---|
| `Load.customerId` breaks imports/sheet writes that only know `customerName` | `customerId` stayed nullable; the migration back-filled every existing load with a resolvable `customerName`; the writer's bootstrap rung (§5) links an untouched legacy load the next time anything about it is saved. The 24-file, 338-test sheet suite passes unchanged. |
| `Driver.firstName/lastName` split from `name` is heuristic | `Driver.name` remains the field every existing screen reads; `firstName`/`lastName` are additive, consumed only by the new driver page's greeting. |
| Legacy drivers have no `DriverAvailability`/`DriverPreference` row | `availabilityFor` returns documented defaults for a driver with no row at all (`acceptingLoads: false`, `source: "none"`; status is still derived from any active assignment). No trigger backfills a row. |
| `dispatcherDriverNext.ts` refactor changes ranking | `tests/dispatcher-driver-next.test.ts` run before and after the extraction: identical pass count, identical assertions, unchanged response shape. |
| `SuggestRow` change ripples into `emptyMilesSaved`/the commit path | Turned out to not apply: `domain/dispatch/suggest.ts` was never modified at all. The context object is attached entirely in `lib/rankDrivers.ts`, after `suggest()` has already returned; `rankOrgDrivers`'s two commit-path callers in `dispatcherAssignments.ts` (lines 398 and 1045) pass no `contextInput` argument and see no behavior change. |
| Seed purges/clobbers the existing demo | The seed targets only its own org ("Great Lakes Freight Co"); its purge step deletes rows scoped to that org id alone. |
| Simulation vs. Night Shift clocks | Resolved as in §9 — pings stay wall-clock, lifecycle timestamps stay simulated; `/sim/*` is gated by `DEMO_MODE`. |
| `resetDb()` FK order (test helper) | `tests/helpers.ts` deletes the new tables (`aiDecisionRecord`, `aiExperiment`, `simDriverState`, `simulationState`, `driverAvailability`, `driverPreference`) before `driver`, and `customer` before `org` — confirmed present in that order. |
| Windows dev-DB migrate needs the dev server stopped first | A one-time operational step during Task 1; no ongoing effect. |

Regression testing was tracked task by task rather than as one final number. The backend suite stood at 163 files/1,461 tests once Task 1 landed (the baseline every later task's own delta was measured against) and grew to 174 files/1,665 tests by the end of Task 8, with the delta at every step matching exactly what that step's own new or changed test files accounted for — no unexplained gain or loss anywhere in the ledger.

Tasks 9 and 10 added `driver-preference.test.ts` and `driver-page.test.ts`; the full backend suite was re-run green after each (ledger: `t9-fullsuite.log`, `t10-fullsuite.log`). The portal suite grew from a 103-file/1,155-test baseline (before Task 9) to 114 files/1,254 tests by the end of Task 10, likewise with zero regressions.

After the fix round that followed this feature's twelve commits (`a9b75b1`..`8347126`): backend 176 files, full suite green, `tsc --noEmit` clean; portal 114 files / 1,254 tests, `vue-tsc --noEmit` clean, `npm run build` OK; night-shift typecheck clean with 39 test files passing (3 skipped); night-shift-mcp 2 files.

## 11. Explicitly not done

- No LLM, Qwen, or Claude wiring for dispatch decisions of any kind — confirmed by searching for `@anthropic-ai/sdk`/`anthropic` under `fleet-backend/src`: zero hits.
- No invoke endpoint — the 17 tools in §7 are plain functions and a manifest; nothing calls them on a model's behalf.
- No writes to `AiExperiment` or `AiDecisionRecord` — the audit schema exists; nothing populates it.
- No wallet or billing changes.
- No WhatsApp integration (still true of the whole repository).
- **No deployment of any of these twelve commits** — the Render deployment remains an older build than this branch's local `HEAD`.
- No change to Night Shift's agent, its Twilio integration, sheet sync, the HOS engine, or any anomaly detector.
- No change to `loadWriter.ts`'s existing contract beyond the one addition described in §5 (`deriveCustomer`, following `resolveCarrier`'s shape).

Verified directly: across all twelve commits, no file under `domain/dispatch/`, `domain/dwell/`, `night-shift/`, or `lib/sheet/` has any diff. The one guarded file outside those directories that changed is `src/lib/loadWriter.ts` (95 insertions, 1 deletion: `deriveCustomer`, the `customerId` scalar, `InvalidCustomer`).

## 12. Follow-ups logged during the build

- **A `P2002` mislabel risk** in `dispatcherBrokerBoard.ts:327`: its catch block maps *any* unique-constraint violation on that write path to "duplicate load #", so a concurrent Customer-name creation race (two simultaneous first-time writes creating the same new customer name in one org) would be mislabeled as a duplicate load number rather than reported for what it is. Flagged during Task 3's review; not fixed.
- **Duplicate lane-parsing snippets**: the "lane by pickup/delivery stop type" rule is implemented three times — `lanes.ts`'s private `laneOfStops`, `driverMetrics.ts`'s `laneOfAssignmentStops`, and `candidateContext.ts`'s `laneOfContextStops` — plus a fourth, deliberately coarser by-position variant in `customers.ts`. Accepted as tech debt against the plan's one-new-export-per-task ceiling on `lanes.ts`.
- **A duplicate `assignment.findMany` per `/suggest` call**: `candidateContext.ts`'s own `laneRunsByDriver` call and the scoring side's `laneFamiliarity` (which also calls `laneRunsByDriver`) run the identical org+lane query twice on the same request. Each scans every completed assignment in the org with its stops (~3,100 rows at demo scale), so the duplicate costs one full scan per Suggest click; not fixed.
- **The seed's small-scale slicing caveat**: at scales well below the `0.15` the test suite exercises, `seed-world/current.mjs`'s distinct-driver draw for assigned/in-progress/tendered loads could exceed the scaled bulk driver pool. Each slice is clamped so it can never crash, but a few loads could end up short a distinct driver at very small scales — not observed at scale 0.15 or 1.
- **Two HOS staleness conventions now coexist**: the portal's pre-existing `lib/hosFreshness.ts` (24 hours, keyed on `importedAt`) and Driver Supply's own `lib/supplyFormat.ts` (`isHosStale`, 8 hours, keyed on `hos.updatedAt`). They answer different questions on purpose and were deliberately not unified — flagged so a future change doesn't merge them incorrectly.
- **`fleet-portal/src/lib/api.ts`'s size**: 796 lines after this feature's additions (up from 651 before Task 9) — still under the codebase's 800-line hard cap, not split because splitting a file every store imports from wasn't requested and carries its own risk. Two other pre-existing files this feature added to were already over 400 lines beforehand and remain so: `fleet-portal/src/stores/loadboard.ts` (954 lines) and `fleet-backend/src/routes/dispatcherLoadboard.ts` (452 lines).
- **`DriverPreference`'s array fields** (`preferredRegions`/`preferredLanes`/`avoidRegions`/`avoidLanes`/`preferredEquipment`) are edited in the drawer's preferences form via comma/newline-separated plain text inputs, validated server-side by the same regexes `dispatcherDriverSupply.ts` uses to write them — functional, but simpler than a dedicated chip-picker. Logged as a reasonable scope call, not a defect.
- **Each simulation transition is its own round trip to Postgres** (§9's one-transaction-per-transition rule) rather than sharing one connection for the whole tick — for a tick touching N assignments this is up to N+1 (or more, with ping writes) separate transactions instead of one. Correct and required for failure isolation; worth knowing if a future tick ever needs to process a very large number of assignments per org per second. Not a concern at today's demo scale.
- **`laterOf`/`AVAILABLE_SOON_WINDOW_MS`/`hub()` duplication**: `laterOf` was duplicated verbatim in `lib/lanes.ts` and `lib/driverMetrics.ts`; the 4-hour `AVAILABLE_SOON_WINDOW_MS` was copied into `seed-world/current.mjs` and `scenarioLoads.mjs`; `hub()` was copied into `scenarioActive.mjs`, `scenarioOpen.mjs`, and `namedHistory.mjs`. Fixed: `laterOf` now lives in `lib/onTime.ts` (imported by both callers), the shared constant lives in `seed-world/constants.mjs`, and `hub()` lives in `seed-world/cities.mjs` — one definition each, multiple importers, identical seed counts.
- **Test files over the 500-line ceiling**: `tests/simulation.test.ts` (749 lines) and `tests/driver-availability.test.ts` (529 lines). No `any` in either file; no TODO/FIXME. Each file's size is its own fixture/helper setup shared by every test in it — logged, not split.
- **Realtime fan-out under the runner**: every in-progress driver (~45 at demo scale) emitted a `driver_location` frame every real second, and `stores/driverSupply.ts` rebuilt the whole 165-entry `availability` record per frame — re-sorting the table and redrawing the canvas ~45×/s. Fixed: frames are now buffered per driver and flushed as one record rebuild at most every 500 ms.
- **Clock race**: a manual `POST /sim/tick` concurrent with a runner tick can lose one increment (both read `simMinutesAdvanced` then write `+ minutes`); the runner's own `inFlight` guard covers runner-vs-runner races only. Demo-only; not fixed.
- `tests/seed-world.test.ts` is typed through `fleet-backend/seed-world.d.mts`, kept in sync by hand with `seed-world.mjs`'s exports.
