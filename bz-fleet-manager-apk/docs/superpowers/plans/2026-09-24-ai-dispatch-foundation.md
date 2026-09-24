# AI Dispatch Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Turn the Control Tower into a realistic AI-dispatch laboratory: an enriched driver domain (profile, qualifications, explicit availability with projected location/time, preferences, evidence-derived metrics), a real `Customer` entity, a Driver Supply view, enriched dispatch candidates, a deterministic seeded demo world with 14 named scenarios, a lightweight simulation engine, clean read-only tool boundaries for a later LLM harness, and an audit schema for AI experiments — **without changing any deterministic engine or the Night Shift agent's behaviour.**

**Architecture:** Every new capability is additive. Deterministic authority stays where it is (`domain/dispatch/*`, `hos.ts`, `night-shift/src/core/*`, `loadWriter.ts`). Driver context reaches the UI through a **sibling `context` field on `SuggestRow`** populated in `lib/rankDrivers.ts` — never through `EvalContext` or the mapper (`insp-dispatch.md` §4, §Summary). "Projected availability" is the rule `dispatcherDriverNext.ts:47-54` already applies per driver (current assignment's last geocoded delivery + `plannedEnd`), extracted into one shared service. The `Customer` entity is linked by a nullable `Load.customerId` with a writer-side find-or-create derivation from `customerName`, so imports and the sheet keep working unchanged. The demo world lives in its **own org** so the existing Heartland demo is untouched. The simulation moves drivers along committed plans and writes ordinary `DriverLocation` rows, so the Night Shift agent sees them exactly as real pings.

**Tech Stack:** Prisma 5 + Postgres (per-test-process schemas), Express 4 + zod + `asyncRoute`, Vue 3 + Pinia (options stores) + vue-router, vitest/supertest. Deterministic PRNG (mulberry32) in the seed.

**Spec:** the user's brief (this plan's Analysis section restates it). Reference reading: `docs/current-system-architecture.md`, and the two inspection notes at `C:\Users\Naum\AppData\Local\Temp\claude\e--meeting-copilot-bz-fleet-manager-apk\ea7f332b-4502-4533-b24a-5714217794e0\scratchpad\insp-dispatch.md` and `insp-portal.md`.

## Analysis — affected surfaces and back-compat risks

**Models touched:** `Driver` (additive columns), new `DriverAvailability`, `DriverPreference`, `Customer`, `SimDriverState`, `SimulationState`, `AiExperiment`, `AiDecisionRecord`; `Load.customerId` (nullable FK, `onDelete: SetNull`).
**Services touched:** `lib/loadWriter.ts` (one new derivation), `lib/rankDrivers.ts` (row enrichment), `domain/dispatch/suggest.ts` (one optional passthrough field), `lib/lanes.ts` (one new export), `routes/dispatcherDriverNext.ts` (refactor to the shared availability function), `tests/helpers.ts` (`resetDb` order).
**UI touched:** router, `AppShell.vue` nav, new `DriverSupplyView` + store, the ⚡Suggest panel, a new `SimControls` component, a new driver-facing availability page.

| Risk | Mitigation |
|---|---|
| `Load.customerId` breaks imports / sheet writes that only know `customerName` | Column nullable; writer derives `customerId` by find-or-create on `(orgId, name)` inside the same tx; a failure to resolve never fails the write (logged, left null). Migration back-fills existing loads. |
| `Driver.firstName/lastName` split from `name` is heuristic | `name` stays authoritative everywhere the UI reads today; new fields are display-only until a real source exists. Backfill = split on first space. |
| Legacy drivers have no `DriverAvailability`/`DriverPreference` row | Services return a documented default when the row is missing (`availabilityStatus: "UNAVAILABLE"`, `acceptingLoads: false`, empty prefs). **No DB trigger** — unlike `Plan`, absence is a valid state. |
| `dispatcherDriverNext.ts` refactor changes ranking | Extract, don't rewrite; run `tests/dispatcher-driver-next*.test.ts` before and after — identical. |
| `SuggestRow` change ripples into `emptyMilesSaved` / commit path | Field is optional and additive; `emptyMilesSaved` reads only `feasible/hosKnown/deadheadMi/driverId` (inspection §Summary). |
| Seed purges/clobbers the Heartland demo | Seed targets a **new org** (`Great Lakes Freight Co`, `w@fleet.com` / `pass123`), is idempotent by tag (`externalId` prefix `W-`, driver `externalId` prefix `WD-`), and never touches rows outside that org. |
| Simulation vs Night Shift clocks | The simulation advances the *world* (positions, completions, availability) and writes `DriverLocation` with **wall-clock** `createdAt`; it never changes the process clock. Documented in §Task 8 and the final doc. Endpoints are gated by `DEMO_MODE` exactly like `dispatcherDemo.ts` (404 when off). |
| Per-process test schemas | Migration SQL back-fills are `UPDATE … WHERE` / `INSERT … SELECT` that are no-ops on an empty schema. |
| `resetDb()` FK order | Task 1 adds the new tables to `tests/helpers.ts` before `driver`/`org` deletes (precedent: `Plan`). |
| Windows dev DB migrate | Stop `tsx watch src/server.ts` on :3001 if running before `prisma migrate dev`; restart after; say so. |

