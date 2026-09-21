# T3 — Break & Rest Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine says *where* along a plan the driver's 8-hour clock runs out, offers the rest options reachable at that point, and refuses a plan whose break has nowhere to happen — with a stated reason.

**Architecture:** `evaluate()` already computes *when* every 30-minute break falls: `driveLeg()` counts each crossing of the 480-minute cumulative-driving boundary and silently discards the position. T3 keeps that arithmetic exactly as-is and makes it *emit* what it already knows — the leg index and the fraction along that leg — then interpolates a geographic point. A new org-scoped `RestStop` table supplies candidates; a pure ranker picks the reachable ones by detour. A `no_rest` conflict fires **only when the org has rest data in the region and none of it is reachable** — never when the data is simply absent.

**Tech Stack:** TypeScript ESM (`.js` import specifiers), Prisma 5 + PostgreSQL, Express 4, Zod, Vitest + Supertest; Vue 3 `<script setup>`, Pinia, Tailwind v3 semantic tokens, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-01-dispatch-service-platform-design.md` (§4 T3, §6 invariants, §7 risks)

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

1. **Absent must never render as measured.** No rest data ≠ no rest available. An estimated break point is never presented as a surveyed one.
2. **One definition per concept.** There is exactly one break-point calculation, and it is the one `driveLeg()` already performs. Do not write a second one.
3. **Engine-authoritative.** The server computes break points and rest options; the client renders them.
4. **404, never 403,** for cross-tenant ids.
5. **A POI appears only when the plan implies a need for it** (R4). No "show all truck stops" toggle. Rest stops render only for a plan that needs a break.
6. **HOS is deterministic law** (`hos.ts` header). `BREAK_THRESHOLD_MIN = 480`, `BREAK_DURATION_MIN = 30`. T3 must not change *whether* a break is required or *how many* are required — only *where* and *whether one is possible*.
7. **Every break point carries its precision.** `precision: 'routed'` only when `roadMilesFn` supplied real miles for that leg; otherwise `'estimated'`. The UI renders estimated values with a `≈` prefix. Spec §7: *"a break suggestion that is confidently wrong is worse than none."*

---

### Task 1: Break points in the engine

**Files:**
- Modify: `fleet-backend/src/domain/dispatch/types.ts`
- Modify: `fleet-backend/src/domain/dispatch/evaluate.ts` (the `driveLeg` closure, ~line 105)
- Test: `fleet-backend/tests/engine-breakpoints.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BreakPoint` type and `DispatchPlan.breaks: BreakPoint[]`, consumed by Tasks 2, 5, 7.

Add to `types.ts`:

```ts
/** Where and when a mandatory 30-min break lands inside a plan. Emitted by the
 *  same arithmetic that already inserts the break into the timeline — never a
 *  second calculation (Global Constraint 2). */
export interface BreakPoint {
  /** epoch ms the break begins */
  atMs: number;
  /** cumulative driving minutes into the trip when it begins */
  afterDriveMin: number;
  /** which leg it falls on. -1 = the deadhead leg; 0..n = the leg departing
   *  stops[i]. */
  legIndex: number;
  /** 0..1 position along that leg's driving time when the break begins */
  fraction: number;
  /** interpolated geographic position; null until Task 2 fills it */
  at: GeoPoint | null;
  /** 'routed' only when real provider miles backed this leg (Global
   *  Constraint 7); the UI prefixes estimated values with '≈' */
  precision: "routed" | "estimated";
}
```

and to `DispatchPlan`, directly under `needsBreak`:

```ts
  /** every mandatory break this plan contains, in time order. Empty when
   *  needsBreak is false. `needsBreak === (breaks.length > 0)` always. */
  breaks: BreakPoint[];
```

- [ ] **Step 1: Write the failing test**

Create `fleet-backend/tests/engine-breakpoints.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import type { DriverInput, LoadInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

const T0 = Date.UTC(2026, 8, 1, 6, 0, 0);

const tractor: TractorInput = { status: "active" };
const trailer: TrailerInput = { type: "DryVan", status: "active" };

/** 7 driving hours already banked: any leg over 1h forces a break. */
function driverAt(lat: number, lng: number, minutesSinceBreak = 420): DriverInput {
  return {
    status: "active",
    hazmatEndorsed: false,
    availableAt: T0,
    location: { lat, lng },
    hos: {
      driveRemainingMin: 660,
      windowRemainingMin: 840,
      cycleRemainingMin: 3600,
      minutesSinceBreak,
    },
  };
}

const KC = { lat: 39.0997, lng: -94.5786 };
const COLUMBIA = { lat: 38.9517, lng: -92.3341 };
const MEMPHIS = { lat: 35.1495, lng: -90.049 };
const CHICAGO = { lat: 41.878, lng: -87.6298 };

/** KC -> Columbia MO: ~120 mi great-circle, ~145 road mi, ~173 driving min.
 *  Short enough that a rested driver needs NO break — which is what makes it
 *  usable as the negative case. (KC -> Memphis is ~533 driving minutes and
 *  crosses 480 even from zero banked, so it cannot serve that role.) */
const shortHaul: LoadInput = {
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: COLUMBIA, dwellMin: 60 },
  ],
};

/** KC -> Memphis: ~370 mi great-circle, ~444 road mi, ~533 driving min. */
const longHaul: LoadInput = {
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: MEMPHIS, dwellMin: 60 },
  ],
};

