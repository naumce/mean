# T4 — Fuel & Stops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how much fuel a plan burns, where it is cheaper to buy it, and how many dollars that choice is worth — without ever inventing a number a tax filing might later rest on.

**Architecture:** Fuel burn is arithmetic we can already do exactly: plan miles ÷ the carrier's resolved `mpg`. The new fact is *price by state*, held in an org-scoped `FuelPrice` table populated by import. State is resolved **only at stops**, from the stop's own address via the existing `city|st` gazetteer — never by guessing which state a straight line passes through. Advice compares prices at stops whose state is known; everything else is reported as unattributed.

**Tech Stack:** TypeScript ESM (`.js` specifiers), Prisma 5 + PostgreSQL, Express 4, Zod, Vitest + Supertest; Vue 3 `<script setup>`, Pinia, Tailwind v3, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-01-dispatch-service-platform-design.md` (§4 T4, §6 invariants)

## Global Constraints

1. **Absent must never render as measured.** No price for a state, no state for a stop, no mpg for a carrier — each renders as unknown, never as zero, and never as a confident saving.
2. **One definition per concept.** `resolveRateConfig` stays the only cost-model resolver; `stateOf` becomes the only stop→state resolver.
3. **Engine-authoritative.** The server computes burn and advice; the client renders.
4. **404, never 403,** for cross-tenant ids.
5. **T4 MUST NOT change how margin is costed.** `RateConfig.dieselCentsPerGal` remains the costing assumption behind every `estCostCents` and every committed `Rate` snapshot. `FuelPrice` answers a different question — *where should the driver buy* — and feeds advice only. Wiring observed prices into margin would silently redefine every historical margin in the product. If a task's text seems to ask for that, it is wrong; stop and raise it.
6. **Never attribute a mile or a gallon to a state we did not read off a stop.** IFTA is a tax filing. Distributing unattributed gallons across states "proportionally" would manufacture evidence for a government submission. Unattributed volume is reported as unattributed, always, however unhelpful that looks.

---

### Task 1: Fuel burn along a plan

**Files:**
- Create: `fleet-backend/src/domain/dispatch/fuel.ts`
- Modify: `fleet-backend/src/domain/dispatch/index.ts`
- Test: `fleet-backend/tests/engine-fuel-burn.test.ts` (create)

**Interfaces:**
- Consumes: `DispatchPlan` (`deadheadMi`, `loadedMi`), `RateConfig` (`mpg`).
- Produces:

```ts
export interface FuelBurn {
  deadheadGal: number;
  loadedGal: number;
  totalGal: number;
  /** null when the carrier's mpg is unusable — absent, not zero */
  mpgUsed: number | null;
}
export function fuelBurn(plan: { deadheadMi: number; loadedMi: number }, mpg: number): FuelBurn;
```

Used by Tasks 4, 5, 7.

- [ ] **Step 1: Write the failing test**

Cover: 600 loaded + 100 deadhead at 6.5 mpg gives 107.69 total gallons (assert to 2dp);
`totalGal === deadheadGal + loadedGal` exactly; **`mpg <= 0` returns all-null/zero with
`mpgUsed: null` rather than `Infinity`** (this is the live defect class — `priceOrRefuse`
already exists in `dispatcherAssignments.ts` precisely because an unusable mpg once produced
a bare 500); `mpg` of `NaN` behaves the same as `<= 0`; zero miles gives zero gallons with a
non-null `mpgUsed`.

- [ ] **Step 2: Run it to confirm failure**

Run: `cd fleet-backend && npx vitest run tests/engine-fuel-burn.test.ts`

- [ ] **Step 3: Implement**

```ts
// How much diesel a plan burns. Pure arithmetic over miles and the carrier's
// own mpg — no price, no state, no I/O. Price lives in FuelPrice and is a
// separate question deliberately (Global Constraint 5).

export interface FuelBurn {
  deadheadGal: number;
  loadedGal: number;
  totalGal: number;
  /** null when mpg is unusable. Callers must render unknown, never 0 gal. */
  mpgUsed: number | null;
}