## Global Constraints
- **No git commits / no `git add` by implementers** — the controller commits. Never read/print `.env`.
- **Do not modify:** `domain/dispatch/evaluate.ts`, `checks.ts`, `compliance.ts`, `hos.ts`, `mapper.ts`; anything under `night-shift/src/core/`, `night-shift/src/ports/`, `night-shift/src/live/claudeConversation.ts`, `twilio*.ts`; `lib/sheet/*`. `suggest.ts` may gain ONE optional passthrough field and nothing else. `loadWriter.ts` may gain ONE derivation (`deriveCustomer`) following `resolveCarrier`'s shape.
- **No LLM code.** No `@anthropic-ai/sdk`, no Ollama, no prompts. Tool boundaries are plain TypeScript functions + a zod manifest.
- **No subjective driver fields** (`reliability`, `goodDriver`, `recommended`…). Metrics are derived from rows.
- **Nationality is never a field or a ranking input.** `languages[]`/`preferredLanguage` are for communication only.
- Every route in `asyncRoute`; zod bodies; org-scoped; 404 not 403. Every Load write through `applyLoadChange`/`applyStatusChange`.
- Portal: options-style Pinia stores, `lib/api.ts` typed endpoint functions, canvas `components/tracking/FleetMap.vue` for maps (no Mapbox token dependency), status-chip/two-line-cell conventions from `insp-portal.md` §5.
- Checks per task: backend `cd fleet-backend && npx vitest run <task files> && npx tsc --noEmit`; the FULL backend suite once per task that touches `src/` (~9 min); portal `npx vitest run && npx vue-tsc --noEmit -p tsconfig.app.json` (0 errors) when touched; night-shift `npm run typecheck` when the schema changes (it shares the Prisma client).

## File Structure
**Created (backend):** migration `<ts>_ai_dispatch_foundation`; `src/lib/driverAvailability.ts` (+test); `src/lib/customers.ts` (+test); `src/lib/driverMetrics.ts` (+test); `src/lib/dispatchTools/index.ts`, `manifest.ts`, `eta.ts` (+tests); `src/routes/dispatcherDriverSupply.ts`, `dispatcherCustomers.ts`, `dispatcherSim.ts`, `driverAvailabilityPage.ts` (+tests); `src/lib/simulation/engine.ts`, `movement.ts` (+tests); `seed-world.mjs`; `seed-world/` (names, cities, scenarios data as `.mjs`).
**Created (portal):** `views/DriverSupplyView.vue` (+spec), `stores/driverSupply.ts` (+spec), `components/supply/DriverSupplyRow.vue`, `DriverDrawer.vue`, `components/sim/SimControls.vue` (+spec), `stores/sim.ts`.
**Modified:** `prisma/schema.prisma`; `tests/helpers.ts`; `lib/loadWriter.ts`; `lib/rankDrivers.ts`; `domain/dispatch/suggest.ts` (one field); `lib/lanes.ts`; `routes/dispatcherDriverNext.ts`; `routes/dispatcherSuggest.ts`; `src/app.ts`; `start.sh` (seed-world flag); portal `router/index.ts`, `layouts/AppShell.vue`, `lib/api.ts`, the ⚡Suggest panel component, `Dockerfile` (copy seed-world).

---

