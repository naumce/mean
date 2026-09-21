# T1 — Carrier Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `Carrier` — the client whose trucks a dispatch service dispatches — so that cost, and therefore every margin on the board, belongs to somebody.

**Architecture:** `Carrier` sits between `Org` and `Driver`/`Tractor`/`Trailer`, all links **nullable**. The cost model moves from `Org` to `Carrier` with the org's values as the fallback, resolved by exactly one function. Nothing changes behaviourally until a carrier is created — which is what lets the existing 536-test backend suite pass untouched.

**Tech Stack:** Node 22, TypeScript ESM (`.js` specifiers), Express 4, Prisma 5 + PostgreSQL, Zod, Vitest + Supertest. Portal: Vue 3 `<script setup>`, Pinia options-API, Tailwind tokens, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-01-dispatch-service-platform-design.md` — §5 is this slice; §6 binds every task.

## Global Constraints

- **NO GIT COMMITS.** Standing user rule. Work stays in the working tree; the task report is the record.
- **ESM:** every relative import ends in `.js`. Missing extensions fail at runtime, not at `tsc`.
- **`erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters` are ON in the portal** — an unused import is a hard build failure, and there are **no enums, no parameter properties, no namespaces**.
- **Absent must never render as measured.** A carrier with no cost model inherits the org's; it never silently prices at zero.
- **One definition per concept.** `resolveRateConfig` is the only place carrier-vs-org fallback is decided. This codebase has been bitten four separate times by a concept defined twice — do not add a fifth.
- **`Rate` rows are snapshots.** Editing a carrier's cost model must never retro-change committed economics.
- **404, never 403**, for a cross-tenant id.
- **Backend gate:** the suite SIGSEGVs before the reporter flushes at any batch size, but each file prints its own PASS line first — run in batches, count from those lines, re-run whatever a crash truncates. Never a bare `npx vitest run`. **One vitest process at a time** (tests and the dev app share one Postgres). Reseed after: `node seed-control-tower.mjs && node seed-demo.mjs`.
- **Portal gate:** `npx vitest run` (jsdom, no DB — safe to run whole), `npx vue-tsc --noEmit -p tsconfig.app.json`, `npm run build`.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` + migration | `Carrier`; nullable `carrierId` on Driver/Tractor/Trailer |
| `src/lib/rateConfig.ts` | modify — `resolveRateConfig(org, carrier)`, the single fallback rule |
| `src/routes/dispatcherCarriers.ts` | **new** — carrier CRUD, org-scoped |
| `src/routes/dispatcherAssignments.ts` | modify — price from the driver's carrier |
| `src/routes/dispatcherSuggest.ts`, `dispatcherSettlements.ts` | modify — same resolution |
| `src/routes/dispatcherLoadboard.ts` | modify — `carrierId`/`carrierName` per lane, `?carrierId=` filter |
| `fleet-portal/src/stores/carriers.ts` | **new** — carrier list + selected filter |
| `fleet-portal/src/stores/cockpit.ts` | modify — `groupBy: 'carrier'` |
| `fleet-portal/src/components/cockpit/*` | modify — group header, filter control, lane-head carrier name |
| `seed-demo.mjs` | modify — two carriers with **different** cost models |

Ten tasks. Tasks 1–3 are load-bearing; the rest build on them.

---

### Task 1: The Carrier model and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<prisma-generated>/migration.sql`
- Test: `tests/carrier-schema.test.ts`

**Interfaces:**
- Produces: `Carrier` with nullable cost-model columns; `Driver.carrierId`, `Tractor.carrierId`, `Trailer.carrierId`, all nullable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/carrier-schema.test.ts
import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