export function fuelBurn(plan: { deadheadMi: number; loadedMi: number }, mpg: number): FuelBurn {
  // An unusable mpg divides into Infinity and would render as a confident,
  // enormous fuel bill. Refuse to answer instead.
  if (!Number.isFinite(mpg) || mpg <= 0) {
    return { deadheadGal: 0, loadedGal: 0, totalGal: 0, mpgUsed: null };
  }
  const deadheadGal = plan.deadheadMi / mpg;
  const loadedGal = plan.loadedMi / mpg;
  return { deadheadGal, loadedGal, totalGal: deadheadGal + loadedGal, mpgUsed: mpg };
}
```

Export from `index.ts`.

- [ ] **Step 4: Run** — `npx vitest run tests/engine-fuel-burn.test.ts` then the full suite.

- [ ] **Step 5: Prove discrimination** — remove the `mpg <= 0` guard; the unusable-mpg test must
fail with `Infinity`. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/fuel.ts fleet-backend/src/domain/dispatch/index.ts fleet-backend/tests/engine-fuel-burn.test.ts
git commit -m "feat(engine): fuel burn along a plan, refusing an unusable mpg"
```

---

### Task 2: The `FuelPrice` model

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma`
- Create: migration (generated)
- Test: `fleet-backend/tests/fuel-price-model.test.ts` (create)

```prisma
// Observed diesel price for one US state on one date. Org-scoped: a dispatch
// service's negotiated network pricing is its own business, not a shared fact.
//
// This is NOT the costing assumption. RateConfig.dieselCentsPerGal still prices
// every margin and every committed Rate snapshot (Global Constraint 5); this
// table answers "where should the driver buy", which is a different question
// with a different answer.
model FuelPrice {
  id          String   @id @default(uuid())
  orgId       String
  org         Org      @relation(fields: [orgId], references: [id])
  /// two-letter US state code, uppercase
  state       String
  centsPerGal Int
  /// the day this price was observed; the resolver takes the latest <= today
  effectiveOn DateTime
  source      String   @default("import") // import | demo | provider
  createdAt   DateTime @default(now())

  @@unique([orgId, state, effectiveOn])
  @@index([orgId, state, effectiveOn])
}
```

Add `fuelPrices FuelPrice[]` to `Org`.

- [ ] **Step 1** Add the model and `npx prisma migrate dev --name t4_fuel_prices`.
- [ ] **Step 2** Add `prisma.fuelPrice.deleteMany()` to `resetDb()` in `tests/helpers.ts` — the
  `orgId` FK is `ON DELETE RESTRICT` and T3's Task 3 hit exactly this.
- [ ] **Step 3** Test: the `@@unique` rejects a duplicate `(org, state, date)`; two orgs may hold
  different prices for the same state on the same day; a query for a state with no rows returns
  `[]` rather than throwing.
- [ ] **Step 4** Run `npx vitest run tests/fuel-price-model.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add fleet-backend/prisma/schema.prisma fleet-backend/prisma/migrations fleet-backend/tests/helpers.ts fleet-backend/tests/fuel-price-model.test.ts
git commit -m "feat(db): add org-scoped FuelPrice model"
```

---

### Task 3: `stateOf` — the only stop→state resolver

**Files:**
- Create: `fleet-backend/src/lib/stateOf.ts`
- Test: `fleet-backend/tests/state-of.test.ts` (create)

**Interfaces:**

```ts
/** Two-letter uppercase state code, or null when it cannot be read off the
 *  stop. NEVER inferred from coordinates alone beyond the gazetteer's own
 *  nearest-city match, and never guessed. */
export function stateOf(stop: { address?: string | null; lat?: number | null; lng?: number | null }): string | null;
```

Used by Tasks 4, 5, 7.

**Why this is its own task.** Every downstream number — which price applies, which state a gallon
is attributed to — hangs on this one answer. A wrong state is worse than no state: it produces a
confident saving computed against the wrong price, and (Global Constraint 6) a tax-relevant
attribution nobody can trace. It gets its own file, its own tests, and one definition.

- [ ] **Step 1: Write the failing test**

Cover:
- `"Kansas City, MO"` → `"MO"`; `"kansas city, mo"` → `"MO"` (case-insensitive, uppercased out);
- `"Kansas City, MO 64106"` → `"MO"` (trailing ZIP);
- `"1200 Main St, Saint Louis, Missouri"` → `null`. **Full state names are not parsed.** Two
  letters after a comma is a format we can verify; a name is a lookup we have not built, and
  guessing "Missouri" → MO invites "Washington" → WA for Washington, DC.
- `""`, `null`, `"Somewhere"` → `null`;
- `"Springfield, XX"` → `null` — `XX` is not a US state, and the check is a real 50-state +
  DC set, not a two-letter regex;
- coordinates with no address fall back to the gazetteer's `nearestCity` and take its `|st`
  suffix **only when within its `maxMi`**; beyond that, `null`;
- a stop with a parseable address AND coordinates uses the address (it is the asserted fact).

- [ ] **Step 2: Run it to confirm failure.**

- [ ] **Step 3: Implement.** Use `nearestCity` from `src/lib/usCities.js` for the coordinate path;
its keys are `"city|st"`, so the state is the segment after `|`, uppercased. Hold the valid set as
an explicit frozen array of the 50 states plus DC.

- [ ] **Step 4: Run** the file, then the full suite.

- [ ] **Step 5: Prove discrimination** — accept any two letters instead of checking the state set;
the `"Springfield, XX"` test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/lib/stateOf.ts fleet-backend/tests/state-of.test.ts
git commit -m "feat: stateOf — the single stop-to-state resolver"
```