describe("break points", () => {
  it("emits no breaks when the trip never crosses the 8h boundary", () => {
    // Driver sits on the pickup (no deadhead), 173 min of driving, nothing
    // banked: 173 < 480, so no crossing.
    const res = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 0), tractor, trailer);
    expect(res.plan.breaks).toEqual([]);
    expect(res.plan.needsBreak).toBe(false);
  });

  it("emits one break on the loaded leg, positioned by fraction", () => {
    const res = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 420), tractor, trailer);
    expect(res.plan.needsBreak).toBe(true);
    expect(res.plan.breaks).toHaveLength(1);
    const b = res.plan.breaks[0];
    // 420 banked + 60 more driving = 480. Deadhead is 0, so the break lands
    // 60 driving-minutes into the loaded leg — roughly a third of the way.
    expect(b.afterDriveMin).toBeCloseTo(60, 5);
    expect(b.legIndex).toBe(0);
    expect(b.fraction).toBeGreaterThan(0.2);
    expect(b.fraction).toBeLessThan(0.5);
    expect(b.precision).toBe("estimated");
    expect(b.at).toBeNull(); // Task 2 fills this in
  });

  it("places the break on the deadhead leg when the clock expires before pickup", () => {
    // Chicago -> KC deadhead (~590 driving min) with 7h50m banked: the
    // crossing happens 10 min in, en route to the pickup. This plan is HOS-
    // infeasible overall, which is fine — breaks are emitted from the
    // timeline walk regardless of the verdict, and asserting on an
    // infeasible plan proves that.
    const res = evaluate(shortHaul, driverAt(CHICAGO.lat, CHICAGO.lng, 470), tractor, trailer);
    expect(res.plan.breaks.length).toBeGreaterThanOrEqual(1);
    expect(res.plan.breaks[0].legIndex).toBe(-1);
    expect(res.plan.breaks[0].afterDriveMin).toBeCloseTo(10, 5);
  });

  it("agrees with the timeline: the break adds exactly 30 min to proposedEnd", () => {
    // Same load, same driver, same origin — the ONLY difference is banked
    // minutes, so the whole delta is the inserted break.
    const withBreak = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 420), tractor, trailer);
    const without = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 0), tractor, trailer);
    expect(withBreak.plan.breaks).toHaveLength(1);
    expect(without.plan.breaks).toHaveLength(0);
    const deltaMin = (withBreak.plan.proposedEnd - without.plan.proposedEnd) / 60_000;
    expect(deltaMin).toBeCloseTo(30, 5);
  });

  it("needsBreak is exactly breaks.length > 0", () => {
    for (const since of [0, 100, 306, 307, 420, 479, 480, 600]) {
      const res = evaluate(shortHaul, driverAt(KC.lat, KC.lng, since), tractor, trailer);
      expect(res.plan.needsBreak).toBe(res.plan.breaks.length > 0);
    }
  });

  it("orders breaks by time and matches the count evaluateHos reports", () => {
    const res = evaluate(longHaul, driverAt(CHICAGO.lat, CHICAGO.lng, 400), tractor, trailer);
    const times = res.plan.breaks.map((b) => b.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // onDutyMin includes BREAK_DURATION_MIN per break; the two counters must
    // never disagree (Global Constraint 2 — one definition per concept).
    const impliedBreaks = (res.plan.onDutyMin - res.plan.driveMin - 120) / 30;
    expect(res.plan.breaks).toHaveLength(impliedBreaks);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd fleet-backend && npx vitest run tests/engine-breakpoints.test.ts`
Expected: FAIL — `plan.breaks` is undefined.

- [ ] **Step 3: Implement**

In `evaluate.ts`, `driveLeg` currently closes over `sinceBreakMin` and
`breaksTaken`. It needs three more bindings, declared beside them:

```ts
  const breaks: BreakPoint[] = [];
  let driveMinSoFar = 0;
  // -1 = deadhead; 0..n = the leg departing stops[i]. Set immediately before
  // each driveLeg() call so a break records the leg it actually falls on.
  let legIndex = -1;
  let legPrecision: "routed" | "estimated" = "estimated";
```

`driveLeg` must also read `cursor`, which is currently declared *after* it.
Move the declaration up — `let cursor = proposedStart;` — and change the
deadhead line from `let cursor = proposedStart + driveLeg(deadheadDriveMin)`
to `cursor += driveLeg(deadheadDriveMin)`.

Replace `driveLeg` with the version below. **The arithmetic is unchanged**;
only the `breaks.push` and the two counters are new. Any change to the
`remaining`/`sinceBreakMin`/`ms` sequence violates Global Constraint 6.

```ts
  const driveLeg = (legMin: number): number => {
    let ms = legMin * MIN_MS;
    let remaining = legMin;
    // driving minutes already consumed on THIS leg when a break triggers
    let consumedOnLeg = 0;
    // breaks already inserted on THIS leg. `cursor` is the leg's departure
    // instant, so the offset to a break must count only the delay added since
    // that instant — the trip-wide `breaksTaken` would double-count every
    // break from an earlier leg.
    let breaksOnLeg = 0;
    while (sinceBreakMin + remaining > BREAK_THRESHOLD_MIN) {
      const untilBreak = BREAK_THRESHOLD_MIN - sinceBreakMin;
      consumedOnLeg += untilBreak;
      breaks.push({
        atMs: cursor + (consumedOnLeg + breaksOnLeg * BREAK_DURATION_MIN) * MIN_MS,
        afterDriveMin: driveMinSoFar + consumedOnLeg,
        legIndex,
        // A zero-length leg cannot host a break, but guard the division
        // anyway: NaN here would silently poison every downstream ETA.
        fraction: legMin > 0 ? consumedOnLeg / legMin : 0,
        at: null,
        precision: legPrecision,
      });
      remaining -= untilBreak;
      sinceBreakMin = 0;
      ms += BREAK_DURATION_MIN * MIN_MS;
      breaksTaken += 1;
      breaksOnLeg += 1;
    }
    sinceBreakMin += remaining;
    driveMinSoFar += legMin;
    return ms;
  };
```

Before the deadhead call, set the leg identity:

```ts
  legIndex = -1;
  legPrecision =
    context.roadMilesFn?.(driver.location, firstStop.location) != null ? "routed" : "estimated";
  cursor += driveLeg(deadheadDriveMin);
```

and inside the stop loop, immediately before `cursor += driveLeg(legMin)`:

```ts
      legIndex = i;
      legPrecision =
        context.roadMilesFn?.(stop.location, stops[i + 1].location) != null ? "routed" : "estimated";
```

Add `breaks` to the returned plan, and `breaks: []` to the `invalid()`
helper's plan. Import `BreakPoint` in the type-import list.

- [ ] **Step 4: Run the tests**

Run: `cd fleet-backend && npx vitest run tests/engine-breakpoints.test.ts`
then `npx vitest run --pool=forks`
Expected: new file PASS; **all 89 existing files still PASS**. The timeline
arithmetic is untouched, so no existing ETA assertion may move. If one does,
the `driveLeg` rewrite changed behaviour — revert and redo it.

- [ ] **Step 5: Prove the test discriminates**

Break the fix: change `fraction: legMin > 0 ? consumedOnLeg / legMin : 0` to
`fraction: 0.5`. Re-run and name the assertion that fails. Then set
`legIndex` once at the top instead of before each leg, re-run, and name the
assertion that catches it. Restore both.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/types.ts fleet-backend/src/domain/dispatch/evaluate.ts fleet-backend/tests/engine-breakpoints.test.ts
git commit -m "feat(engine): emit break points with leg, fraction and precision"
```

---

### Task 1b: One definition of "how many breaks" (added during execution)

Task 1 made the timeline walk's break count observable for the first time and
immediately exposed that `evaluateHos` disagrees with it — undercounting
whenever a drive time is fractional (i.e. always, in practice) and reporting
zero breaks for a driver already past the 8-hour threshold. Because
`requiredOnDutyMin` charges 30 minutes per break, the undercount checks the
14-hour window against a number 30 minutes short of what the timeline actually
consumes: a plan declared feasible that is not.

Full task text: `.superpowers/sdd/2026-09-01-t3-break-and-rest-planning/task-1b-brief.md`.
Rationale and the reproduction table: Ruling 5 in that directory's `progress.md`.

This is Global Constraint 2 doing its job — two definitions of one concept
drifted, and nothing compared them until a third consumer appeared.

---

### Task 2: Interpolate the break's geographic position

**Files:**
- Create: `fleet-backend/src/domain/dispatch/breakGeo.ts`
- Modify: `fleet-backend/src/domain/dispatch/evaluate.ts` (fill `at` before returning)
- Modify: `fleet-backend/src/domain/dispatch/index.ts` (export)
- Test: `fleet-backend/tests/engine-break-geo.test.ts` (create)

**Interfaces:**
- Consumes: `BreakPoint` (Task 1).
- Produces: `interpolate(from: GeoPoint, to: GeoPoint, fraction: number): GeoPoint`, used by Tasks 4 and 5.

- [ ] **Step 1: Write the failing test**

Create `fleet-backend/tests/engine-break-geo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { interpolate } from "../src/domain/dispatch/breakGeo.js";
import { haversineMi } from "../src/domain/dispatch/distance.js";

const KC = { lat: 39.0997, lng: -94.5786 };
const MEM = { lat: 35.1495, lng: -90.049 };

describe("interpolate", () => {
  it("returns the endpoints at 0 and 1", () => {
    expect(interpolate(KC, MEM, 0)).toEqual(KC);
    expect(interpolate(KC, MEM, 1)).toEqual(MEM);
  });

  it("puts the midpoint within a mile of half the great-circle distance", () => {
    const mid = interpolate(KC, MEM, 0.5);
    const total = haversineMi(KC, MEM);
    expect(haversineMi(KC, mid)).toBeCloseTo(total / 2, 0);
    expect(haversineMi(mid, MEM)).toBeCloseTo(total / 2, 0);
  });

  it("clamps out-of-range fractions instead of extrapolating", () => {
    // A caller that computed 1.4 has a bug; extrapolating would place the
    // break somewhere the driver never goes.
    expect(interpolate(KC, MEM, -3)).toEqual(KC);
    expect(interpolate(KC, MEM, 42)).toEqual(MEM);
  });

  it("survives coincident endpoints without NaN", () => {
    const p = interpolate(KC, { ...KC }, 0.5);
    expect(Number.isFinite(p.lat)).toBe(true);
    expect(Number.isFinite(p.lng)).toBe(true);
  });

  it("crosses the antimeridian by the short way", () => {
    const mid = interpolate({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.5);
    // The short way is through 180, not back through 0.
    expect(Math.abs(mid.lng)).toBeGreaterThan(179.5);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd fleet-backend && npx vitest run tests/engine-break-geo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `fleet-backend/src/domain/dispatch/breakGeo.ts`:

```ts
// Where a break lands, geographically. Pure; no Date, no I/O.
//
// This is a great-circle interpolation along the leg, NOT a point on a road.
// That is why every BreakPoint carries `precision`: at 'estimated' the caller
// must render it as approximate. A break point presented as surveyed truth
// would be exactly the "confidently wrong" failure the spec warns about
// (§7) — worse than offering nothing at all.

import type { GeoPoint } from "./types.js";

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/**
 * Great-circle interpolation between two points. `fraction` is clamped to
 * [0,1].
 */
export function interpolate(from: GeoPoint, to: GeoPoint, fraction: number): GeoPoint {
  const f = Math.min(1, Math.max(0, fraction));
  if (f === 0) return { lat: from.lat, lng: from.lng };
  if (f === 1) return { lat: to.lat, lng: to.lng };

  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);
  const lat2 = toRad(to.lat);
  const lng2 = toRad(to.lng);

  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  // Coincident endpoints: sin(d) is 0 and the slerp below divides by zero.
  if (d === 0) return { lat: from.lat, lng: from.lng };

  const a = Math.sin((1 - f) * d) / Math.sin(d);
  const b = Math.sin(f * d) / Math.sin(d);
  const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
  const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);

  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDeg(Math.atan2(y, x)),
  };
}
```

In `evaluate.ts`, after the stop loop and before building the return value:

```ts
  // Fill in each break's geography now that every leg endpoint is known.
  // legIndex -1 is the deadhead leg (driver -> first stop); i is the leg
  // departing stops[i].
  const positionedBreaks = breaks.map((b) => {
    const from = b.legIndex === -1 ? driver.location : stops[b.legIndex].location;
    const to = b.legIndex === -1 ? firstStop.location : stops[b.legIndex + 1]?.location;
    // A break recorded on a leg with no destination cannot be positioned.
    // Absent, not guessed (Global Constraint 1).
    if (!to) return b;
    return { ...b, at: interpolate(from, to, b.fraction) };
  });
