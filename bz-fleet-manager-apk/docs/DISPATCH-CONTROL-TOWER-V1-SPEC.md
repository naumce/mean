# Fleet Dispatch Control Tower — Commercial V1 Specification

> **What this is:** a buildable spec for turning the dispatch-board mockup (`mockups/dispatch-board.html`)
> into a sellable SaaS. Product/positioning/pricing are condensed (already decided); the depth is on the
> **data model, the dispatch algorithm, the architecture, and the fake-vs-integrate decisions** for the first
> paying customer. Stack reuses what we already have: `fleet-backend` (Node/Express/Prisma/Postgres) +
> `fleet-portal` (Vue 3/Pinia). The mockup is the authoritative UI spec.

---

## 0. The wedge (one sentence)

**A visual dispatch control tower that sits *on top of* a fleet's existing TMS/ELD** — every load dispatched
from one timeline, with **HOS, equipment, deadhead and margin checked before you assign it.** We deliberately
do **not** build invoicing, BOL/docs, payroll, factoring, accounting, EDI, maintenance, or a load board in V1.

**Buyer:** owner / ops manager / dispatch manager at a **10–100 truck fleet** (dry van / reefer / flatbed,
regional & OTR) running 2–10 dispatchers on spreadsheets + a legacy TMS + ELD + phone/WhatsApp.
**Daily user:** the dispatcher. **Entry point:** "Connect your loads (CSV/API) and see tomorrow's dispatch
visually" — not "replace your TMS."

## 1. Product principles (the non-negotiables)

1. **One screen** answers *"Can I assign this load to this driver?"* and *"Who's the best driver for it?"*
2. **Two-layer engine, hard-separated:** a **deterministic rules engine** decides *feasibility* (HOS,
   equipment, hazmat, availability, appointment, overlap) — explainable, testable, never an LLM. An
   **optimization/AI layer** only *ranks feasible options*. An LLM never decides whether a driver legally has
   hours.
3. **One obsessive metric on the dashboard: empty miles saved → $ saved.** The customer justifies the
   subscription to themselves monthly.
4. **Resist TMS bloat.** Own the dispatcher's workday first; absorb the stack later, only once they're paying.

---

## 2. The V1 screens (10)

| # | Screen | Purpose | Primary action |
|---|--------|---------|----------------|
| 1 | **Login / Org setup** | Auth + org (fleet) creation, invite dispatchers | Create org / sign in |
| 2 | **Dispatch Board** (control tower) | The timeline: driver rows × time, load bars, deadhead, HOS, conflicts, now-line. *The product.* | Drag a load → driver |
| 3 | **Load detail / edit panel** | Open a load: stops, schedule, assignment, freight, live economics, order leg-chain, lifecycle | Edit / save |
| 4 | **Assignment engine result** (drop modal) | On drop: the feasibility checklist + economics + Assign/Cancel (the killer interaction) | Confirm assignment |
| 5 | **Suggest driver** (ranked panel) | ⚡ ranked feasible candidates with deadhead / ETA / HOS / margin / score + why | Assign best |
| 6 | **Driver detail / "What's next"** | Driver availability, HOS remaining, current load, and best next load opportunities | Plan next load |
| 7 | **Load Board** (unassigned) | Open loads with rate / $/mi / equipment; drag source | Drag to board |
| 8 | **Alerts / exceptions feed** | HOS-limit-approaching, likely-late, equipment double-booked, load unassigned too long | Jump to fix |
| 9 | **Data import** | CSV/Excel upload + API/webhook status; field mapping; validation report | Import loads/drivers |
| 10 | **Dashboard / KPIs** | Fleet KPIs + **empty miles avoided / fuel $ saved / margin improvement** (ROI) | — |