---

### Task 4: Fuel advice — "buy N gal here, save $X"

**Files:**
- Create: `fleet-backend/src/domain/dispatch/fuelAdvice.ts`
- Modify: `fleet-backend/src/domain/dispatch/index.ts`
- Test: `fleet-backend/tests/engine-fuel-advice.test.ts` (create)

**Interfaces:**

```ts
export interface PricedStop {
  sequence: number;
  label: string;          // human-readable, e.g. "Kansas City, MO"
  state: string;          // caller has already resolved this; never null here
  centsPerGal: number;
}
export interface FuelAdvice {
  /** where to buy */
  atSequence: number;
  atLabel: string;
  state: string;
  gallons: number;
  centsPerGal: number;
  /** the stop this is cheaper THAN — advice is always comparative */
  vsLabel: string;
  vsCentsPerGal: number;
  savingCents: number;
}
export const MIN_SAVING_CENTS = 500;
export function fuelAdvice(burn: FuelBurn, stops: PricedStop[]): FuelAdvice | null;
```

Used by Task 7.

- [ ] **Step 1: Write the failing test**

Cover:
- two priced stops, cheaper first → advice names the cheap one, `savingCents` equals
  `gallons × (dear − cheap)` rounded to whole cents;
- cheaper stop is LAST → **`null`**. You cannot buy fuel at the delivery to power the drive that
  got you there. Only a stop the driver reaches before burning the fuel can be advised, and this
  test is what pins that;
- fewer than two priced stops → `null`;
- `burn.mpgUsed === null` → `null` (no burn, no advice);
- a saving under `MIN_SAVING_CENTS` → `null`, so the UI is not littered with 40-cent advice;
- identical prices → `null`;
- `gallons` never exceeds `burn.totalGal`.

- [ ] **Step 2: Run it to confirm failure.**

- [ ] **Step 3: Implement.** The cheapest *reachable* stop is the minimum over stops before the
last one; compare against the most expensive stop at or after it. Round with `Math.round` at the
final cent, never per-gallon.

- [ ] **Step 4: Run** the file, then the full suite.