```

Return `breaks: positionedBreaks`. Export `interpolate` from `index.ts`.

- [ ] **Step 4: Run the tests**

Run: `cd fleet-backend && npx vitest run tests/engine-break-geo.test.ts tests/engine-breakpoints.test.ts`

Task 1's `expect(b.at).toBeNull()` is now wrong — that assertion existed only
to pin Task 1's boundary. Replace it with a real check: `at` is non-null, and
its latitude lies strictly between the two stops' latitudes.

- [ ] **Step 5: Prove the test discriminates**

Change `const f = Math.min(1, Math.max(0, fraction))` to `const f = fraction`.
Re-run; name the failing assertion. Then remove the `if (d === 0)` guard and
re-run the coincident-endpoints case. Restore both.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/breakGeo.ts fleet-backend/src/domain/dispatch/evaluate.ts fleet-backend/src/domain/dispatch/index.ts fleet-backend/tests/engine-break-geo.test.ts fleet-backend/tests/engine-breakpoints.test.ts
git commit -m "feat(engine): interpolate break point geography along its leg"
```

---

### Task 3: The `RestStop` model

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma`
- Create: `fleet-backend/prisma/migrations/<timestamp>_t3_rest_stops/migration.sql` (generated)
- Test: `fleet-backend/tests/rest-stops-model.test.ts` (create)

**Interfaces:**
- Produces: the `RestStop` table and its Prisma client type, consumed by Tasks 4, 6, 7.

- [ ] **Step 1: Add the model**

Append to `schema.prisma`:

```prisma
// Where a driver can legally park for a 30-min break or a 10-hour reset.
// Org-scoped because coverage is a business asset: a dispatch service that has
// imported its carriers' preferred stops should not see a competitor's.
//
// `source` matters for honesty, not just bookkeeping. Demo rows exist so the
// product can be shown without claiming to know real facility locations;
// nothing in this table impersonates a named brand it has not imported.
model RestStop {
  id        String   @id @default(uuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id])
  name      String
  kind      String   // truck_stop | rest_area | yard | customer
  lat       Float
  lng       Float
  /// parking spaces, when known. NULL means unknown — never render as 0.
  spaces    Int?
  amenities String[] @default([])
  source    String   @default("import") // import | demo | provider
  createdAt DateTime @default(now())

  @@index([orgId, lat, lng])
}
```

Add `restStops RestStop[]` to the `Org` model's relation list.

- [ ] **Step 2: Generate and apply the migration**

```bash
cd fleet-backend && npx prisma migrate dev --name t3_rest_stops
```

- [ ] **Step 3: Write the round-trip test**

Create `fleet-backend/tests/rest-stops-model.test.ts` asserting:
- a stop created without `spaces` reads back as `null`, **not** `0`;
- `amenities` defaults to `[]`;
- a bounding-box query on `(orgId, lat, lng)` returns only the rows inside it;
- two orgs' stops never appear in each other's bounding-box results.

Follow `tests/helpers.ts` for org creation and per-process schema isolation.

- [ ] **Step 4: Run**

Run: `cd fleet-backend && npx vitest run tests/rest-stops-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fleet-backend/prisma/schema.prisma fleet-backend/prisma/migrations fleet-backend/tests/rest-stops-model.test.ts
git commit -m "feat(db): add org-scoped RestStop model"
```

---

### Task 4: Rank rest options by detour

**Files:**
- Create: `fleet-backend/src/domain/dispatch/restOptions.ts`
- Modify: `fleet-backend/src/domain/dispatch/index.ts`
- Test: `fleet-backend/tests/engine-rest-options.test.ts` (create)

**Interfaces:**
- Consumes: `haversineMi` from `distance.js`, `GeoPoint` from `types.js`.
- Produces: `RestCandidate`, `RestOption`, `REST_SEARCH_RADIUS_MI`, `rankRestOptions` — used by Tasks 5 and 7.

- [ ] **Step 1: Write the failing test**

Create `fleet-backend/tests/engine-rest-options.test.ts`. Assert:
- a candidate 200 mi away is excluded at the default 35 mi radius;
- of two candidates at equal `offRouteMi`, the one *ahead* on the leg (lower `detourMi`) ranks first;
- `detourMi` equals `dist(point,stop) + dist(stop,legEnd) - dist(point,legEnd)`;
- `detourMi` is **never negative** — a near-collinear stop produces `-1e-13` from float error, and "saves 0 mi" is not a thing a dispatcher should read;
- `spaces: null` survives the ranking as `null`;
- an empty candidate list returns `[]` — **not** an error. Absence is a valid answer here; Task 5 is what distinguishes absence from unavailability.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd fleet-backend && npx vitest run tests/engine-rest-options.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// Which rest stops a driver can actually reach at a break point, ranked by
// what the detour costs. Pure: the DB query that produced `candidates` lives
// in the route layer, so this stays unit-testable and the engine stays
// framework-free.

import { haversineMi } from "./distance.js";
import type { GeoPoint } from "./types.js";

export const REST_SEARCH_RADIUS_MI = 35;

export interface RestCandidate {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  /** NULL when the facility's capacity is unknown. Never coerce to 0. */
  spaces: number | null;
}

export interface RestOption extends RestCandidate {
  /** extra miles vs. driving the leg straight through */
  detourMi: number;
  /** miles from the break point itself */
  offRouteMi: number;
}

/**
 * Rank the reachable rest stops at `point` on a leg ending at `legEnd`.
 * Detour is the extra distance vs. driving straight through, so a stop
 * directly on the route scores ~0 and one behind the driver scores roughly
 * double its offset — which is the honest ordering for a driver who has to
 * come back.
 */
export function rankRestOptions(
  point: GeoPoint,
  legEnd: GeoPoint,
  candidates: RestCandidate[],
  radiusMi: number = REST_SEARCH_RADIUS_MI,
): RestOption[] {
  const straight = haversineMi(point, legEnd);
  return candidates
    .map((c) => {
      const here = { lat: c.lat, lng: c.lng };
      const offRouteMi = haversineMi(point, here);
      const detourMi = Math.max(0, offRouteMi + haversineMi(here, legEnd) - straight);
      return { ...c, offRouteMi, detourMi };
    })
    .filter((o) => o.offRouteMi <= radiusMi)
    .sort((a, b) => a.detourMi - b.detourMi || a.offRouteMi - b.offRouteMi);
}
```

