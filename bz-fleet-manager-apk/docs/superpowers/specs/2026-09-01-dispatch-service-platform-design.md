# Dispatch Service Platform — Design Spec

**Date:** 2026-09-01
**Supersedes nothing.** Extends `2026-08-28-cockpit-control-tower-design.md` (S0–S5), which remains the authority for the cockpit board itself.

## 0. Goal

Turn a fleet dispatch board into the operating system for a **dispatch service**: a business that finds loads and dispatches trucks it does not own, for many carrier clients at once, with several dispatchers working the same board.

## 1. Rulings (user, 2026-09-01)

| # | Ruling |
|---|---|
| R1 | **Buyer is the dispatch service**, not the carrier. Many dispatchers, ~50 trucks, many client carriers. |
| R2 | **Thin Carrier layer first**, then features on the correct shape. Carrier onboarding UX, commission and the carrier portal come later. |
| R3 | Map is a **navigation surface**, not a separate screen. |
| R4 | POIs appear **only when the plan implies the driver needs one**. No "show all truck stops" toggle. |
| R5 | Ratings/reviews are **out of scope**. Licence or omit. |

## 2. What exists (do not rebuild)

- Assignment engine: `evaluate()`, HOS (`BREAK_THRESHOLD_MIN 480`, `BREAK_DURATION_MIN 30`, `breaksNeeded`), compliance, deadhead, economics from an org cost model.
- Cockpit board: DST-safe Gantt, drag-to-dispatch/move/resize, pessimistic lane locks with presence, tenders, verdict modal, KPI strip.
- Live map (`FleetMap.vue`) on Mapbox with truck markers, route lines, stop pins, late-risk rings; schematic fallback when no token.
- `mapData.ts` — the single shared source of routes, driver positions and ping freshness.
- `Trailer.lastLat/lastLng` (**declared, never written**), `ServiceShop` with lat/lng/phone, `DriverLocation` full ping history indexed by `(driverId, createdAt)`.
- Backend 536 tests, portal 474 tests.

## 3. The structural problem this spec fixes

`Org → Driver` directly, with **one cost model per Org** (`mpg`, `dieselCentsPerGal`, `driverPayCentsPerMi`, `fixedCentsPerMi`).

A dispatch service owns no trucks. Truck #7 belongs to Carrier A paying `$0.72/mi` in a reefer at 5.8 mpg; truck #31 to Carrier B at `$0.55/mi` in a dry van. **Every margin, KPI and heat-map colour is currently computed against a cost model belonging to nobody.**

## 4. Slices

| Slice | Contains | Acceptance |
|---|---|---|
| **T1 Carrier layer (thin)** | `Carrier` model; `Driver`/`Tractor`/`Trailer` → carrier; cost model moves `Org` → `Carrier` with org-level defaults; carrier CRUD; group-by-carrier on board and map; carrier filter | Two carriers with different pay rates produce different margins for the same load; board groups by carrier; every existing test still green |
| **T2 Map as navigation** | Map ⇄ board jump both ways; pin differentiation (rolling / parked / no-GPS); popups per entity; **trailer positions written on assignment completion**; trailer layer with age; `ServiceShop` layer; clustering | Click a truck → "Show on board" scrolls to and selects its brick; a brick → "Show on map"; a trailer pin states its age, never a bare dot |
| **T3 Break & rest planning** | Where the HOS clock runs out along a plan; nearest rest options at that point; **"no legal break available" becomes a dispatch conflict** | The engine says a plan needs a break at a place; a plan with nowhere to stop is refused with a stated reason |
| **T4 Fuel & stops** | Fuel burn along a plan; state diesel price differential; "buy N gal here, save $X"; ties into IFTA | A leg shows a named fuel saving in dollars |
| **T5 Dwell & detention** | Geofence dwell from the existing ping history; detention threshold per stop; billable-claim surfacing | A truck sitting 3h at a stop raises a detention claim with evidence |
| **Deferred** | Commission & carrier statements; carrier onboarding; carrier portal (tokenized link → optional account); ELD integration | Own specs when reached |

## 5. T1 — Carrier layer (the only slice specified to task level here)

### 5.1 Data model

```prisma
model Carrier {
  id        String  @id @default(uuid())
  orgId     String
  org       Org     @relation(fields: [orgId], references: [id])
  name      String
  mcNumber  String?
  dotNumber String?
  status    String  @default("active")   // active | paused | archived

  // Cost model — the reason this entity exists. Null = inherit the org default,
  // so an existing single-carrier org keeps working untouched.
  mpg                 Float?
  dieselCentsPerGal   Int?
  driverPayCentsPerMi Int?
  fixedCentsPerMi     Int?

  // Compliance clocks (rendered in T2, enforced later)
  insuranceExpiresAt  DateTime?
  authorityStatus     String?

  drivers   Driver[]
  tractors  Tractor[]
  trailers  Trailer[]
  createdAt DateTime @default(now())
  @@index([orgId, status])
}
```

`Driver`, `Tractor`, `Trailer` each gain a **nullable** `carrierId`. Nullable is deliberate: every existing row keeps working, and an org that dispatches its own trucks never has to create a carrier at all.

### 5.2 Cost-model resolution

One function, one definition — this codebase has been bitten four times by a concept defined twice:

```ts
resolveRateConfig(org, carrier | null): RateConfig
```

Field-by-field: carrier value when non-null, else the org's. **Never a partial merge computed at more than one call site.** Every consumer (`orgRateConfig` today) routes through it.

`Rate` rows stay snapshots — editing a carrier's cost model must not retro-change committed economics. That invariant already holds and must survive.

### 5.3 API

- `GET/POST /dispatcher/carriers`, `PATCH /dispatcher/carriers/:id` — org-scoped, 404 (never 403) for a cross-tenant id.
- `GET /dispatcher/loadboard` gains `carrierId` + `carrierName` on each lane, and accepts `?carrierId=` to filter.
- Assignment commit and replan resolve the cost model **from the driver's carrier**.

### 5.4 UI

- Board `groupBy` gains `'carrier'` alongside driver/tractor/trailer.
- A carrier filter beside the existing equipment filter.
- Map markers coloured or badged by carrier when grouping by carrier.
- Lane head shows the carrier name when an org has more than one.

### 5.5 Explicitly NOT in T1

Commission, statements, onboarding, insurance enforcement, the carrier portal. T1 is the *shape*; the business logic on top comes later and is specified separately.

## 6. Cross-cutting invariants (bind every slice)

1. **Absent must never render as measured.** A trailer with no known position, a carrier with no cost model, a stop with no dwell data — all render as unknown, never as a confident zero or a bare pin. This has been violated three times in this codebase and caught each time by a review; it is the product's core promise.
2. **One definition per concept.** Statuses, HOS restore, lock keys, org rules, and now cost-model resolution.
3. **Engine-authoritative.** The server re-runs feasibility; the client never decides.
4. **404, never 403**, for cross-tenant ids.
5. **A POI appears only when the plan implies a need for it** (R4).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Carrier migration touches economics, the most-tested code | Nullable `carrierId` + org fallback means zero behaviour change until a carrier is created; existing suites must pass untouched |
| Map POI work drifts into competing with Trucker Path | R4 is a hard rule, restated in every plan's Global Constraints |
| Break planning needs routing accuracy the haversine estimate can't give | T3 must state its precision and label estimates; a break suggestion that is confidently wrong is worse than none |
| Scope: five slices is a quarter, not a sprint | Each slice ships independently and is demo-able alone |