- [ ] **Step 5: Prove discrimination** — allow the last stop to be advised; the "cheaper stop is
LAST" test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/fuelAdvice.ts fleet-backend/src/domain/dispatch/index.ts fleet-backend/tests/engine-fuel-advice.test.ts
git commit -m "feat(engine): comparative fuel advice with a minimum saving floor"
```

---

### Task 5: IFTA attribution — and the remainder we refuse to distribute

**Files:**
- Create: `fleet-backend/src/domain/dispatch/iftaAttribution.ts`
- Modify: `fleet-backend/src/domain/dispatch/index.ts`
- Test: `fleet-backend/tests/engine-ifta-attribution.test.ts` (create)

**Interfaces:**

```ts
export interface StateGallons { state: string; gallons: number }
export interface IftaAttribution {
  byState: StateGallons[];
  /** gallons we could NOT attribute to a state. Reported, never distributed. */
  unattributedGal: number;
  /** true only when unattributedGal is 0 — the flag a filing UI must gate on */
  complete: boolean;
}
export function attributeGallons(burn: FuelBurn, stopStates: (string | null)[]): IftaAttribution;
```

**This task is the slice's conscience. Read it twice.**

We do not know which states a route crosses. We know the state of each *stop*, when its address
says so. Splitting the burn evenly between the states of consecutive known stops is a defensible
estimate for a leg whose endpoints are both known; it is **not** defensible for a leg with an
unknown endpoint, and it is never defensible to spread the leftover across states to make the
totals balance.

IFTA is filed with a state revenue department. A gallon attributed to Kansas because the arithmetic
needed somewhere to put it is fabricated evidence in a tax submission. `unattributedGal` exists so
the number can stay honestly incomplete, and `complete` exists so no UI can present a partial
attribution as a filing.

- [ ] **Step 1: Write the failing test**

Cover:
- all stop states known → every gallon lands in `byState`, `unattributedGal === 0`, `complete: true`;
- **sum of `byState` gallons + `unattributedGal` === `burn.totalGal`**, to 6dp, in every case —
  this is the invariant that makes the whole structure trustworthy, so assert it in each test;
- one unknown stop state → the legs touching it contribute to `unattributedGal`, and **no other
  state's number changes** compared to the all-known case for the legs that did not touch it;
- ALL states unknown → `byState` is `[]`, `unattributedGal === burn.totalGal`, `complete: false`;
- `burn.mpgUsed === null` → all zero, `complete: false` (we do not know the burn, so we certainly
  do not know its attribution);
- states are aggregated: two stops in MO produce one MO row, not two.

- [ ] **Step 2: Run it to confirm failure.**

- [ ] **Step 3: Implement.** Distribute per leg proportionally to that leg's share of total miles —
which the caller supplies by passing `stopStates` aligned to the plan's stop order. A leg with
either endpoint unknown contributes wholly to `unattributedGal`. Never renormalise.

- [ ] **Step 4: Run** the file, then the full suite.

- [ ] **Step 5: Prove discrimination** — make the implementation spread `unattributedGal` across
the known states proportionally (the "helpful" version). The ALL-unknown test and the
conservation test must both fail. Restore, and note in your report that this was the tempting
wrong answer.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/iftaAttribution.ts fleet-backend/src/domain/dispatch/index.ts fleet-backend/tests/engine-ifta-attribution.test.ts
git commit -m "feat(engine): IFTA gallon attribution that reports its own gaps"
```

---

### Task 6: Fuel-price CRUD, import and demo seed

**Files:**
- Create: `fleet-backend/src/routes/dispatcherFuelPrices.ts`
- Modify: `fleet-backend/src/app.ts`, `fleet-backend/seed-demo.mjs`
- Test: `fleet-backend/tests/dispatcher-fuel-prices.test.ts` (create)

Endpoints: `GET/POST /fuel-prices`, `POST /fuel-prices/import`, `DELETE /fuel-prices/:id`.
Copy `dispatcherRestStops.ts` (T3 Task 6) for structure — same auth, same org scoping, same
404-not-403. Mount after the `/api/dispatcher` auth gate.