Export `rankRestOptions`, `REST_SEARCH_RADIUS_MI` and both types from `index.ts`.

- [ ] **Step 4: Run the tests**

Run: `cd fleet-backend && npx vitest run tests/engine-rest-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the test discriminates**

Remove the `Math.max(0, ...)` clamp; re-run the near-collinear case and name
the failing assertion. Then drop the `.filter(...)` and re-run the radius
case. Restore both.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/restOptions.ts fleet-backend/src/domain/dispatch/index.ts fleet-backend/tests/engine-rest-options.test.ts
git commit -m "feat(engine): rank reachable rest options by detour"
```

---

### Task 5: The `no_rest` conflict — and the silence that is not one

**Files:**
- Modify: `fleet-backend/src/domain/dispatch/types.ts` (`ConflictKind`)
- Create: `fleet-backend/src/domain/dispatch/restConflict.ts`
- Modify: `fleet-backend/src/domain/dispatch/index.ts`
- Test: `fleet-backend/tests/engine-rest-conflict.test.ts` (create)

**Interfaces:**
- Consumes: `BreakPoint` (Task 1), `RestOption` + `REST_SEARCH_RADIUS_MI` (Task 4).
- Produces: `RestCoverage`, `COVERAGE_RADIUS_MI`, `restConflict(bp, coverage): Conflict | null` — used by Task 7.