### Task 1: Schema — driver enrichment, availability, preferences, customer, simulation, AI audit
**Files:** `prisma/schema.prisma`; migration; `tests/helpers.ts`; `tests/schema-foundation.test.ts` (create).
**Produces:**
```prisma
// Driver (additive)
firstName String?  lastName String?  homeBaseCity String?  homeBaseState String?
preferredLanguage String @default("en")  languages String[] @default([])
yearsExperience Int?  timezone String?
endorsements String[] @default([])   // CDL endorsement letters for display: T N P X … ; hazmat authority stays `hazmatEndorsed`
equipmentTypes String[] @default([]) // trailer types the driver is qualified on: DryVan Reefer Flatbed StepDeck Tanker Intermodal
availability DriverAvailability?  preference DriverPreference?  simState SimDriverState?

model DriverAvailability { driverId String @id; driver Driver @relation(...)
  acceptingLoads Boolean @default(false)
  availabilityStatus String @default("UNAVAILABLE") // AVAILABLE | AVAILABLE_SOON | ON_LOAD | OFF_DUTY | UNAVAILABLE
  availableAt DateTime?  availableLat Float?  availableLng Float?  availableCity String?  availableState String?
  locationSharingEnabled Boolean @default(false)  locationSharingUpdatedAt DateTime?
  shareToken String @unique @default(uuid())      // authorises the driver-facing availability page
  source String @default("manual")                 // manual | derived | simulation
  updatedAt DateTime @updatedAt }

model DriverPreference { driverId String @id; driver …
  maxTripMiles Int?  preferredRegions String[] @default([])  preferredLanes String[] @default([])
  avoidRegions String[] @default([])  avoidLanes String[] @default([])
  homeTimeTarget String?  willingToDriveNight Boolean @default(true)  willingToRelocateMiles Int?
  preferredEquipment String[] @default([])  updatedAt DateTime @updatedAt }

model Customer { id String @id @default(uuid()); orgId String; org Org …; name String
  primaryContactName String?  primaryEmail String?  primaryPhone String?
  preferredCommunicationChannel String @default("email") // email | sms | phone
  timezone String?  priority String @default("standard")     // standard | high
  updateCadenceMinutes Int?  lateNotificationThresholdMinutes Int?  detentionFreeMinutes Int?
  requiresArrivalNotification Boolean @default(false)  requiresDelayNotification Boolean @default(true)
  loads Load[]  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([orgId, name]) }
// Load: customerId String?  customer Customer? @relation(fields:[customerId], references:[id], onDelete: SetNull)

model SimulationState { orgId String @id; org Org …; running Boolean @default(false); speed Float @default(1)
  simMinutesAdvanced Int @default(0); lastTickAt DateTime?; seed String? }
model SimDriverState { driverId String @id; driver …; mode String @default("auto") // auto | stopped | dark | offroute | idle
  modeUntil DateTime?  offsetLat Float @default(0)  offsetLng Float @default(0)  updatedAt DateTime @updatedAt }

model AiExperiment { id String @id @default(uuid()); orgId String; org Org …; name String; model String; notes String?
  createdAt DateTime @default(now()); decisions AiDecisionRecord[] }
model AiDecisionRecord { id String @id @default(uuid()); experimentId String; experiment AiExperiment @relation(..., onDelete: Cascade)
  orgId String; loadId String?; driverId String?; kind String            // dispatch_candidate | escalation | eta | other
  context Json; toolCalls Json; toolResults Json; proposedDecision Json?; reason String?; confidence Float?
  humanDecision Json?; actualOutcome Json?
  proposedAt DateTime @default(now()); decidedAt DateTime?; outcomeAt DateTime?
  @@index([orgId, loadId]) @@index([experimentId]) }
```
Migration back-fills: `Driver.firstName/lastName` from `name` (split on first space); `Driver.homeBaseCity/State` from `homeBase` when it matches `City, ST`; `Customer` rows from distinct non-null `Load.customerName` per org (`primaryEmail` = first non-null `customerEmail`), then `Load.customerId`. `tests/helpers.ts` `resetDb`: delete `aiDecisionRecord, aiExperiment, simDriverState, simulationState, driverAvailability, driverPreference` before `driver`, and `customer` before `org` (after `load`).
- [ ] Write `tests/schema-foundation.test.ts`: creating a Driver leaves `availability`/`preference` null (no trigger); a Customer name is unique per org, allowed across orgs; deleting a Customer sets `Load.customerId` null; `AiDecisionRecord` cascades with its experiment. Run → fails. Migrate (stop :3001 first if running; restart; say so). Implement. Green. Full suite + `night-shift npm run typecheck`.