describe("Carrier schema", () => {
  it("exists with a NULLABLE cost model — null means inherit the org", async () => {
    const cols: Array<{ column_name: string; is_nullable: string }> = await prisma.$queryRawUnsafe(
      `select column_name, is_nullable from information_schema.columns
         where table_name = 'Carrier'
           and column_name in ('mpg','dieselCentsPerGal','driverPayCentsPerMi','fixedCentsPerMi')`,
    );
    expect(cols).toHaveLength(4);
    // Every one nullable: a carrier that has not set a rate must fall back to
    // the org, never price at zero.
    for (const c of cols) expect(c.is_nullable).toBe("YES");
  });

  it("links drivers, tractors and trailers by a NULLABLE carrierId", async () => {
    for (const table of ["Driver", "Tractor", "Trailer"]) {
      const cols: Array<{ is_nullable: string }> = await prisma.$queryRawUnsafe(
        `select is_nullable from information_schema.columns
           where table_name = '${table}' and column_name = 'carrierId'`,
      );
      expect(cols, `${table}.carrierId missing`).toHaveLength(1);
      // Nullable is what lets every existing row keep working untouched.
      expect(cols[0].is_nullable, `${table}.carrierId must be nullable`).toBe("YES");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/carrier-schema.test.ts`
Expected: FAIL — zero rows; the table does not exist.

- [ ] **Step 3: Implement**

Add the `Carrier` model exactly as written in spec §5.1, then on `Driver`, `Tractor` and `Trailer`:

```prisma
  carrierId String?
  carrier   Carrier? @relation(fields: [carrierId], references: [id])
```

Then `npx prisma migrate dev --name carrier_layer` and `npx prisma generate`.

> **Run `npx prisma migrate status` FIRST and report it.** If it shows drift, **STOP and report** — never `migrate reset` or `db push`; a reset destroys the demo data the smoke tests depend on. **Keep whatever directory name Prisma generates** and never hand-edit an applied migration (Prisma checksums them).
>
> On Windows, `prisma generate` can fail with `EPERM` because the dev server holds the query-engine DLL. Stop the server on :3001, generate, and say so in your report.

- [ ] **Step 4: Verify**

Run: `npx prisma migrate status && npx vitest run tests/carrier-schema.test.ts && npx tsc --noEmit`

---

### Task 2: `resolveRateConfig` — the single fallback rule

**This is the task the whole slice rests on.** Get it wrong and every margin on the board is wrong in a way no test currently checks.

**Files:**
- Modify: `src/lib/rateConfig.ts`
- Test: `tests/resolve-rate-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateSource { mpg: number | null; dieselCentsPerGal: number | null; driverPayCentsPerMi: number | null; fixedCentsPerMi: number | null }
  export function resolveRateConfig(org: RateConfig | null, carrier: RateSource | null): RateConfig
  export async function rateConfigForDriver(driverId: string): Promise<RateConfig>
  ```
- `orgRateConfig` stays for callers with no driver context (settlements over a whole org).

- [ ] **Step 1: Write the failing test**

```ts
// tests/resolve-rate-config.test.ts
import { describe, expect, it } from "vitest";
import { resolveRateConfig } from "../src/lib/rateConfig.js";
import { DEFAULT_RATE_CONFIG } from "../src/domain/dispatch/economics.js";

const ORG = { mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45 };
const NONE = { mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null };

describe("resolveRateConfig", () => {
  it("uses the org when there is no carrier", () => {
    expect(resolveRateConfig(ORG, null)).toEqual(ORG);
  });

  it("uses the carrier's values where set", () => {
    expect(resolveRateConfig(ORG, { ...NONE, driverPayCentsPerMi: 72, mpg: 5.8 })).toEqual({
      mpg: 5.8, dieselCentsPerGal: 400, driverPayCentsPerMi: 72, fixedCentsPerMi: 45,
    });
  });

  it("falls back FIELD BY FIELD, not all-or-nothing", () => {
    // The bug this test exists to catch: treating a carrier with any value set
    // as fully overriding, so its null fields price at zero.
    const r = resolveRateConfig(ORG, { ...NONE, driverPayCentsPerMi: 72 });
    expect(r.mpg).toBe(6.5);
    expect(r.dieselCentsPerGal).toBe(400);
    expect(r.fixedCentsPerMi).toBe(45);
  });

  it("never yields a zero or NaN for an unset field", () => {
    const r = resolveRateConfig(ORG, NONE);
    for (const v of Object.values(r)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("falls back to planning defaults when there is no org either", () => {
    expect(resolveRateConfig(null, NONE)).toEqual(DEFAULT_RATE_CONFIG);
    expect(resolveRateConfig(null, null)).toEqual(DEFAULT_RATE_CONFIG);
  });

  it("treats 0 as a deliberate value, not as absent", () => {
    // A carrier that genuinely pays no per-mile fixed cost must get 0, not the
    // org's 45. `??` is correct here and `||` is not — this test is the guard.
    expect(resolveRateConfig(ORG, { ...NONE, fixedCentsPerMi: 0 }).fixedCentsPerMi).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — the export does not exist.

- [ ] **Step 3: Implement**

```ts
/** The ONE place carrier-vs-org cost resolution is decided.
 *
 *  Field by field, `??` not `||`: a carrier that genuinely charges 0 for a
 *  component means 0, and `||` would silently substitute the org's value.
 *  All-or-nothing override was the other tempting shape and is wrong — a
 *  carrier that has set only its driver pay must still inherit fuel and
 *  overhead, not price them at zero. */
export function resolveRateConfig(org: RateConfig | null, carrier: RateSource | null): RateConfig {
  const base = org ?? DEFAULT_RATE_CONFIG;
  if (!carrier) return base;
  return {
    mpg: carrier.mpg ?? base.mpg,
    dieselCentsPerGal: carrier.dieselCentsPerGal ?? base.dieselCentsPerGal,
    driverPayCentsPerMi: carrier.driverPayCentsPerMi ?? base.driverPayCentsPerMi,
    fixedCentsPerMi: carrier.fixedCentsPerMi ?? base.fixedCentsPerMi,
  };
}
```

Then `rateConfigForDriver(driverId)`: one query loading the driver with `org` and `carrier` selected, delegating to `resolveRateConfig`.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/resolve-rate-config.test.ts tests/dispatch-economics.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Prove it discriminates**

Change `??` to `||` in one field, confirm the "treats 0 as deliberate" test fails, restore. Report the assertion that fired. Then make the fallback all-or-nothing, confirm the field-by-field test fails, restore.

---

### Task 3: Price from the driver's carrier

**Files:**
- Modify: `src/routes/dispatcherAssignments.ts` (commit ~line 237, replan ~line 754), `src/routes/dispatcherSuggest.ts:51`
- Test: `tests/carrier-pricing.test.ts`

**Interfaces:** consumes `rateConfigForDriver` (Task 2).

- [ ] **Step 1: Write the failing test**

```ts
// tests/carrier-pricing.test.ts
//
// THE POINT OF THE WHOLE SLICE. Two carriers, one org, identical load:
//
//  1. Carrier A pays 60c/mi, Carrier B pays 90c/mi. Commit the SAME load
//     spec to a driver of each. Assert the two `marginCents` differ, and
//     assert B's is LOWER by the amount the pay delta implies over the
//     plan's loaded miles — an exact number, not "different".
//  2. A driver with NO carrier still prices at the org's model (unchanged
//     behaviour — this is what keeps the existing suite green).
//  3. Editing a carrier's cost model AFTER a commit does not change that
//     commit's stored Rate row (snapshots stay snapshots).
//  4. The same applies on PATCH /plan, not just on commit — replanning onto
//     a driver of a different carrier re-prices at the NEW carrier's model.
//
// Reuse the commit fixture from tests/dispatcher-assignments.test.ts.
```

- [ ] **Step 2: Run and watch it fail** — both carriers price identically today.

- [ ] **Step 3: Implement** — replace the three `orgRateConfig(...)` call sites that have a driver in hand with `rateConfigForDriver(body.driverId ?? assignment.driverId)`. Leave `dispatcherSettlements.ts` on `orgRateConfig` (it rolls up a whole org and has no single driver) — **and say so in your report** so the asymmetry is deliberate rather than an oversight.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/carrier-pricing.test.ts tests/dispatcher-assignments.test.ts tests/assignment-plan.test.ts tests/dispatcher-suggest.test.ts tests/dispatcher-economics.test.ts && npx tsc --noEmit`

---

### Task 4: Carrier CRUD

**Files:** Create `src/routes/dispatcherCarriers.ts`; modify `src/app.ts`; test `tests/dispatcher-carriers.test.ts`

`GET /carriers`, `POST /carriers`, `PATCH /carriers/:id`. Org-scoped through the single structural `attachOrgScope` mount; cross-tenant id → **404**. Zod-validate; a cost-model field may be `null` (explicit inherit) or a positive number — **reject a negative or zero `mpg`**, which would produce Infinity in the economics.

- [ ] Test: list is org-filtered; cross-org `PATCH` → 404 **and the row is unchanged when re-read**; `mpg: 0` → 400; `null` cost fields persist as null and resolve to the org's values.
- [ ] Implement; verify; prove the cross-org guard discriminates by reverting it.

---

### Task 5: Loadboard exposes and filters by carrier

**Files:** modify `src/routes/dispatcherLoadboard.ts`; test `tests/loadboard-carrier.test.ts`

- [ ] Each lane gains `carrierId: string | null` and `carrierName: string | null`. **Null is a real state** (a driver with no carrier) and must not render as an empty-string carrier.
- [ ] `?carrierId=` filters lanes. An unknown or cross-org `carrierId` returns an **empty list, not everything** — a filter that silently fails open would show a dispatcher another carrier's trucks.
- [ ] Test both, including the fail-open case explicitly.

---

### Task 6: Portal carrier store

**Files:** create `fleet-portal/src/stores/carriers.ts` + spec; modify `src/lib/api.ts`

- [ ] `useCarriersStore`: `list`, `byId`, `selectedCarrierId`, `load()`. Options-API, matching the existing stores.
- [ ] Test: loads and indexes; selecting a carrier is reflected; a failed load leaves the list empty rather than throwing into the view.

---

### Task 7: Group the board by carrier

**Files:** modify `fleet-portal/src/stores/cockpit.ts`, the board's group control and `GanttBoard.vue`; extend specs

- [ ] `groupBy` gains `'carrier'`. Lanes group under a carrier header; drivers with no carrier group under a clearly-labelled **"No carrier"** section — never silently hidden.
- [ ] Test: with two carriers, lanes appear under the right headers and the unassigned group is present and labelled.

---

### Task 8: Carrier filter and lane-head name

**Files:** modify `CockpitToolbar.vue`, `LaneHeadDriver.vue`; extend specs

- [ ] A carrier `<select>` beside the equipment filter, wired to `selectedCarrierId` and the loadboard's `?carrierId=`.
- [ ] Lane head shows the carrier name **only when the org has more than one carrier** — a single-carrier org gains no clutter.
- [ ] Test both, including the single-carrier no-clutter case.

---

### Task 9: Carrier on the map

**Files:** modify `fleet-portal/src/components/cockpit/views/FleetMap.vue`, `src/lib/cockpit/mapData.ts`; extend specs

- [ ] When grouping by carrier, truck markers carry a stable per-carrier colour (hash the id — do not depend on list order, which changes).
- [ ] The popup names the carrier.
- [ ] **The marker mock must keep enforcing `setLngLat` before `addTo`** — that guard exists because a lenient mock shipped a broken map once already.

---

### Task 10: Seed two carriers with different cost models

**Files:** modify `seed-demo.mjs`

- [ ] Split the demo fleet across **two carriers with genuinely different pay rates** (e.g. 60c/mi vs 78c/mi) so the board visibly shows different margins for similar work — that contrast *is* the demo of this slice.
- [ ] Leave at least one driver with **no carrier**, so the inherit path is visible too.
- [ ] Verify: reseed, then `node smoke-control-tower.mjs` → 26/26, and confirm on `/cockpit` that grouping by carrier renders both groups plus "No carrier".

---

## Final gate

```bash
# backend, batched — count from per-file PASS lines
npx vitest run <batches of ~8 files>
npx tsc --noEmit
node seed-control-tower.mjs && node seed-demo.mjs && node smoke-control-tower.mjs   # expect 26/26

# portal
npx vitest run && npx vue-tsc --noEmit -p tsconfig.app.json && npm run build
```

## Acceptance (spec §4, T1)

Two carriers with different pay rates produce **different, exactly-predictable** margins for the same load; the board groups by carrier; a driver with no carrier still prices at the org's model; and every pre-existing test passes untouched.