**This task is the slice's whole point. Read it twice.**

The spec asks for *"a plan with nowhere to stop is refused with a stated
reason."* The trap is that an empty result has two completely different
meanings:

| Situation | What we know | Verdict |
|---|---|---|
| Org has stops within 150 mi, none within 35 mi of the break | The corridor is covered and the break point is genuinely dry | **block** `no_rest` |
| Org has no stops within 150 mi at all | Nothing. We have no data here. | **no conflict** — silence |

Rendering the second as the first is Global Constraint 1 verbatim: absent
reported as measured. It would refuse a legal, ordinary plan because the
customer had not finished importing a POI file — the single most damaging
thing this feature could do.

- [ ] **Step 1: Write the failing test**

Create `fleet-backend/tests/engine-rest-conflict.test.ts`. Build a fixture
`bp: BreakPoint` at `{ lat: 38.6, lng: -92.1 }` with `precision: "estimated"`,
and an `opt: RestOption`. The cases:

```ts
it("blocks when the corridor is covered and nothing is reachable", () => {
  const c = restConflict(bp, { hasData: true, options: [] });
  expect(c?.severity).toBe("block");
  expect(c?.kind).toBe("no_rest");
  expect(c?.detail).toMatch(/no rest option within 35 mi/i);
});

it("is SILENT when the org has no rest data in the corridor", () => {
  // The defect this test exists to prevent: refusing a legal plan because a
  // customer has not imported a POI file. Absence is not unavailability.
  expect(restConflict(bp, { hasData: false, options: [] })).toBeNull();
});

it("is silent when options exist", () => {
  expect(restConflict(bp, { hasData: true, options: [opt] })).toBeNull();
});

it("states WHERE the break falls, not just that it does", () => {
  // The dispatcher needs the location to act on the refusal.
  expect(restConflict(bp, { hasData: true, options: [] })?.detail).toMatch(/38\.6/);
});

it("labels an estimated break point as approximate", () => {
  expect(restConflict(bp, { hasData: true, options: [] })?.detail).toContain("≈");
  const routed = restConflict({ ...bp, precision: "routed" }, { hasData: true, options: [] });
  expect(routed?.detail).not.toContain("≈");
});

it("cannot fire for a break with no position", () => {
  expect(restConflict({ ...bp, at: null }, { hasData: true, options: [] })).toBeNull();
});

it("quotes the same radius the ranker filtered on", () => {
  const c = restConflict(bp, { hasData: true, options: [] });
  expect(c?.detail).toContain(`${REST_SEARCH_RADIUS_MI} mi`);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd fleet-backend && npx vitest run tests/engine-rest-conflict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add `"no_rest"` to `ConflictKind` in `types.ts`. Create `restConflict.ts`:

```ts
// Turns "the driver must break here" into a dispatch conflict when there is
// demonstrably nowhere to do it — and, just as importantly, into SILENCE when
// we simply do not know.
//
// Global Constraint 1: absent must never render as measured. An org that has
// imported no rest stops has told us nothing about parking; refusing its plans
// would be inventing a fact.