### Task 2: Driver availability service + routes + shared projection
**Files:** create `src/lib/driverAvailability.ts`, `tests/driver-availability.test.ts`; create `src/routes/dispatcherDriverSupply.ts` (availability part) ; modify `routes/dispatcherDriverNext.ts:47-54` to call the shared function; `src/app.ts`.
**Produces:**
```ts
export interface ProjectedAvailability { at: number; lat: number|null; lng: number|null; city: string|null; state: string|null; basis: "current_assignment_last_drop" | "last_ping" | "none" }
export function projectAvailability(driver: { lastLat: number|null; lastLng: number|null }, current: { plannedEnd: Date; load: { stops: { type: string; lat: number|null; lng: number|null; address: string }[] } } | null, nowMs: number): ProjectedAvailability   // EXACTLY dispatcherDriverNext.ts:47-54's rule, plus city/state via parseCityState(stop.address)
export type AvailabilityStatus = "AVAILABLE"|"AVAILABLE_SOON"|"ON_LOAD"|"OFF_DUTY"|"UNAVAILABLE";
export interface DriverAvailabilityView { driverId; acceptingLoads; locationSharingEnabled; locationSharingUpdatedAt; status: AvailabilityStatus; availableAt; available: {lat,lng,city,state}; current: {lat,lng,at} | null; currentAssignment: {loadId, loadRef, deliveryEtaMs, deliveryCity} | null; source }
export async function availabilityFor(orgId: string, driverIds?: string[]): Promise<DriverAvailabilityView[]>   // one query per table, merges the explicit row (manual overrides win) with the derived projection; missing row ⇒ documented defaults
export function deriveStatus(explicit: DriverAvailability | null, current: Assignment | null, hos: HosState | null, nowMs): AvailabilityStatus  // rules: manual OFF_DUTY/UNAVAILABLE win; active assignment ⇒ ON_LOAD, or AVAILABLE_SOON when plannedEnd − now ≤ 4h; else acceptingLoads ⇒ AVAILABLE; else UNAVAILABLE
```
Routes (dispatcher, org-scoped): `GET /api/dispatcher/drivers/availability` (all), `GET /drivers/:id/availability`, `PATCH /drivers/:id/availability` `{acceptingLoads?, availabilityStatus?, availableAt?, availableCity?, availableState?, availableLat?, availableLng?}` (source `manual`). Emits nothing on WS (Task 9 polls + patches `driver_location`).
- [ ] Failing tests: projection matches `driverNext` for a driver with an active assignment (last geocoded delivery + plannedEnd), falls back to last ping, `none` when neither; status rules; manual override wins; missing row defaults; routes 404 cross-org; **`tests/dispatcher-driver-next*.test.ts` identical before/after the refactor** (run and record both).

