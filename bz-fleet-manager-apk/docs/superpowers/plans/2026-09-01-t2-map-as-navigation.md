# T2 — Map as Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the GPS view from a place you look into a place you work: every entity on the map says what it is, what it's doing, and hands you to the board.

**Architecture:** All map data keeps flowing through the single `lib/cockpit/mapData.ts` module that the schematic and the Mapbox view already share. New geometry (arcs, progress splits) goes in as **pure functions with their own tests**, so correctness is provable without a DOM. Popups and jump-to-board are wiring, not logic.

**Tech Stack:** Vue 3 `<script setup>` + TS strict, Pinia options-API, `mapbox-gl` 3.29 (lazy-loaded, only when `VITE_MAPBOX_TOKEN` is set), Vitest + jsdom. Backend: Node 22 ESM, Express 4, Prisma 5 + PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-09-01-dispatch-service-platform-design.md` — T2 in §4; §6 binds every task.

## Global Constraints

- **NO GIT COMMITS.** Standing user rule; the task report is the record.
- **`erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters` are ON in the portal** — an unused import is a hard build failure. No enums, no parameter properties, no namespaces.
- **Absent must never render as measured.** A trailer with no known position, a driver with no GPS, a stop with no appointment — all render as *unknown*, never as a confident dot or a zero. This invariant has been violated three times in this codebase and caught each time.
- **One definition per concept.** Geometry lives in `mapData.ts` / a new `mapGeometry.ts`; the schematic and the Mapbox view consume the same functions. Four separate bugs in this project have come from a concept defined twice.
- **A POI appears only when the plan implies a need for it** (spec R4). No "show all truck stops" toggle — that is a different product and a losing fight.
- **The `FakeMarker` guard in `FleetMap.spec.ts` stays.** It throws if `addTo()` precedes `setLngLat()`, because a lenient mock shipped exactly that bug to the browser once already.
- **Portal gate:** `npx vitest run` (jsdom, no DB — safe to run whole), `npx vue-tsc --noEmit -p tsconfig.app.json`, `npm run build`.
- **Backend gate:** the suite SIGSEGVs before the reporter flushes at any batch size — run in batches, count from per-file PASS lines, re-run whatever a crash truncates, **one vitest process at a time**. Reseed after: `node seed-control-tower.mjs && node seed-demo.mjs`.
- **`npx tsx src/server.ts` is NOT a watch process** — it serves stale code after backend edits. Restart deliberately before any live check.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/cockpit/mapGeometry.ts` | **new** — pure: arc interpolation, progress split, multi-stop paths |
| `src/lib/cockpit/mapData.ts` | modify — expose all stops (not just first/last); driver activity state |
| `src/components/cockpit/views/FleetMap.vue` | modify — arcs, progress, pin states, popups, layers, clustering |
| `src/components/cockpit/views/MapPopup.vue` | **new** — the popup body per entity |
| `src/stores/cockpit.ts` | modify — `focusOnBoard(loadId)` / `focusOnMap(loadId)` |
| `fleet-backend/src/lib/assignmentActions.ts` | modify — stamp trailer position on completion |
| `fleet-backend/src/routes/dispatcherLoadboard.ts` | modify — trailer `lastLat/lastLng/lastSeenAt` on the wire |

Ten tasks. Tasks 1–2 are pure geometry and carry the most risk-per-line; 6 is the only backend task.

---

### Task 1: Route geometry — arcs and every stop

**Why:** the map currently draws a `LineString` of exactly two points, first stop to last. On real tiles a Kansas City → Memphis chord cuts across country and reads as obviously fake, and a four-stop load lies about its own shape.

**Files:** Create `src/lib/cockpit/mapGeometry.ts` + spec; modify `src/lib/cockpit/mapData.ts`, `FleetMap.vue`.