(Screen 2's board, 3's panel, 4/5's engine, 7's load board, 8's alerts, and 10's KPIs already exist visually
in the mockup — that's the head start.)

---

## 3. Domain model — exact schema (Postgres / Prisma)

Multi-tenant by `orgId` on every row. Extends our existing `fleet-backend` Prisma models (Driver, Vehicle→
Tractor, Trip→Load) rather than starting fresh.

```prisma
model Org {
  id        String   @id @default(uuid())
  name      String
  timezone  String   @default("America/Chicago")
  createdAt DateTime @default(now())
  users     User[]
  drivers   Driver[]
  tractors  Tractor[]
  trailers  Trailer[]
  loads     Load[]
}

model User {                       // dispatcher / manager
  id        String @id @default(uuid())
  orgId     String
  email     String @unique
  name      String
  role      String @default("dispatcher") // dispatcher | manager | owner
  org       Org    @relation(fields: [orgId], references: [id])
  @@index([orgId])
}

model Driver {
  id            String   @id @default(uuid())
  orgId         String
  externalId    String?                 // id in the source TMS/ELD (for import reconciliation)
  name          String
  phone         String?
  cdlClass      String   @default("A")
  hazmatEndorsed Boolean @default(false)
  homeBase      String?                 // city or LocationId
  status        String   @default("active") // active | off_duty | on_break | inactive
  // last-known position (from ELD/GPS export or last drop)
  lastLat       Float?
  lastLng       Float?
  lastLocationAt DateTime?
  org           Org      @relation(fields: [orgId], references: [id])
  hos           HosState?
  assignments   Assignment[]
  @@index([orgId, status])
}

model Tractor {                    // power unit
  id         String  @id @default(uuid())
  orgId      String
  externalId String?
  unit       String                    // e.g. "1207"
  make       String?
  cab        String? @default("Sleeper") // Sleeper | DayCab
  status     String  @default("active")  // active | in_shop | inactive
  @@index([orgId, status])
}

model Trailer {
  id         String  @id @default(uuid())
  orgId      String
  externalId String?
  unit       String
  type       String                    // DryVan | Reefer | Flatbed | StepDeck | Tanker | Intermodal
  length     String?                   // "53'"
  features   Json?                     // { reeferSetpoint, foodGrade, ... }
  lastLat    Float?
  lastLng    Float?
  status     String  @default("active") // active | idle | in_shop
  @@index([orgId, type, status])
}

model Load {
  id           String   @id @default(uuid())
  orgId        String
  externalId   String?                 // load/PRO # from source system
  orderRef     String?                 // the order this leg belongs to
  legType      String   @default("linehaul") // collection | linehaul | delivery | drop_swap | intermodal
  status       String   @default("open")      // open | tendered | assigned | in_progress | delivered | canceled
  commodity    String?
  weightLbs    Int?
  requiredEquip String                 // trailer type this load needs (drives EquipmentRequirement)
  hazmatClass  String?                 // "8", "3", ... null = non-haz
  unNumber     String?
  revenueCents Int      @default(0)    // linehaul + fsc, integer cents
  fscCents     Int      @default(0)
  brokerName   String?
  org          Org      @relation(fields: [orgId], references: [id])
  stops        LoadStop[]
  assignment   Assignment?
  @@index([orgId, status])
}

model LoadStop {
  id          String   @id @default(uuid())
  loadId      String
  sequence    Int
  type        String   @default("pickup") // pickup | delivery | intermediate
  locationId  String?
  address     String
  lat         Float?
  lng         Float?
  geocodeStatus String? @default("pending") // pending | ok | failed
  appointment Appointment?
  load        Load     @relation(fields: [loadId], references: [id])
  @@index([loadId, sequence])
}

model Appointment {                  // per-stop time window
  id        String   @id @default(uuid())
  stopId    String   @unique
  windowStart DateTime?
  windowEnd   DateTime               // "must deliver by"
  type      String   @default("delivery") // pickup | delivery
  stop      LoadStop @relation(fields: [stopId], references: [id])
}

model Assignment {                   // the commit: load ↔ (driver + tractor + trailer) at a time
  id           String   @id @default(uuid())
  orgId        String
  loadId       String   @unique
  driverId     String
  tractorId    String?
  trailerId    String?
  plannedStart DateTime               // computed at drop
  plannedEnd   DateTime
  deadheadMi   Float    @default(0)   // snapshot at assign
  loadedMi     Float    @default(0)
  marginCents  Int      @default(0)
  status       String   @default("assigned") // assigned | in_progress | completed | canceled
  assignedBy   String?                // userId
  createdAt    DateTime @default(now())
  driver       Driver   @relation(fields: [driverId], references: [id])
  load         Load     @relation(fields: [loadId], references: [id])
  @@index([orgId, driverId])
  @@index([orgId, status])
}

model HosState {                     // current hours-of-service clock per driver
  driverId        String  @id
  driveRemainingMin  Int              // of the 11h (660) driving limit
  windowRemainingMin Int              // of the 14h (840) on-duty window
  cycleRemainingMin  Int              // of the 60/70h weekly cycle
  minutesSinceBreak  Int              // for the 30-min break rule (after 8h cumulative)
  lastResetAt        DateTime?        // last 10h reset / 34h restart
  updatedAt          DateTime @default(now())
  driver          Driver  @relation(fields: [driverId], references: [id])
}

model EquipmentRequirement {         // normalized capability match (derived; can be a view)
  loadId       String @id
  trailerType  String
  hazmat       Boolean @default(false)
  temperatureF Int?                   // reefer setpoint requirement
  foodGrade    Boolean @default(false)
}

model Rate {                         // pricing model per load (breakdown)
  loadId        String @id
  linehaulCents Int
  fscCents      Int
  totalMi       Float
  loadedMi      Float
  deadheadMi    Float
  ratePerLoadedMiCents Int
  estCostCents  Int
  marginCents   Int
}

model DeadheadLeg {                  // computed empty repositioning for an assignment
  id         String @id @default(uuid())
  assignmentId String
  fromLat    Float
  fromLng    Float
  toLat      Float
  toLng      Float
  miles      Float
  costCents  Int
  @@index([assignmentId])
}

model DispatchConflict {            // materialized result of the rules engine for an (attempted) assignment
  id         String @id @default(uuid())
  orgId      String
  loadId     String
  driverId   String
  kind       String                 // hos | equipment | hazmat | overlap | late_pickup | late_delivery | tractor_unavail | trailer_unavail
  severity   String  @default("block") // block | warn
  detail     String                 // human-readable, explainable
  createdAt  DateTime @default(now())
  @@index([orgId, loadId])
}

model ImportBatch {                 // data ingestion audit
  id        String @id @default(uuid())
  orgId     String
  source    String                  // csv | excel | api | webhook
  entity    String                  // loads | drivers | hos | positions
  rows      Int
  errors    Json?
  createdAt DateTime @default(now())
}
```

**Money as integer cents everywhere** (no float money). Miles as float. All timestamps UTC; render in
`Org.timezone`. `externalId` on every imported entity is the reconciliation key for re-imports.

---

## 4. The dispatch algorithm (the core IP)

The killer interaction: **unassigned load → drag onto Jake → propose start → validate HOS/equipment/hazmat →
compute deadhead → detect overlaps → compute $/mi & margin → commit.** Two layers:

### 4A. Feasibility — deterministic rules engine (pure functions, unit-tested)

`evaluate(load, driver, tractor, trailer, context) → { feasible: bool, conflicts: DispatchConflict[], plan }`

Each check is independent, explainable, and returns block/warn:

1. **Equipment** — `trailer.type === load.requiredEquip` (block if not). Temperature/food-grade sub-checks for
   reefer (warn).
2. **Hazmat** — `load.hazmatClass == null || driver.hazmatEndorsed` (block).
3. **Availability** — tractor.status==active & not assigned elsewhere in window; trailer likewise; driver
   status active (block).
4. **Pickup reachability** — `proposedStart + deadheadDriveTime ≤ pickup.appointment.windowEnd` (block if
   can't make pickup; warn if tight).
5. **Delivery reachability** — `estDeliveryTime ≤ delivery.appointment.windowEnd` (block/warn).
6. **Schedule overlap** — proposed `[plannedStart, plannedEnd]` doesn't intersect any existing Assignment for
   this driver/tractor/trailer (block).
7. **HOS feasibility** — see 4B (block on violation).

`proposedStart` = `max(driver.availableAt, pickup.window.start − deadheadDriveTime)`, snapped to 15 min.

### 4B. HOS math (US FMCSA property-carrying — get this exactly right)

Inputs from `HosState`: `driveRemainingMin` (of 660), `windowRemainingMin` (of 840), `cycleRemainingMin`
(of 3600/4200), `minutesSinceBreak`.

```
requiredDriveMin   = (deadheadMi + loadedMi) / avgSpeedMph * 60
dwellMin           = pickupDwell + deliveryDwell + Σ intermediateDwell   // default 60 each, configurable
requiredOnDutyMin  = requiredDriveMin + dwellMin
needsBreak         = (minutesSinceBreak + requiredDriveMin) > 480        // 8h cumulative → 30-min break
requiredOnDutyMin += needsBreak ? 30 : 0

feasible if ALL:
  requiredDriveMin  ≤ driveRemainingMin
  requiredOnDutyMin ≤ windowRemainingMin
  requiredOnDutyMin ≤ cycleRemainingMin
else → conflict {kind:'hos', detail:`Needs ${h(requiredDriveMin)} drive; ${h(driveRemainingMin)} remaining`}
```

If infeasible only because of the daily clock but a **10-hour reset** before pickup would fix it, emit a
`warn` with the reset-and-still-make-it plan (V1: warn only; V2: auto-plan the reset).

### 4C. Distance, deadhead & ETA

- **Deadhead origin** = driver's `lastLat/lastLng` (from ELD/GPS export) or, if stale, the last drop of their
  previous assignment, or `homeBase`.
- **Distance** = routing provider **matrix API** (Mapbox/OSRM) → road miles + drive time; **fallback** =
  haversine × 1.2 road factor at `avgSpeedMph` (default 50). **Cache** every (origin,dest) pair.
- **ETA** = `proposedStart + deadheadDriveTime + dwell + loadedDriveTime + (needsBreak ? 30 : 0)`.

### 4D. Economics (integer cents)

```
totalMi   = deadheadMi + loadedMi
fuelCost  = totalMi / mpg * dieselPricePerGal          // mpg default 6.5, price from a daily feed
driverPay = totalMi * payPerMi                          // config per driver/company
fixedCost = totalMi * fixedCostPerMi                    // maintenance+insurance+overhead allocation
estCost   = fuelCost + driverPay + fixedCost
revenue   = load.revenueCents
margin    = revenue − estCost
ratePerLoadedMi = revenue / loadedMi
```

### 4E. Ranking — the ⚡ Suggest scorer (optimization layer)

Runs `evaluate()` for **every feasible driver**, then scores 0–100. V1 is a **transparent weighted score**
(no ML yet — ML rides on accumulated history later):

```
score = 100 * (
  w_margin   * norm(marginPct,   0.05..0.35) +      // higher margin better
  w_deadhead * norm(1 − deadheadMi/300) +           // less empty better
  w_hos      * norm(hosSlack) +                      // more legal headroom better
  w_appt     * apptRisk(0..1 → 1..0) +               // lower late-risk better
  w_hometime * homeTimePref +                        // toward driver's home base
  w_lane     * lanePerfScore                         // historical lane $ (0 until data accrues)
)
// V1 weights: margin .30, deadhead .30, hos .15, appt .15, hometime .05, lane .05
```

Output rows: `driver | deadheadMi | eta | hosOk | marginPct | score | whyBlocked?`. **Infeasible drivers are
shown but greyed with the blocking reason** (e.g. Dale: ❌ HOS) — never silently hidden.

### 4F. Commit (`POST /assignments`)

Transaction: re-run `evaluate()` server-side (never trust the client), write `Assignment` + `DeadheadLeg` +
`Rate` snapshot, flip `Load.status='assigned'`, decrement provisional HOS, invalidate/rebuild conflicts,
emit over WebSocket to all dispatchers. Idempotent on `loadId`.

---

## 5. Fake vs. integrate for customer #1

The single most important scoping decision. **Build real** only what makes the promise true; **fake** the rest.

| Capability | V1 decision | Why |
|---|---|---|
| **Load import (CSV/Excel/API/webhook)** | **REAL** | The wedge. A fleet exporting loads once/day must work day one. |
| **Rules engine (HOS/equipment/hazmat/overlap/appt)** | **REAL & correct** | This *is* the product's trust. Bugs here kill it. Unit-tested. |
| **Economics (rate/deadhead/margin)** | **REAL** | The ROI story + the Suggest score depend on it. |
| **Drag-to-dispatch board + assignment engine** | **REAL** | The demo. Already prototyped. |
| **Distance/ETA** | **REAL via provider, with haversine fallback** | Cache aggressively; provider optional at first. |
| **Driver HOS** | **STUB: import from ELD CSV/API daily, or manual entry** | Do **not** build an ELD. Ingest Motive/Samsara/KeepTruckin exports. |
| **Live GPS position** | **STUB: last-known from daily export or last drop** | Real-time GPS is V2. Last-known is enough to compute deadhead. |
| **Traffic-aware ETA / dynamic late-risk** | **FAKE: static speed model** | V2 turns this live. |
| **Historical lane/driver performance** | **EMPTY until data accrues** | Score works with a 0 weight; improves over time (the moat). |
| **Invoicing / BOL / settlements / payroll / factoring / accounting / EDI / maintenance / load board** | **NOT BUILT** | The trap. Explicitly out of V1. |
| **Direct TMS/ELD integrations** | **AFTER first customers** | Start with CSV/Excel + a REST API + webhook; build named integrations on demand. |

**Ingestion contract (V1):** an `/api/import` endpoint + a mapped CSV/Excel uploader for `loads`, `drivers`,
`hos`, `positions`; a webhook for near-real-time load drops. Field-mapping UI + a validation report (`ImportBatch`).

---

## 6. Architecture (thin, buildable, reuses what we have)

- **Backend:** extend `fleet-backend` (Node/Express/Prisma/**Postgres** — swap SQLite provider). New modules:
  - `rules/` — the **pure-function rules engine** (equipment, hazmat, hos, overlap, reachability). No DB, no
    framework, 100% unit-tested. *The correctness core / moat.*
  - `pricing/` — economics (deadhead, cost, margin, rate).
  - `distance/` — matrix provider client + cache + haversine fallback.
  - `suggest/` — the scorer (calls rules + pricing).
  - `import/` — CSV/Excel/API/webhook ingestion + mapping + validation.
  - `realtime.ts` — extend the existing dispatcher WS channel to push board/assignment updates.
  - Multi-tenant: `orgId` scoping middleware on every query (the security invariant).
- **Frontend:** `fleet-portal` (Vue 3/Pinia/Tailwind). Port the mockup's board + panel into components
  (the mockup is the spec). Use the plan's geometry core (`docs/superpowers/plans/2026-08-20-dispatch-board.md`,
  INC-1) for time↔pixel.
- **Realtime:** WS for the board (multi-dispatcher). Optimistic drop → server `evaluate()` → confirm/rollback.

---

## 7. Pricing & packaging (per fleet size, not per seat)

| Tier | Price | Fleet | Includes |
|---|---|---|---|
| **Starter** | $249/mo | ≤10 trucks | Board, import, rules engine, economics, Suggest |
| **Fleet** | $599/mo | ≤40 trucks | + alerts, multi-dispatcher, KPI/ROI dashboard |
| **Operations** | $999–1,499/mo | ≤100 trucks | + integrations, live tracking, optimizer, analytics |

`+$10–15 / additional truck`. Value-anchored: one avoided bad-deadhead decision on a $100k+ asset covers a
meaningful slice of the subscription.

## 8. GTM wedge + the 3-minute demo

Pitch: *"Connect your existing TMS and see tomorrow's dispatch visually."* Small commitment (CSV even).
Demo: **board → drag load onto Jake → ⚠ HOS conflict → ⚡ Suggest → Maria 96% → Assign → +$147 margin /
−52 deadhead mi → show tomorrow's 2 at-risk loads.** A fleet owner gets it in 3 minutes.

## 9. The one retention metric

Dashboard headline, updated monthly: **Deadhead avoided (mi) · Fuel $ saved · Margin improvement $.**
The customer re-justifies the subscription to themselves every month.

## 10. Moat & roadmap

- **Moat is the dispatch intelligence + accumulated operational data** (lane performance, real dwell, driver
  behavior, facility delays, actual fuel/loading/unloading times) — not the Gantt chart, which anyone can copy.
- **V2:** live GPS on the map + auto-updating ETA; dynamic late-risk with recovery suggestions; automatic
  re-dispatch; the "What's next?" best-next-load panel per driver; a morning fleet-wide optimization sweep
  (swap suggestions with deadhead-reduction / margin-improvement totals).
- **Three businesses inside this:** (A) fleet dispatch SaaS *(start here)*, (B) a dispatch-optimization API
  other TMS vendors call (`POST /optimization/assignment`), (C) a white-label embeddable board.

---

## 11. Build sequence to first paying customer

1. **Data spine** — Org multi-tenancy, Prisma schema above, CSV/Excel import for loads+drivers+hos+positions,
   a REST/webhook ingest endpoint. *(Nothing to see yet, but everything depends on it.)*
2. **Rules engine** — pure-function `evaluate()` with the HOS/equipment/hazmat/overlap/reachability checks,
   fully unit-tested against known cases. *(The correctness core.)*
3. **Economics + distance** — deadhead/cost/margin + matrix provider with haversine fallback + cache.
4. **Board (read-only)** — port the mockup timeline over live data (plan INC-1 geometry core).
5. **Drag-to-dispatch + assignment engine** — the drop → `evaluate()` → checklist modal → commit + WS push.
6. **⚡ Suggest** — the scorer over feasible drivers, ranked panel.
7. **Alerts feed + ROI dashboard** — the exceptions and the empty-miles-saved metric.
8. **Onboarding** — import wizard + field mapping + validation report; a 3-minute guided demo dataset.

Ship 1–7 to a **design partner fleet** (free/discounted) for real loads; instrument empty-miles-saved; convert
to paid once the number is real. That's the path from "cool Claude prototype" to a buildable startup.