- [ ] **Step 1: Write the failing tests** — cross-tenant `DELETE` returns **404**; Zod rejects
`state: "XX"` and a negative `centsPerGal`; CSV import round-trips; `GET ?state=MO` returns the
**latest** `effectiveOn` at or before today, not merely the newest row; unauthenticated is 401.
- [ ] **Step 2: Run to confirm failure.**
- [ ] **Step 3: Implement the route.**
- [ ] **Step 4: Seed.** Prices for the states the demo lanes touch (MO, KS, NE, IL, TN, CO),
`source: "demo"`, with a comment stating plainly that these are illustrative figures and not
observed EIA data. **Deliberately leave one lane's state unpriced** so the "unknown" path is
demonstrable, and name that state in a comment. Follow T3's precedent: the seed's cleanup must
delete dependent rows before parents, and must be idempotent across three consecutive runs.
- [ ] **Step 5: Run** the file, `node seed-demo.mjs` three times, then the full suite.
- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/routes/dispatcherFuelPrices.ts fleet-backend/src/app.ts fleet-backend/seed-demo.mjs fleet-backend/tests/dispatcher-fuel-prices.test.ts
git commit -m "feat(api): fuel-price CRUD, CSV import and demo seed"
```

---

### Task 7: Wire fuel into the assignment verdict

**Files:**
- Create: `fleet-backend/src/lib/fuelPlan.ts`
- Modify: `fleet-backend/src/routes/dispatcherAssignments.ts`
- Test: `fleet-backend/tests/dispatcher-fuel-plan.test.ts` (create)

**Interfaces:** every verdict body gains

```ts
interface FuelPlanBody {
  burn: FuelBurn;
  advice: FuelAdvice | null;
  ifta: IftaAttribution;
  /** false when the carrier's mpg was unusable or no price was found at all */
  known: boolean;
}
```

**Both conflict-assembly sites must be updated** — the POST commit path (~line 251) and
`PATCH /:id/plan` (~line 845) — and `fuelPlan` attached to every response shape: dry-run, 422,
commit success, and PATCH's `plan_too_short` 422. T3's Task 7 established this shape; follow it.

Fuel raises **no conflicts**. It is advice, never a refusal — there is no such thing as a plan
too expensive to be legal.

- [ ] **Step 1: Write the failing tests** — a plan with priced stops returns advice; an org with
no prices returns `known: false` with `advice: null` and **`feasible` unchanged**; a carrier with
`mpg: 0` returns `known: false` and does not 500; `ifta.complete` is `false` when any stop's state
is unresolved; **no `conflicts` entry is ever added by this task** (assert the conflict count is
identical with and without fuel prices present).
- [ ] **Step 2: Run to confirm failure.**
- [ ] **Step 3: Implement.** `fuelPlan.ts` resolves each stop's state via `stateOf`, looks up the
latest price per distinct state in ONE query, then calls `fuelBurn`, `fuelAdvice` and
`attributeGallons`. Resolve mpg through `rateConfigForDriver` — the carrier's, not the org's
(T1 Task 3). Every `await` must sit inside the existing try/catch: Express 4 does not await
handlers, and an unhandled rejection here sends no response at all.
- [ ] **Step 4: Run** the full suite.
- [ ] **Step 5: Prove discrimination** — make the missing-price path return `known: true` with a
zero-cent price; the "org with no prices" test must fail. Restore.
- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/lib/fuelPlan.ts fleet-backend/src/routes/dispatcherAssignments.ts fleet-backend/tests/dispatcher-fuel-plan.test.ts
git commit -m "feat(api): attach fuel burn, advice and IFTA attribution to every verdict"
```

---

### Task 8: Fuel in the verdict modal

**Files:**
- Modify: `fleet-portal/src/components/cockpit/PlanVerdictModal.vue`, `fleet-portal/src/lib/api.ts`
- Test: `PlanVerdictModal.spec.ts`

Three states, mirroring T3's break row:

| Condition | Render |
|---|---|
| `known: false` | "fuel estimate unavailable" — no cost, no gallons |
| `known: true`, `advice: null` | gallons and burn only, no saving claimed |
| `known: true`, `advice` present | "Buy 118 gal in Kansas City, MO — saves $47 vs Denver, CO" |

Plus: `ifta.complete === false` renders the attributed states **and** an explicit
"N gal unattributed" line. Never hide the remainder; a partial attribution that looks complete is
the defect this whole slice is shaped to avoid.

- [ ] **Step 1** Write the failing tests, including that `fuelPlan` absent entirely renders as
unavailable and does not crash (older server responses must degrade).
- [ ] **Step 2** Run to confirm failure.
- [ ] **Step 3** Implement. Reuse the modal's existing money formatters (`formatUsd`); do not add
a second one.
- [ ] **Step 4** `npx vitest run && npx vue-tsc --noEmit && npm run build`.
- [ ] **Step 5** Discrimination: hide the unattributed line; its test must fail. Restore.
- [ ] **Step 6: Commit**

```bash
git add fleet-portal/src/components/cockpit/PlanVerdictModal.vue fleet-portal/src/lib/api.ts fleet-portal/src/components/cockpit/PlanVerdictModal.spec.ts
git commit -m "feat(cockpit): fuel burn, advice and unattributed gallons in the verdict"
```

---

### Task 9: Fuel saving on the board

**Files:**
- Modify: `fleet-portal/src/stores/cockpit.ts`, `fleet-portal/src/components/cockpit/GanttBoard.vue`, `fleet-portal/src/components/cockpit/LegBrick.vue`
- Test: `cockpit.spec.ts`, `LegBrick.spec.ts`, `GanttBoard.spec.ts`

Follow T3's Ruling 7/8 wiring exactly: a `fuelPlanByLoadId` cache populated from every verdict
response via the same `applyBreakPlan` sibling, handed **down** to `LegBrick` as a prop by
`GanttBoard` — the brick stays presentational and there remains one reader per surface.