import { REST_SEARCH_RADIUS_MI, type RestOption } from "./restOptions.js";
import type { BreakPoint, Conflict } from "./types.js";

/** How far around a break point we look before concluding the org has data
 *  about this corridor at all. Deliberately wider than the reachability
 *  radius: stops 100 mi up the interstate prove coverage without being
 *  usable for this break. */
export const COVERAGE_RADIUS_MI = 150;

export interface RestCoverage {
  /** true when the org has ANY rest stop within COVERAGE_RADIUS_MI of the
   *  break point — i.e. we are in a position to say anything at all */
  hasData: boolean;
  options: RestOption[];
}

export function restConflict(bp: BreakPoint, coverage: RestCoverage): Conflict | null {
  // No position -> nothing to say about it (Task 2 leaves `at` null when a
  // leg has no destination).
  if (!bp.at) return null;
  if (coverage.options.length > 0) return null;
  if (!coverage.hasData) return null; // silence, not a refusal

  const approx = bp.precision === "estimated" ? "≈" : "";
  const where = `${approx}${bp.at.lat.toFixed(2)}, ${approx}${bp.at.lng.toFixed(2)}`;
  return {
    kind: "no_rest",
    severity: "block",
    detail: `30-min break falls near ${where} with no rest option within ${REST_SEARCH_RADIUS_MI} mi`,
  };
}
```

Export `restConflict`, `RestCoverage` and `COVERAGE_RADIUS_MI` from `index.ts`.

- [ ] **Step 4: Run the tests**

Run: `cd fleet-backend && npx vitest run tests/engine-rest-conflict.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the test discriminates**

Delete the `if (!coverage.hasData) return null;` line. Re-run. The
"SILENT when the org has no rest data" test must fail — name it. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dispatch/restConflict.ts fleet-backend/src/domain/dispatch/types.ts fleet-backend/src/domain/dispatch/index.ts fleet-backend/tests/engine-rest-conflict.test.ts
git commit -m "feat(engine): no_rest conflict, silent when coverage is absent"
```

---

### Task 6: Rest-stop CRUD, import and demo seed

**Files:**
- Create: `fleet-backend/src/routes/dispatcherRestStops.ts`
- Modify: `fleet-backend/src/app.ts` (mount)
- Modify: `fleet-backend/seed-demo.mjs`
- Test: `fleet-backend/tests/dispatcher-rest-stops.test.ts` (create)

**Interfaces:**
- Consumes: the `RestStop` model (Task 3).
- Produces: `GET/POST /dispatcher/rest-stops`, `POST /dispatcher/rest-stops/import`, `DELETE /dispatcher/rest-stops/:id`.

- [ ] **Step 1: Write the failing tests**

Assert:
- org scoping — a second org's stop is invisible in `GET`, and `DELETE` of its id returns **404, never 403** (Global Constraint 4);
- Zod rejects `lat: 91` and `lng: -181` with 400;
- `spaces` omitted persists as `null`;
- CSV import round-trips a name containing a comma and a quote;
- the route sits behind the same dispatcher auth as `dispatcherTrips` — an unauthenticated call is 401.

This codebase has shipped six cross-tenant defects; mount order has been one
of the causes. Assert the auth behaviour through the real app, not the router
in isolation.

- [ ] **Step 2: Run to confirm failure**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-rest-stops.test.ts`

- [ ] **Step 3: Implement the route**

Follow `dispatcherCarriers.ts` exactly for auth, org scoping and the 404 shape.

```ts
const restStopSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["truck_stop", "rest_area", "yard", "customer"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  spaces: z.number().int().min(0).max(5000).nullable().optional(),
  amenities: z.array(z.string().max(40)).max(20).default([]),
});
```

Reuse `lib/csv.ts` for the import body.

- [ ] **Step 4: Seed demo rest stops**

In `seed-demo.mjs`, add rest stops along the seeded lanes with
`source: "demo"`. **Name them generically** — `"I-70 Rest Area — Columbia MO"`,
`"Truck Parking — Effingham IL"` — never a real brand. The product must be
demo-able without asserting the location of a facility we have not imported.

Place one lane's break point in a **deliberate coverage gap** so the `no_rest`
block is demonstrable, and name that lane in a comment so Task 10 can find it.

- [ ] **Step 5: Run**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-rest-stops.test.ts && node seed-demo.mjs`
Expected: PASS; seed completes.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/routes/dispatcherRestStops.ts fleet-backend/src/app.ts fleet-backend/seed-demo.mjs fleet-backend/tests/dispatcher-rest-stops.test.ts
git commit -m "feat(api): rest-stop CRUD, CSV import and demo seed"
```

---

### Task 7: Wire break planning into the assignment verdict

**Files:**
- Create: `fleet-backend/src/lib/restCoverage.ts`
- Modify: `fleet-backend/src/routes/dispatcherAssignments.ts` (preview, commit, `PATCH /plan`)
- Test: `fleet-backend/tests/dispatcher-break-plan.test.ts` (create)

**Interfaces:**
- Consumes: `plan.breaks` (Tasks 1–2), `rankRestOptions` (Task 4), `restConflict` (Task 5).
- Produces, on every verdict body:

```ts
interface BreakPlanEntry {
  atMs: number;
  at: { lat: number; lng: number } | null;
  precision: "routed" | "estimated";
  options: RestOption[];
  /** false = we have no coverage here; the UI says "unknown", not "none" */
  hasCoverage: boolean;
}
```

Consumed by Tasks 8 and 9.

- [ ] **Step 1: Write the failing tests**

Assert:
- a dry-run whose plan needs no break returns `breakPlan: []`;
- a plan needing one returns one entry with ranked options;
- an org with **no** rest stops returns the entry with `hasCoverage: false`, `options: []` and **`feasible` unchanged from before this task**;
- an org with coverage but a dry break point returns `feasible: false` with a `no_rest` conflict;
- `force: true` overrides `no_rest`. It is advisory-about-the-world, not physics like `overlap` — a dispatcher who knows a lot we have not imported must be able to proceed.

- [ ] **Step 2: Run to confirm failure**

Run: `cd fleet-backend && npx vitest run tests/dispatcher-break-plan.test.ts`

- [ ] **Step 3: Implement**

`restCoverage.ts` runs one bounding-box query per break point (at most two
per plan):

```ts
// One query per break point. `hasData` and `options` come from the SAME query
// — a wide box, partitioned in memory by distance — so the two can never
// disagree about what the org knows.
export async function coverageFor(
  orgId: string,
  bp: BreakPoint,
  legEnd: GeoPoint,
): Promise<RestCoverage>
```

Use a degree-box prefilter so the `(orgId, lat, lng)` index is used:
`COVERAGE_RADIUS_MI / 69` degrees of latitude, and
`COVERAGE_RADIUS_MI / (69 * Math.cos(toRad(lat)))` of longitude — **guard
`cos(lat) → 0`** near the poles with a divisor floor of `1e-6`, or the box
width becomes `Infinity` and the query scans the table. Then filter exactly by
haversine in memory: within `COVERAGE_RADIUS_MI` sets `hasData`, and
`rankRestOptions` produces `options`.

In `dispatcherAssignments.ts`, push `restConflict(...)` results into the
conflicts array alongside the existing checks, and attach `breakPlan` to all
three response paths (dry-run, 422, commit). The dry-run and the 422 share a
body shape — build `breakPlan` once and reference it in both.

- [ ] **Step 4: Run**

Run: `cd fleet-backend && npx vitest run --pool=forks`
Expected: all files PASS.

- [ ] **Step 5: Prove the test discriminates**

Make `coverageFor` return `hasData: true` unconditionally. The "org with no
rest stops leaves feasible unchanged" test must fail — name it. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/lib/restCoverage.ts fleet-backend/src/routes/dispatcherAssignments.ts fleet-backend/tests/dispatcher-break-plan.test.ts
git commit -m "feat(api): attach break plan and rest coverage to every verdict"
```

---

### Task 8: Break marker on the map

**Files:**
- Modify: `fleet-portal/src/lib/cockpit/mapData.ts`
- Modify: `fleet-portal/src/components/cockpit/views/FleetMap.vue`
- Modify: `fleet-portal/src/components/cockpit/MapPopup.vue`
- Test: `fleet-portal/src/lib/cockpit/mapData.spec.ts`, `views/FleetMap.spec.ts`, `MapPopup.spec.ts`

**Interfaces:**
- Consumes: `breakPlan` (Task 7).
- Produces: `breakMarkers(plans): BreakMarker[]`, a fifth marker kind.

R4 is binding here: the break marker and its rest options appear **only for a
plan that needs a break**. There is no rest-stop layer toggle, and rest stops
belonging to other plans are never drawn.

- [ ] **Step 1: Write the failing tests**

- `breakMarkers` returns `[]` for plans with no breaks;
- a break with `precision: "estimated"` renders its label with `≈`;
- a break with `hasCoverage: false` renders **"rest options unknown"**, never "no rest options" — the same absent/measured distinction as the backend, on the surface the user actually reads;
- a break with `hasCoverage: true, options: []` renders "no rest option within 35 mi";
- the popup lists options with `detourMi`, and shows `spaces` as "—" when null;
- a break whose `at` is null produces no marker (it cannot be placed).

- [ ] **Step 2: Run to confirm failure**

Run: `cd fleet-portal && npx vitest run src/lib/cockpit/mapData.spec.ts`

- [ ] **Step 3: Implement**

Follow the existing `stopMarkers`/`shopMarkers` shape in `mapData.ts`. Note
the marker bug this project has already hit twice: **`setLngLat()` before
`addTo()`**, never the reverse.

Use a distinct glyph. The existing set is round (truck), square (trailer),
diamond (shop), pin (stop) — use a **hexagon** for a break, so shape alone
still distinguishes every kind at a glance, colour-blind viewers included.
Add it to `BoardLegend.vue`.

- [ ] **Step 4: Run**

Run: `cd fleet-portal && npx vitest run && npx vue-tsc --noEmit`

- [ ] **Step 5: Prove the test discriminates**

Change the `hasCoverage: false` copy to "no rest options". Name the failing
assertion. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-portal/src/lib/cockpit/mapData.ts fleet-portal/src/components/cockpit/views/FleetMap.vue fleet-portal/src/components/cockpit/MapPopup.vue fleet-portal/src/components/cockpit/BoardLegend.vue fleet-portal/src/lib/cockpit/mapData.spec.ts fleet-portal/src/components/cockpit/views/FleetMap.spec.ts fleet-portal/src/components/cockpit/MapPopup.spec.ts
git commit -m "feat(map): break marker with rest options, only when the plan needs one"
```

---

### Task 9: Break row in the verdict modal and on the brick