### Task 3: Customer service, routes, writer derivation
**Files:** create `src/lib/customers.ts`, `src/routes/dispatcherCustomers.ts`, tests; modify `src/lib/loadWriter.ts` (add `deriveCustomer`, `customerId` to `LoadPatch`/`SCALARS`), `src/app.ts`.
**Produces:** `findOrCreateCustomer(tx, orgId, name, email?)`; `customerHistory(orgId, customerId) → { totalLoads, completedLoads, lateLoads, onTimeRate, commonLanes: {laneKey, originCity, destCity, runs}[], detentionEvents: number, lastLoadAt }` (late = `Assignment.completedAt > delivery Appointment.windowEnd`; detention via `scanDetention` scoped to the customer's loads); routes `GET/POST /api/dispatcher/customers`, `GET/PATCH /customers/:id`, `GET /customers/:id/history`, `GET /customers/:id/loads`. Writer: when `customerName` changed (or `customerId` null and name present) → `findOrCreateCustomer` and set `customerId` in the same tx (traced as field `customerId`); a blank name leaves `customerId` untouched. Existing `customerName/customerEmail` columns remain the source the sheet/import write.
- [ ] Failing tests: import a broker workbook → Customer rows created, loads linked; editing `customerName` on the board relinks; sheet sync path still passes (`tests/sheet`); history numbers on a fixture; cross-org 404.

### Task 4: Driver metrics (evidence-derived)
**Files:** create `src/lib/driverMetrics.ts`, `tests/driver-metrics.test.ts`; route additions in `dispatcherDriverSupply.ts`: `GET /drivers/:id/metrics`, `GET /drivers/:id/history?limit`.
**Produces:**
```ts
export interface DriverMetrics { driverId; asOf; completedLoads; onTimeLoads; lateLoads; onTimeRate: number|null; averageDelayMinutes: number|null; averageDetentionMinutes: number|null;
  averageResponseMinutes: number|null; responseRate: number|null; noResponseIncidents; breakdownIncidents; accidentIncidents; loadsLast30Days; nightLoads; laneExperience: { laneKey; originCity; destCity; runs; lastRunAt }[]; evidence: { assignments: number; agentTrips: number; agentEvents: number } }
export async function driverMetrics(orgId, driverId, nowMs = Date.now()): Promise<DriverMetrics>
export async function driverMetricsBatch(orgId, driverIds): Promise<Map<string, DriverMetrics>>   // for the candidate path
```
Rules (all from rows): late/on-time as Task 3; `averageDelayMinutes` over late loads; detention via `scanDetention` per driver's completed loads (average `billableMin`); response metrics from `AgentEvent`: an `action` with `evidence.kind ∈ {message, message_again, sms}` opens a question, the next `reply` on the same trip closes it (`averageResponseMinutes`, `responseRate` = answered/asked); `noResponseIncidents` = `escalation` events whose reason contains "unresolved" or "could not reach"; `breakdownIncidents`/`accidentIncidents` = `reply` events with `situationKey` `breakdown`/`accident`; `nightLoads` = completed assignments with `plannedStart` between 20:00 and 06:00 in the org timezone; lane experience = `laneKey` runs over completed assignments (extend `lib/lanes.ts` with `laneRunCounts(orgId, driverId?)` — new export, existing `laneFamiliarity` untouched).
- [ ] Failing tests on a fixture with 6 completed assignments (2 late), 2 agent trips (3 asks / 2 replies, 1 breakdown), 1 detention scenario → exact numbers; `null` rates when no evidence; batch equals per-driver.

### Task 5: Read-only tool boundaries (no LLM)
**Files:** create `src/lib/dispatchTools/index.ts`, `manifest.ts`, `eta.ts`, `tests/dispatch-tools.test.ts`; route `GET /api/dispatcher/tools` (manifest only) in `dispatcherDriverSupply.ts` or a new `dispatcherTools.ts`.
**Produces** — each a thin function over existing code (no duplicated queries; reuse `lib/*` and the services above):
`getLoad(orgId, loadId)`, `searchLoads(orgId, {status?, customerId?, from?, to?, uncovered?})`, `getUncoveredLoads(orgId)` (status `open`, no active `Assignment`, pickup window in the future or within the last 24 h), `getDriver`, `searchDrivers(orgId, {status?, equipment?, language?, state?, acceptingLoads?})`, `getAvailableDrivers(orgId)` (status AVAILABLE|AVAILABLE_SOON and `acceptingLoads`), `getDriverAvailability` (Task 2), `getDriverMetrics` (Task 4), `getDriverHistory(orgId, driverId, limit)` (completed assignments newest first with on-time flag), `getDriverLocationHistory(orgId, driverId, sinceMs)`, `getCustomer`, `getCustomerHistory` (Task 3), `getCurrentETA(orgId, loadId)` → `{ source: "agent_itinerary" | "plan_interpolation" | "none", etaMs, precision, computedAt }` (agent: newest `plan`/`sheet_write` `AgentEvent.evidence.itinerary.etaAtMs` of the load's newest trip; else `Assignment.plannedEnd`), `getLoadEvents(orgId, loadId)` (`LoadChange` + `AgentUpdate` merged by time), `getAgentEvents(orgId, loadId)`, `findFeasibleDrivers(orgId, loadId)` (Task 6's enriched `rankOrgDrivers`), `getDispatchCandidateDetails(orgId, loadId, driverId)`. `manifest.ts`: `TOOL_MANIFEST: { name, description, params: ZodSchema, readOnly: true }[]` for all 17, with a test that every manifest entry has a function and vice-versa.
- [ ] Failing tests per function against fixtures; the manifest/function parity test; `GET /tools` returns names + JSON-schema'd params (zod-to-json via `z.toJSONSchema` if available in the installed zod, else a minimal hand-mapper — say which).

### Task 6: Enriched dispatch candidates
**Files:** modify `domain/dispatch/suggest.ts` (add `context?: CandidateContext` to `Candidate` and `SuggestRow`, copied through at `:111-122` and `:147-157` — **no other change**), `lib/rankDrivers.ts` (`:58-76` loop + `:93-104` map), `routes/dispatcherDriverNext.ts` (`:99-108` row literal), `routes/dispatcherSuggest.ts`; new route `GET /api/dispatcher/loads/:id/candidates/:driverId`; tests.
**Produces:**
```ts
export interface CandidateContext { availability: DriverAvailabilityView; estimatedArrivalAtPickupMs: number|null /* availableAt + deadheadMi/50mph */; hosRemaining: { driveMin; windowMin; known: boolean }; laneRuns: number; onTimeRate: number|null; responseRate: number|null; noResponseIncidents: number;
  homeTime: { homeBaseCity; homeBaseState; deliveryToHomeMi: number|null; withinRelocate: boolean|null }; preferences: { maxTripMiles; willingToDriveNight; preferredEquipment; matchesEquipmentPref: boolean; laneAvoided: boolean; regionAvoided: boolean } | null; qualifications: { equipmentTypes; endorsements; hazmatEndorsed } }
```
Preferences are **context only** — they never change `feasible` or `score`. Scoring math untouched (`suggest.ts:125-145`). One batched query per table for all candidates (`availabilityFor`, `driverMetricsBatch`, `laneRunCounts`, preferences `findMany`).
- [ ] Failing tests: `/suggest` rows carry `context` with the right numbers for a fixture (a driver with an active assignment shows projected location ≠ current); infeasible rows still returned with context; scoring identical to before for the same fixture (snapshot the pre-change scores in the test); `dispatcherDriverNext` rows carry it; candidate-details route 404 cross-org.

### Task 7: Deterministic demo world (seed generator)
**Files:** create `fleet-backend/seed-world.mjs`, `fleet-backend/seed-world/{prng.mjs, names.mjs, cities.mjs, scenarios.mjs}`; modify `start.sh` (`SEED_DEMO=seed-world.mjs`), `Dockerfile` (COPY seed-world*); `tests/seed-world.test.ts` (runs the generator against the test DB and asserts counts + every scenario).
**World:** org `Great Lakes Freight Co` (timezone `America/Detroit`), dispatcher `w@fleet.com / pass123`, Standard policy (shadow), 2 carriers + own fleet. PRNG `mulberry32("fleet-world-2026")`; all randomness through it; a `WORLD_TAG = "W-"` on `Load.externalId` and `"WD-"` on `Driver.externalId`; **idempotent**: deletes everything tagged in that org, then regenerates identically.
Content: 20 customers (3 `priority: "high"`); 150 drivers (first/last names from fixed lists, languages incl. `en`, `es`, `mk`, `sr`, `pl`, `pa`; home bases from ~25 Midwest/Great-Lakes/Texas hubs in `cities.mjs` with lat/lng; `equipmentTypes` distributions DryVan 55 % / Reefer 25 % / Flatbed 15 % / Tanker 5 %; `hazmatEndorsed` 20 %; HOS states spread; `DriverAvailability` rows for all — ~40 AVAILABLE, ~30 AVAILABLE_SOON, ~60 ON_LOAD, ~20 OFF_DUTY; ~120 `locationSharingEnabled`; `DriverPreference` for all); ~3,000 historical loads over the past 180 days across ~60 lanes between the hubs (each with a completed `Assignment`, geocoded stops, appointments; ~12 % late by 20–240 min; ~15 % with detention evidence — dwell pings; ~20 % with an `AgentTrip` + `AgentEvent`s including `action(message)` / `reply` pairs and ~8 % no-reply escalations; 6 breakdowns, 2 accidents across specific "unreliable" drivers; ~10 % night loads); 200–250 current/future: ~60 `open` uncovered (pickup windows next 48 h), ~80 `assigned` (future), ~40 `in_progress` with 3 recent `DriverLocation` pings each along the route, ~10 `tendered`, the rest next-week.
**Scenarios (fixed refs, all in `scenarios.mjs`, each asserted by the test):** A `W-A-RELIABLE` open load in Toledo + driver `Milan Petrovski` AVAILABLE 40 mi away with 96 % on-time; B `W-B-CLOSER` same load area + driver `Dwayne Okafor` 15 mi away with 3 no-response escalations and 61 % response rate; C `W-C-SOON` load picking up in Detroit 12:00 + driver `Ana Kovacs` in_progress Kalamazoo→Detroit, plannedEnd 10:20 (projected available Detroit 11:15); D `W-D-HOS` driver `Ray Delgado` near the load with 90 min drive remaining; E `W-E-EQUIP` Reefer load + closest driver `Tomasz Nowak` flatbed-only; F `W-F-LANE` Chicago→Nashville load + driver `Marcus Webb` with 14 runs on that lane; G `W-G-HOME` driver `Lena Fischer` homeBase Grand Rapids, `homeTimeTarget: "weekend"`, load delivering to Grand Rapids Friday; H `W-H-PRIORITY` load for high-priority customer `Meridian Foods` with `requiresDelayNotification`; I `W-I-LATE` in_progress load whose driver is 90 min behind plan (pings placed behind schedule); J `W-J-ANOMALY` in_progress load with `agentEnabled: true`, an `AgentTrip`, and an open `unplanned_stop` anomaly event + `agentPill: "asked"`; K `W-K-STOP` in_progress with the last 4 pings identical for 25 min at a non-stop location; L `W-L-DARK` in_progress whose last ping is 70 min old; M `W-M-DETENTION` completed load with 3 h 40 m of dwell pings at a stop with a 120-min free window; N `W-N-OFFROUTE` in_progress whose last 3 pings are 6 mi off the great-circle line. `SimDriverState` rows pre-set for K (`stopped`), L (`dark`), N (`offroute`).
- [ ] Failing test first (counts and every scenario query); implement; run `node seed-world.mjs` against the dev DB (idempotency: run twice, counts identical); the test suite runs it against a per-process schema.

### Task 8: Simulation engine + routes
**Files:** create `src/lib/simulation/engine.ts`, `movement.ts`, `tests/simulation.test.ts`; `src/routes/dispatcherSim.ts` (gated by `DEMO_MODE === "true"` → 404 otherwise, exactly like `dispatcherDemo.ts:21-34`); `src/app.ts`.
**Produces:** `tick(orgId, minutes, nowMs)`: for each `in_progress` assignment, fraction = clamp((now + advanced − plannedStart)/(plannedEnd − plannedStart)); position = great-circle interpolation along geocoded stops (`movement.ts`), applying `SimDriverState.mode`: `stopped` (hold), `dark` (no ping written), `offroute` (apply `offsetLat/Lng`), `idle` (skip), `auto`; writes `DriverLocation` (**wall-clock `createdAt`**) + `Driver.lastLat/lastLng/lastLocationAt`; assignments whose `plannedEnd` has been passed → `applyStatusChange(delivered)` + `Assignment.status completed/completedAt` (through the existing `unassign`-adjacent path in `assignmentActions.ts` if one exists — inspect; else the same writes `POST /assignments/:id/status completed` performs); `assigned` loads whose `plannedStart` passed → `in_progress`; then `availabilityFor` recomputed and written to `DriverAvailability` with `source: "simulation"` for drivers whose status changed; `SimulationState.simMinutesAdvanced += minutes`. `run(orgId)` = a `setInterval` (1 real second = `speed` sim minutes) started/stopped by routes; module-level, one per org, `unref()`'d.
Routes: `GET /api/dispatcher/sim/state`, `POST /sim/tick {minutes}`, `POST /sim/start {speed}`, `POST /sim/stop`, `POST /sim/drivers/:id/mode {mode, minutes?, offsetMi?}`, `POST /sim/reset` (re-runs the seed scenarios' positions only — not the whole seed).
- [ ] Failing tests: a 60-min tick moves an in_progress driver ~1/Nth along its stops and writes one ping; `stopped` holds; `dark` writes nothing; `offroute` offsets; an assignment past `plannedEnd` completes and its driver becomes AVAILABLE with the delivery city as projected location; routes 404 without `DEMO_MODE`.

### Task 9: Driver Supply UI
**Files (portal):** `router/index.ts` (`/supply`, name `driver-supply`), `layouts/AppShell.vue` (OPERATE nav: "Driver Supply", tower tier only), `views/DriverSupplyView.vue` (+spec), `stores/driverSupply.ts` (+spec), `components/supply/DriverSupplyRow.vue`, `components/supply/DriverDrawer.vue`, `lib/api.ts` (typed functions for Tasks 2/4/5 endpoints).
**Produces:** a page with the canvas map (`components/tracking/FleetMap.vue`) on top showing every driver with `locationSharingEnabled` (colour by status), a filter bar (status, equipment, language, state, "accepting loads only"), and rows exactly per the brief: NAME · STATUS chip · CURRENT (address-ish: nearest hub city + "near"/"at") · CURRENT LOAD (ref → delivery city) · DELIVERY ETA · PROJECTED AVAILABILITY (city, time) · HOS (drive remaining, stale chip) · EQUIPMENT · LANGUAGES · HOME BASE. Click → `DriverDrawer` with metrics (Task 4), preferences, availability controls (PATCH), last 10 loads, and a "Driver link" (copy the `/driver/:shareToken` URL from Task 10). Realtime: subscribe `driver_location` → patch-by-id; poll availability every 30 s.
- [ ] Failing specs: rows render the ten fields from a fixture; filters narrow; the map receives only sharing-enabled drivers; drawer opens with metrics; PATCH sends the right body.

### Task 10: Candidates panel, simulation controls, driver-facing availability page
**Files (portal):** the ⚡Suggest panel component (find it: grep `suggest` in `components/cockpit`) gains a "Context" column set from `row.context`; `components/sim/SimControls.vue` (+spec) mounted on Driver Supply and the Cockpit toolbar when `GET /sim/state` is 200 (hidden on 404); `stores/sim.ts`; `stores/driverSupply.ts` per-driver mode actions in the drawer.
**Files (backend):** `src/routes/driverAvailabilityPage.ts` — `GET /driver/:shareToken` serves a small server-rendered HTML page (pattern: `night-shift/src/live/driverPage.html`) with two toggles **LOCATION SHARING ON/OFF** and **AVAILABLE FOR LOADS ON/OFF**, the driver's name and projected availability; `GET/PATCH /api/driver-page/:shareToken/availability` (token-authenticated, rate-limited like `/api/n`), `POST /api/driver-page/:shareToken/ping {lat,lng}` (writes `DriverLocation` + `Driver.lastLat/lng` when sharing is on; ignored otherwise); the page uses `navigator.geolocation.watchPosition` when sharing is on. Mounted outside the dispatcher gate; `hosting.ts` needs no change (backend serves it).
- [ ] Failing tests: suggest panel renders context fields; SimControls hidden when state 404, tick button posts; page renders toggles from the availability row; PATCH flips flags and stamps `locationSharingUpdatedAt`; ping ignored when sharing off; bad token 404.

### Task 11: Documentation + final verification
**Files:** `docs/ai-dispatch-foundation.md` — what was added (models, services, routes, UI), the tool manifest table, **what remains deterministic and why**, the 14 scenarios with how to find each in the UI, simulation usage and the wall-clock rule, back-compat notes (customerId derivation, legacy drivers without availability rows), the demo login, and what is explicitly NOT done (no LLM). Run all suites; controller commits.

---

### Scan of the plan against itself (controller)
- T2's `projectAvailability` and T8's post-tick availability write agree by construction (T8 calls T2). T6 consumes T2/T4 through batch functions — both must exist with the exact names above.
- `SuggestRow.context` is the only `domain/dispatch` edit; `emptyMilesSaved` unaffected (inspection).
- T7 depends on every model in T1 and the derivation in T3 (customers by name → the seed can set `customerId` directly).
- T10's driver page authenticates by `DriverAvailability.shareToken` (T1). `hosting.ts`'s SPA fallback must not swallow `/driver/:token` — it is a backend route mounted before `mountHosting`; the fallback skips no-`/api` GETs only when no route matched, so mount order matters: **mount before `mountHosting(app)`**.