**Interfaces:**
```ts
export function arcBetween(a: LngLat, b: LngLat, bendRatio?: number, steps?: number): LngLat[]
export function routePath(stops: LngLat[], bendRatio?: number, steps?: number): LngLat[]
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/cockpit/mapGeometry.spec.ts
import { describe, expect, it } from 'vitest'
import { arcBetween, routePath } from './mapGeometry'

const KC: [number, number] = [-94.58, 39.1]
const MEM: [number, number] = [-90.05, 35.15]

describe('arcBetween', () => {
  it('starts and ends exactly on its endpoints', () => {
    const p = arcBetween(KC, MEM)
    expect(p[0]).toEqual(KC)
    expect(p[p.length - 1]).toEqual(MEM)
  })

  it('bows away from the straight chord — that is the whole point', () => {
    const p = arcBetween(KC, MEM)
    const mid = p[Math.floor(p.length / 2)]
    // The chord's midpoint, for comparison.
    const chordMid = [(KC[0] + MEM[0]) / 2, (KC[1] + MEM[1]) / 2]
    const off = Math.hypot(mid[0] - chordMid[0], mid[1] - chordMid[1])
    expect(off).toBeGreaterThan(0.05)
  })

  it('bends consistently, not randomly — same input, same output', () => {
    expect(arcBetween(KC, MEM)).toEqual(arcBetween(KC, MEM))
  })

  it('degenerates safely when both endpoints are the same point', () => {
    // A load whose pickup and delivery geocode identically must not produce
    // NaN coordinates — mapbox-gl throws on those and the map dies.
    const p = arcBetween(KC, KC)
    for (const [lng, lat] of p) {
      expect(Number.isFinite(lng)).toBe(true)
      expect(Number.isFinite(lat)).toBe(true)
    }
  })
})

describe('routePath', () => {
  it('passes THROUGH every intermediate stop, not just the ends', () => {
    const STL: [number, number] = [-90.2, 38.63]
    const path = routePath([KC, STL, MEM])
    const hits = path.filter((p) => Math.hypot(p[0] - STL[0], p[1] - STL[1]) < 0.001)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('returns an empty path for fewer than two stops rather than a half-drawn line', () => {
    expect(routePath([KC])).toEqual([])
    expect(routePath([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run and watch it fail** — module does not exist.

- [ ] **Step 3: Implement.** A quadratic Bézier whose control point is the chord midpoint pushed perpendicular by `bendRatio × chord length` — the same shape the schematic radar already draws, so the two views agree. Guard the zero-length chord before normalising the perpendicular, or it divides by zero.

- [ ] **Step 4: Verify** — `npx vitest run src/lib/cockpit/mapGeometry.spec.ts && npx vue-tsc --noEmit -p tsconfig.app.json`

- [ ] **Step 5: Wire it.** `mapData.ts` exposes every geocoded stop (it currently keeps only `a` and `b`); `FleetMap.vue` feeds `routePath(...)` into the `LineString`. Existing route tests must still pass — if one asserts a two-point geometry, that test was describing the bug and needs updating with a comment saying so.

> **Road geometry is deliberately NOT in this task.** `ROUTER_URL` (OSRM-compatible) is optional and `RouteDistance` caches **miles only, no polyline**, so real road shapes need both a configured router and a schema change. The arc is the honest approximation until then — and it must be *labelled* as an approximation in the popup, never implied to be a driven route.

---

### Task 2: Progress split — how far along is this load?

**Why:** the single most common question a dispatcher asks a map. All the data already exists.

**Files:** `mapGeometry.ts` + spec, `FleetMap.vue`.

**Interfaces:**
```ts
export function splitAtProgress(path: LngLat[], t: number): { done: LngLat[]; remaining: LngLat[] }
```

- [ ] **Step 1: Test** — `t=0` gives an empty `done` and the whole path remaining; `t=1` the reverse; `t=0.5` splits with **both halves sharing the split point** (a gap between them renders as a visible break in the line); an out-of-range `t` clamps rather than throwing; a path of fewer than 2 points returns empty/empty.
- [ ] **Step 2–4:** implement, verify.
- [ ] **Step 5:** render as two line layers — completed dimmed, remaining full-strength. Use the elapsed share already computed by `lifecycle.ts`'s `progressShare` for `in_progress` legs; **an assigned-but-not-started leg has `t = 0` and must show no completed portion at all** rather than a sliver.

---

### Task 3: Pin differentiation — rolling, parked, no GPS

**Files:** `mapData.ts` (a `driverActivity` helper + spec), `FleetMap.vue`.

Three states, visually distinct at a glance:

| State | Meaning | Treatment |
|---|---|---|
| **Rolling** | on an `in_progress` leg | solid, status-coloured |
| **Parked** | no active leg, position known | hollow / outlined |
| **No GPS** | no ping and no `lastLat` | **not placed on the map at all** — listed separately as "position unknown" |

**The third is the one that matters.** A driver with no position must never be drawn at a guessed or default location; that is this product's core invariant, and a truck pinned at the wrong place is worse than a truck absent from the map.

- [ ] Test each state, and specifically that a no-GPS driver produces **no marker** and appears in the unknown list.
- [ ] Prove it discriminates: place no-GPS drivers at a fallback coordinate, confirm the test fails.

---

### Task 4: Popups that answer the question, and "Show on board"

**Files:** `MapPopup.vue` + spec, `FleetMap.vue`, `stores/cockpit.ts`.

Clicking any entity opens a popup whose content depends on what it is:

| Entity | Must show |
|---|---|
| Rolling truck | load ref, origin → destination, **next stop + ETA**, late-by if late, driver, carrier, margin |
| Parked driver | idle since, **hours available** (drive/cycle remaining), current city, paired equipment |
| Stop pin | pickup or delivery, address, **appointment window**, and whether it is at risk |
| Trailer | unit, type, **how long it has been sitting** |

Every popup ends with **"Show on board"**, which sets `selectedLoadId`, switches `view` to `'board'`, and scrolls that brick into view.

- [ ] Test: each popup renders its required fields; a null margin renders `—`, never `$0`; "Show on board" switches the view and selects the right load.
- [ ] **Test the absent cases explicitly** — a leg with no ETA, a driver with unknown HOS. They must read as unknown.

---

### Task 5: Board → map, the reverse jump

**Files:** `stores/cockpit.ts`, `BrickPopover.vue` / `MasterDrawer.vue`.

A brick on the Gantt gains "Show on map": switches `view` to `'radar'`, selects that load, and centres the map on it.

- [ ] Test the round trip: board → map → board returns to the same load with the board scrolled to it.

---

### Task 6: Trailer positions (backend — runs alone)

**Why:** `Trailer.lastLat`/`lastLng` have existed since before this project and **nothing has ever written them**. "Where is FB-3310?" is a question small fleets genuinely cannot answer, and a dropped trailer sitting three weeks somewhere is real money.

**Files:** `fleet-backend/src/lib/assignmentActions.ts`, `dispatcherLoadboard.ts`, tests.

- [ ] When an assignment completes, stamp the trailer's `lastLat`/`lastLng` from the final stop's coordinates, plus a `lastSeenAt` timestamp (**new nullable column — its own migration**).
- [ ] Expose all three on the wire.
- [ ] Test: completing a leg positions its trailer at the delivery stop; a trailer never hauled keeps `null` everywhere; the timestamp is set.

> **This task runs alone** — it carries a migration, and every other agent's gate tests against that database.

---

### Task 7: Trailers on the map, with their age

**Files:** `FleetMap.vue`, `mapData.ts`.

- [ ] Trailer pins, visually distinct from trucks.
- [ ] **Every trailer pin states its age** — "last seen 3 days ago". A trailer position with no timestamp is not rendered at all.
- [ ] Test: a stale trailer shows its age; a trailer with a position but no timestamp is **absent**, not shown as current.

> A stale trailer position rendered as a confident dot is the exact "absent shown as measured" failure this codebase has fixed three times.

---

### Task 8: Service shops on the map

**Files:** `FleetMap.vue`, `stores/fleet.ts`.

`ServiceShop` already carries `lat`/`lng`/`phone` — this is the customer's **own** data, not third-party POI, so it is free and differentiated.

- [ ] Shop pins with name and phone in the popup.
- [ ] **Need-driven surfacing (spec R4):** where a unit has an overdue or near-due service clock, indicate the nearest shop. Not a "show all shops" toggle.
- [ ] Test both the pin and the need link.

---

### Task 9: Clustering

**Files:** `FleetMap.vue`.

- [ ] Cluster markers when zoomed out — five pins is fine, fifty is a blob, and a dispatch service is fifty.
- [ ] Test that clustering is configured; assert the source options rather than trying to render tiles in jsdom.

---

### Task 10: Live pass

Not a code task — the verification tests cannot do.

- [ ] `node seed-control-tower.mjs && node seed-demo.mjs`, **restart the backend deliberately** (`tsx` does not watch).
- [ ] On `/cockpit` → GPS Radar: routes curve and pass through intermediate stops; a rolling leg shows its completed portion dimmed; parked drivers are hollow; a no-GPS driver is absent from the map and listed as unknown.
- [ ] Click a truck → popup shows next stop and ETA → "Show on board" lands on that brick.
- [ ] A brick → "Show on map" → returns.
- [ ] Zero console errors. Screenshot both themes.

---

## Final gate

```bash
# portal
npx vitest run && npx vue-tsc --noEmit -p tsconfig.app.json && npm run build
# backend (batched; Task 6 only)
npx vitest run <batches>   &&  npx tsc --noEmit
node seed-control-tower.mjs && node seed-demo.mjs && node smoke-control-tower.mjs   # 26/26
```

## Acceptance (spec §4, T2)

Click a truck → "Show on board" scrolls to and selects its brick; a brick → "Show on map"; a trailer pin states its age and never a bare dot; a driver with no GPS is absent rather than guessed.