**Files:**
- Modify: `fleet-portal/src/components/cockpit/PlanVerdictModal.vue`
- Modify: `fleet-portal/src/components/cockpit/LegBrick.vue`
- Modify: `fleet-portal/src/lib/api.ts` (types)
- Test: `PlanVerdictModal.spec.ts`, `LegBrick.spec.ts`

**Interfaces:**
- Consumes: `breakPlan` (Task 7).

- [ ] **Step 1: Write the failing tests**

- the modal renders a break row stating the time and place, with `≈` when estimated;
- a `no_rest` conflict renders with its detail **verbatim** — the modal never re-words a server reason (it is engine-authoritative, and a paraphrase drifts from the rule that produced it);
- `hasCoverage: false` renders "rest options unknown" with no warning styling;
- the brick shows a small break glyph when `needsBreak`, and its tooltip gives the break time;
- a brick with no break shows no glyph;
- a verdict body with `breakPlan` **absent entirely** renders as unknown and does not crash — an older server response must degrade, not explode.

- [ ] **Step 2: Run to confirm failure**

Run: `cd fleet-portal && npx vitest run src/components/cockpit/PlanVerdictModal.spec.ts`

- [ ] **Step 3: Implement**

Extend `PlanVerdictPlan` with `breaks?: BreakPoint[]` and `PlanVerdict` with
`breakPlan?: BreakPlanEntry[]`. Both optional, for the degradation case above.

- [ ] **Step 4: Run**

Run: `cd fleet-portal && npx vitest run && npx vue-tsc --noEmit && npm run build`

- [ ] **Step 5: Prove the test discriminates**

Make the modal reword the `no_rest` detail. Name the failing assertion.
Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-portal/src/components/cockpit/PlanVerdictModal.vue fleet-portal/src/components/cockpit/LegBrick.vue fleet-portal/src/lib/api.ts fleet-portal/src/components/cockpit/PlanVerdictModal.spec.ts fleet-portal/src/components/cockpit/LegBrick.spec.ts
git commit -m "feat(cockpit): break row in the verdict modal and brick glyph"
```

---

### Task 10: Live pass

**Files:** none (verification only; any fix commits against the task it belongs to).

T2's live pass caught a defect that 647 green tests described as working. Run
this one the same way, against a **deliberately restarted** backend — `tsx` is
not a watch process and has served stale code repeatedly in this project.

- [ ] **Step 1: Reseed and restart**

```bash
cd fleet-backend && node seed-demo.mjs
# kill the running tsx process, then:
npx tsx src/server.ts
```

- [ ] **Step 2: Verify each claim in the browser**

- Drag a long load onto a driver with banked hours → the verdict modal shows a break row with a time and a place.
- The place is marked `≈` (no `ROUTER_URL` in dev, so every break is estimated). **If it is not marked, that is a Global Constraint 7 failure — stop and fix it.**
- Open the map with that plan selected → exactly one hexagonal break marker, on the route, between the correct two stops.
- Click it → the popup lists rest options with detour miles; a null-capacity stop shows "—".
- Drag the load seeded into the deliberate coverage gap (Task 6) → `no_rest` block naming the location; Force overrides it.
- Delete every rest stop for the org, then repeat that drag → it now shows **"rest options unknown"** and commits cleanly. **This is the single most important check in the slice.**
- Zero console errors. Screenshot both themes to `docs/screenshots/`.

- [ ] **Step 3: Full suites**

```bash
cd fleet-backend && npx vitest run --pool=forks
cd ../fleet-portal && npx vitest run && npx vue-tsc --noEmit && npm run build
```

- [ ] **Step 4: Commit the screenshots**

```bash
git add docs/screenshots
git commit -m "docs: T3 live pass screenshots"
```

---

## Self-Review

**Spec coverage.** §4 T3 asks for three things. *"Where the HOS clock runs out
along a plan"* — Tasks 1–2. *"Nearest rest options at that point"* — Tasks 3–4
and 6. *"'No legal break available' becomes a dispatch conflict"* — Task 5,
wired in Task 7. The acceptance clause *"the engine says a plan needs a break at
a place"* is Task 1's `afterDriveMin` plus Task 2's `at`; *"a plan with nowhere
to stop is refused with a stated reason"* is Task 5's block detail.

**Precision (§7 risk).** Global Constraint 7 puts `precision` on the type in
Task 1, carries it into Task 5's detail string, renders it in Tasks 8–9, and
Task 10 makes an unmarked estimate a stop-the-line failure.

**R4 (POI discipline).** Task 8 draws rest options only for a plan that needs a
break. No layer toggle appears anywhere in this plan.

**R5 (ratings).** No rating or review field exists on `RestStop`. `amenities`
is a factual string list, not a score.

**Type consistency.** `BreakPoint` (Task 1) → `interpolate` fills `at` (Task 2)
→ `RestCandidate`/`RestOption`/`rankRestOptions` (Task 4) → `RestCoverage`/
`restConflict` (Task 5) → `coverageFor`/`BreakPlanEntry` (Task 7) →
`breakMarkers` (Task 8) → modal props (Task 9). `REST_SEARCH_RADIUS_MI` is
defined once in Task 4 and imported by Task 5's detail string, so the message
can never quote a radius the filter did not use — Task 5's last test pins that.

**Known interaction with existing code.** Task 1 moves the `cursor`
declaration above `driveLeg`. That is the only structural change to
`evaluate.ts`'s control flow, and Task 1 Step 4 requires the full 89-file suite
to stay green as the proof it changed nothing observable.

**The one thing to get right.** Task 5's `hasData` distinction. Every other
part of this slice is ordinary work; that one line is the difference between a
feature that refuses plans honestly and one that refuses them because a
customer had not finished importing a CSV.