Absence rule, identical to the break glyph: **no cached fuel plan → no chip.** Not "$0 saved",
not "unknown" on every brick.

- [ ] **Step 1** Write the failing tests, including: no cache → no chip; `known: false` → no chip;
`advice: null` → no chip; advice present → chip showing the saving.
- [ ] **Step 2** Run to confirm failure.
- [ ] **Step 3** Implement.
- [ ] **Step 4** `npx vitest run && npx vue-tsc --noEmit && npm run build`.
- [ ] **Step 5** Discrimination: render the chip when `advice` is null; that test must fail. Restore.
- [ ] **Step 6: Commit**

```bash
git add fleet-portal/src/stores/cockpit.ts fleet-portal/src/components/cockpit/GanttBoard.vue fleet-portal/src/components/cockpit/LegBrick.vue fleet-portal/src/components/cockpit/LegBrick.spec.ts fleet-portal/src/components/cockpit/GanttBoard.spec.ts fleet-portal/src/stores/cockpit.spec.ts
git commit -m "feat(cockpit): fuel saving chip on the brick"
```

---

### Task 10: Live pass

**Files:** none (verification only).

T2's live pass caught a layer that drew nothing. T3's caught a demo scenario with no reachable
load. Run this one against a **deliberately restarted** backend — `tsx` is not a watch process,
and a Prisma migration will leave it holding a stale client.

- [ ] **Step 1** Kill the fleet-backend `tsx` process (leave other projects' alone),
`npx prisma generate`, `node seed-demo.mjs`, restart, confirm `/health` and that
`/api/dispatcher/fuel-prices` returns **401** unauthenticated rather than 500.
- [ ] **Step 2** Verify in the browser, driving the real gesture pipeline:
  - a plan whose stops are priced shows gallons and a named dollar saving naming both stops;
  - **delete every fuel price, re-run the same plan → "fuel estimate unavailable", `feasible` unchanged, no new conflict.** This is the most important check in the slice.
  - a lane touching the deliberately-unpriced state (Task 6) shows the attributed states **and** an explicit unattributed-gallons line;
  - a carrier with `mpg` set to 0 does not 500 and renders unavailable;
  - zero console errors; screenshot both themes into `docs/screenshots/`.
- [ ] **Step 3** Full suites: `npx vitest run --pool=forks`, `npx tsc --noEmit`, and in the portal
`npx vitest run && npx vue-tsc --noEmit && npm run build`.
- [ ] **Step 4** Restore the seed and confirm it is idempotent across three runs.

---

## Self-Review

**Spec coverage.** §4 T4 asks for four things. *"Fuel burn along a plan"* — Task 1. *"State diesel
price differential"* — Tasks 2, 3, 6. *"Buy N gal here, save $X"* — Task 4, rendered in Tasks 8–9.
*"Ties into IFTA"* — Task 5. Acceptance *"a leg shows a named fuel saving in dollars"* is Task 9's
chip, with Task 8's modal row as the detailed view.

**The two things to get right.**

*Global Constraint 5* — T4 must not touch margin. `RateConfig.dieselCentsPerGal` keeps pricing
every `estCostCents` and every committed `Rate` snapshot; `FuelPrice` only advises. Wiring
observed prices into costing would silently restate every historical margin in the product, and
no task here does it.

*Task 5's `unattributedGal`* — the tempting implementation spreads the remainder across known
states so the totals look tidy. That number would land in a state tax filing. The conservation
assertion (`byState + unattributed === totalGal`) and the all-unknown case exist to make the
honest version the only one that passes.

**Type consistency.** `FuelBurn` (Task 1) → `PricedStop`/`FuelAdvice` (Task 4) and
`IftaAttribution` (Task 5) → `FuelPlanBody` (Task 7) → modal props (Task 8) → brick chip (Task 9).
`stateOf` (Task 3) is the only producer of a state code anywhere in the chain.

**Known interaction with T3.** Tasks 7–9 touch the same three files T3 just changed
(`dispatcherAssignments.ts`, `cockpit.ts`, `LegBrick.vue`). Each adds a sibling field beside the
break equivalents rather than reshaping them; if a task's diff *modifies* break-plan code rather
than adding beside it, that is a signal to stop and re-read.
