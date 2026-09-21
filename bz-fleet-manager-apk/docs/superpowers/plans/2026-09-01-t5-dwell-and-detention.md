# T5 — Dwell & Detention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ping history we already collect into a defensible detention claim — how long a truck actually sat at a stop, how much of that is billable, and the evidence a broker will demand.

**Architecture:** `DriverLocation` already stores every ping indexed by `(driverId, createdAt)`. A pure function turns pings plus a stop's coordinates into in-geofence segments; a second turns a segment plus its appointment into a billable claim carrying its own evidence and confidence. Nothing is persisted: claims are computed on read, so they can never go stale against the pings that justify them. Filing and invoicing are a later slice.

**Tech Stack:** TypeScript ESM (`.js` specifiers), Prisma 5 + PostgreSQL, Express 4, Zod, Vitest + Supertest; Vue 3 `<script setup>`, Pinia, Tailwind v3, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-01-dispatch-service-platform-design.md` (§4 T5, §6 invariants)

## Global Constraints

1. **Absent must never render as measured.** No pings, an unreliable geocode, or no appointment each render as unknown — never as a zero-minute dwell or a zero-dollar claim.
2. **One definition per concept.** `LoadStop.dwellMin` is the **planned** dwell the dispatch engine consumes. Observed dwell is a different fact that happens to share a word. Never write observed dwell into `dwellMin`, and never read `dwellMin` as if it were measured.
3. **Engine-authoritative.** The server computes dwell and claims; the client renders.
4. **404, never 403,** for cross-tenant ids.
5. **A claim understates rather than overstates.** Every inference runs in the direction that produces a *smaller* billable figure. We bill a broker from this number; a claim that is provably conservative survives a dispute, and one that is optimistic destroys the carrier's credibility on every other claim they file.
6. **Every claim carries its own evidence and its own confidence.** Ping count, the largest gap between pings, and the window they span. A claim a dispatcher cannot defend line-by-line is worse than no claim.

---

### Task 1: Dwell segments from ping history

**Files:**
- Create: `fleet-backend/src/domain/dwell/segments.ts`
- Test: `fleet-backend/tests/dwell-segments.test.ts` (create)

**Interfaces:**

```ts
export interface Ping { atMs: number; lat: number; lng: number }

export interface DwellSegment {
  /** first ping observed inside the fence. The truck may have arrived
   *  EARLIER — this is an upper bound on arrival, so dwell is a lower
   *  bound on reality (Global Constraint 5). */
  firstSeenMs: number;
  /** last ping observed inside the fence before it left (or the last ping
   *  we have, if it never left) */
  lastSeenMs: number;
  /** lastSeen - firstSeen. Time we can actually evidence. */
  observedMin: number;
  pingCount: number;
  /** largest interval between consecutive in-fence pings. A big number
   *  means a hole in the evidence, not necessarily a hole in the dwell. */
  maxGapMin: number;
  /** true when a later ping falls OUTSIDE the fence — i.e. we watched it
   *  leave. False means the segment is still open or the trail just ends. */
  departureObserved: boolean;
}

export const DWELL_RADIUS_MI = 0.5;

export function dwellSegments(
  pings: Ping[],
  center: { lat: number; lng: number },
  radiusMi?: number,
): DwellSegment[];
```

Used by Tasks 2 and 4.

- [ ] **Step 1: Write the failing test**

Cover:
- pings entirely inside the fence → one segment, `observedMin` = span, `departureObserved: false`;
- in, in, **out** → one segment ending at the last in-fence ping, `departureObserved: true`;
- in, out, in → **two** segments, not one. The truck left and came back; merging them would invent continuous presence;
- a single in-fence ping → a segment with `observedMin: 0`, `pingCount: 1`. **Not** dropped — one ping is evidence of presence, just not of duration;
- no pings at all → `[]`;
- no pings inside the fence → `[]`;
- `maxGapMin` is the largest consecutive interval, not the average;
- pings arriving out of order are sorted before processing (never trust caller ordering);
- a ping exactly on the radius boundary is treated as **inside** (`<=`), and the test asserts which, so the boundary is pinned rather than incidental.

- [ ] **Step 2: Run it to confirm failure**

Run: `cd fleet-backend && npx vitest run tests/dwell-segments.test.ts`

- [ ] **Step 3: Implement.** Use `haversineMi` from `src/domain/dispatch/distance.js` — do not write a second distance function.

- [ ] **Step 4: Run** the file, then the full suite.

- [ ] **Step 5: Prove discrimination** — merge the in/out/in case into one segment; that test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dwell/segments.ts fleet-backend/tests/dwell-segments.test.ts
git commit -m "feat(dwell): in-geofence segments from ping history"
```

---

### Task 2: The detention claim

**Files:**
- Create: `fleet-backend/src/domain/dwell/detention.ts`
- Test: `fleet-backend/tests/dwell-detention.test.ts` (create)

**Interfaces:**

```ts
export interface DetentionInput {
  segment: DwellSegment;
  /** appointment window open, epoch ms; null when the stop has no appointment */
  windowStartMs: number | null;
  /** free minutes before detention accrues */
  freeMin: number;
  /** whether the stop's coordinates are trustworthy (geocodeStatus === "ok") */
  geocodeOk: boolean;
}

export interface DetentionClaim {
  /** when the detention clock starts: arrival or window open, whichever is
   *  LATER — a truck is not detained for arriving early */
  clockStartMs: number;
  freeMin: number;
  /** minutes beyond free time that we can evidence. Never negative. */
  billableMin: number;
  /** evidence, carried with the claim (Global Constraint 6) */
  evidence: {
    pingCount: number;
    maxGapMin: number;
    firstSeenMs: number;
    lastSeenMs: number;
    departureObserved: boolean;
  };
  /** true when a human should look before this is billed */
  needsReview: boolean;
  /** why it needs review, in words a dispatcher can act on; empty when not */
  reviewReasons: string[];
}

export const DEFAULT_FREE_MIN = 120;
/** a gap this large between pings makes the claim contestable */
export const GAP_REVIEW_MIN = 30;

/** null when no claim can honestly be made at all */
export function detentionClaim(input: DetentionInput): DetentionClaim | null;
```

Used by Task 4.

**This task decides what we are willing to invoice. Read it twice.**

Four situations produce **no claim at all** — `null`, not a zero-minute claim:

| Situation | Why |
|---|---|
| `geocodeOk: false` | The fence is drawn around a city centroid, not a dock. Presence inside it is not evidence of being at the stop. |
| `windowStartMs: null` | No appointment means no agreed schedule to be detained against. There is nothing to be late relative to. |
| `segment.pingCount < 2` | One ping proves presence, not duration. A claim needs a span. |
| `billableMin <= 0` | Inside free time. Not a zero-dollar claim — no claim. |

And these mark `needsReview` with a stated reason rather than suppressing the claim:
- `maxGapMin > GAP_REVIEW_MIN` — "evidence has a Nm gap";
- `departureObserved: false` — "departure never observed; dwell may be longer or the trail may simply end".

- [ ] **Step 1: Write the failing test**

Cover every row of the table above (asserting `null`, not a zero claim); `clockStartMs` is the
later of arrival and window open; a truck arriving 3h early and sitting 1h past its window start
bills only the time after free time from the **window**, not from arrival; `billableMin` is never
negative; both `needsReview` reasons fire with readable text; a clean claim has
`needsReview: false` and `reviewReasons: []`.

- [ ] **Step 2: Run it to confirm failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** the file, then the full suite.

- [ ] **Step 5: Prove discrimination** — return a zero-minute claim instead of `null` when
`geocodeOk` is false. That test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/domain/dwell/detention.ts fleet-backend/tests/dwell-detention.test.ts
git commit -m "feat(dwell): detention claims that refuse to be made without evidence"
```

---

### Task 3: Per-stop free time

**Files:**
- Modify: `fleet-backend/prisma/schema.prisma`
- Create: migration (generated)
- Test: `fleet-backend/tests/detention-free-min-model.test.ts` (create)

Add to `LoadStop`:

```prisma
  /// Free minutes before detention accrues at THIS stop, when the broker
  /// agreed something other than the default. NULL = inherit the org's
  /// value — never 0, which would mean "detention starts on arrival".
  detentionFreeMin Int?
```

and to `Org`:

```prisma
  /// Org-wide default free time. 120 min is the common contractual figure.
  detentionFreeMin Int @default(120)
```

**Note the asymmetry and keep it:** the stop's column is nullable (null = inherit) and the org's
is not (every org has a default). This mirrors `resolveRateConfig`'s carrier/org shape exactly —
one more concept resolved the same way, not a new pattern.

- [ ] **Step 1** Add both fields; `npx prisma migrate dev --name t5_detention_free_min`.
- [ ] **Step 2** Test: a stop with `null` reads back `null` (not 0); the org default applies; a stop with an explicit `0` is preserved as `0` and is distinguishable from `null` — those mean different things and the schema must keep them apart.
- [ ] **Step 3** Run the file, then the full suite.
- [ ] **Step 4: Commit**

```bash
git add fleet-backend/prisma/schema.prisma fleet-backend/prisma/migrations fleet-backend/tests/detention-free-min-model.test.ts
git commit -m "feat(db): per-stop and per-org detention free time"
```

---

### Task 4: Assemble claims from the database

**Files:**
- Create: `fleet-backend/src/lib/detentionScan.ts`
- Test: `fleet-backend/tests/detention-scan.test.ts` (create)

**Interfaces:**

```ts
export interface StopDetention {
  loadId: string;
  loadRef: string | null;
  stopId: string;
  stopLabel: string;
  stopType: string;
  driverId: string;
  driverName: string;
  /** null when no claim can honestly be made; the reason is in `noClaimReason` */
  claim: DetentionClaim | null;
  /** stated whenever claim is null, so the UI never renders a bare blank */
  noClaimReason: string | null;
  /** observed dwell even when no claim is possible — a real, useful fact */
  observedMin: number | null;
}
export async function scanDetention(orgId: string, sinceMs: number): Promise<StopDetention[]>;
```

**Query discipline.** Fetch every candidate stop's pings in **one** query per driver over the
whole window, not one query per stop. `DriverLocation` is indexed on `(driverId, createdAt)`; use
it. A fleet running a week of 1-minute pings is ~10k rows per driver, so bound the window and
select only `latitude`, `longitude`, `createdAt`.

- [ ] **Step 1: Write the failing tests** — a seeded driver sitting past free time at a geocoded
stop with an appointment produces a claim; the same stop with `geocodeStatus: "pending"` produces
`claim: null` with a stated `noClaimReason` **and still reports `observedMin`**; a second org's
loads never appear; free time resolves stop → org.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Implement.** Resolve free time with the same field-by-field pattern as
`resolveRateConfig` (Task 3's note). Use `dwellSegments` and `detentionClaim`; compute nothing
yourself.

- [ ] **Step 4: Run** the file, then the full suite.

- [ ] **Step 5: Prove discrimination** — drop the org filter; the cross-tenant test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/lib/detentionScan.ts fleet-backend/tests/detention-scan.test.ts
git commit -m "feat: assemble detention claims from ping history"
```

---

### Task 5: The detention API and demo seed

**Files:**
- Create: `fleet-backend/src/routes/dispatcherDetention.ts`
- Modify: `fleet-backend/src/app.ts`, `fleet-backend/seed-demo.mjs`
- Test: `fleet-backend/tests/dispatcher-detention.test.ts` (create)

`GET /dispatcher/detention?sinceHours=72` returns `StopDetention[]`, org-scoped, dispatcher-authed.
Follow `dispatcherRestStops.ts` / `dispatcherFuelPrices.ts` for structure; mount after the
`/api/dispatcher` auth gate.

- [ ] **Step 1: Write the failing tests** — 401 unauthenticated; org scoping; `sinceHours` validated by Zod with a sane cap (e.g. 1–720) so a caller cannot ask for a full-table scan; a claim's evidence survives the JSON round-trip.
- [ ] **Step 2: Run to confirm failure.**
- [ ] **Step 3: Implement the route.**
- [ ] **Step 4: Seed three deliberately different situations**, named in comments so the live pass can find them:
  1. **A clean, billable claim** — dense pings, well past free time, departure observed.
  2. **A claim needing review** — same shape but with a deliberate multi-hour gap in the pings.
  3. **A stop with dwell but no claim** — pings present but `geocodeStatus` not `"ok"`, so the fence is untrustworthy. This one proves the product refuses to invoice on bad geometry.
  The seed must be idempotent across three consecutive runs and must delete dependent rows before parents.
- [ ] **Step 5: Run** the file, `node seed-demo.mjs` three times, then the full suite.
- [ ] **Step 6: Commit**

```bash
git add fleet-backend/src/routes/dispatcherDetention.ts fleet-backend/src/app.ts fleet-backend/seed-demo.mjs fleet-backend/tests/dispatcher-detention.test.ts
git commit -m "feat(api): detention claims endpoint and demo scenarios"
```

---

### Task 6: Portal types and store

**Files:**
- Modify: `fleet-portal/src/lib/api.ts`, `fleet-portal/src/stores/cockpit.ts`
- Test: `fleet-portal/src/stores/cockpit.spec.ts`

Add the wire types and a `detention` slice to the cockpit store: `items: StopDetention[]`,
`loading`, `error`, and a `loadDetention(sinceHours)` action.

**Error handling is part of this task, not an afterthought.** A failed fetch sets `error` and
leaves `items` empty; the panel (Task 7) must then say it could not load — never render an empty
list, which reads as "no detention anywhere" and is the most expensive possible lie in this
feature. Test the failure path explicitly.

- [ ] Steps 1–6 as usual: failing tests first (success, failure, and that a failure does not clear a previously loaded list), implement, run `npx vitest run && npx vue-tsc --noEmit`, discrimination (make the error path silently produce `[]`; the failure test must fail), commit.

```bash
git commit -m "feat(cockpit): detention store slice with an explicit error state"
```

---

### Task 7: The detention panel

**Files:**
- Create: `fleet-portal/src/components/cockpit/DetentionPanel.vue`
- Modify: `fleet-portal/src/views/CockpitView.vue`
- Test: `DetentionPanel.spec.ts` (create)

Renders one row per `StopDetention`:

| State | Render |
|---|---|
| `claim` present, `needsReview: false` | billable minutes and the evidence summary |
| `claim` present, `needsReview: true` | the same, plus each `reviewReasons` string verbatim and a clear "review" marker |
| `claim: null` | the `noClaimReason` verbatim, and `observedMin` when known — **never a blank row and never "$0"** |
| store `error` set | "could not load detention" — not an empty list |

Render `reviewReasons` and `noClaimReason` **verbatim from the server**. They are the engine's
explanation of its own refusal; a paraphrase drifts from the rule that produced it.

- [ ] Steps 1–6 as usual. Discrimination: render `claim: null` rows as "$0 detention"; that test must fail. Restore.

```bash
git commit -m "feat(cockpit): detention panel with claims, reviews and refusals"
```

---

### Task 8: Detention marker on the board

**Files:**
- Modify: `fleet-portal/src/components/cockpit/GanttBoard.vue`, `fleet-portal/src/components/cockpit/LegBrick.vue`
- Test: `LegBrick.spec.ts`, `GanttBoard.spec.ts`

A brick whose load has a billable claim gets a small marker; hovering states the billable minutes.
Follow the established wiring exactly: **`GanttBoard` hands it down as a prop; `LegBrick` stays
presentational and never reads the store.** This is the third feature to use that pattern —
match it rather than inventing a fourth shape.

Absence rule, identical to the break glyph and the fuel chip: **no claim → no marker.** Not a
grey marker, not "$0".

- [ ] Steps 1–6 as usual. Discrimination: show the marker for `claim: null`; that test must fail.

```bash
git commit -m "feat(cockpit): detention marker on the brick"
```

---

### Task 9: Live pass

**Files:** none (verification only).

Every previous live pass in this project found something the unit tests did not — a layer that
drew nothing, a demo scenario with no reachable load, a field the store mapping silently dropped.
Assume this one will too.

- [ ] **Step 1** Kill the fleet-backend `tsx` process (leave other projects' alone), `npx prisma generate`, `node seed-demo.mjs`, restart, confirm `/health` and that `/api/dispatcher/detention` returns **401** unauthenticated rather than 500.
- [ ] **Step 2** Verify in the browser:
  - the clean seeded claim shows billable minutes and its evidence;
  - the gapped claim shows a review marker **and the gap reason verbatim**;
  - the bad-geocode stop shows its `noClaimReason` and its observed dwell — **not a blank row, not "$0"**. This is the most important check in the slice;
  - **check the seam** — confirm the values the panel renders match what the API returns for the same stop. Two slices running, two seam defects; look for a third rather than trusting the components.
  - stop the backend and reload → the panel says it could not load, not "no detention";
  - zero console errors; screenshot to `docs/screenshots/`.
- [ ] **Step 3** Full suites: `npx vitest run --pool=forks`, `npx tsc --noEmit`, and in the portal `npx vitest run && npx vue-tsc --noEmit && npm run build`.
- [ ] **Step 4** Restore the seed; confirm idempotent across three runs.

---

## Self-Review

**Spec coverage.** §4 T5 asks for three things. *"Geofence dwell from the existing ping history"* —
Tasks 1 and 4. *"Detention threshold per stop"* — Task 3. *"Billable-claim surfacing"* — Tasks 2,
5, 7, 8. Acceptance *"a truck sitting 3h at a stop raises a detention claim with evidence"* is the
clean seeded scenario in Task 5, verified live in Task 9.

**The thing to get right.** Task 2's four `null` cases. Every one of them is a situation where the
arithmetic would happily produce a number and the number would be indefensible: a fence around a
city centroid, a stop with no agreed schedule, a single ping, or dwell inside free time. This
feature's output is an **invoice to a third party**. A claim that cannot survive a broker asking
"how do you know?" damages every other claim the carrier files, so the refusals matter more than
the calculations.

**Direction of error (Global Constraint 5).** Arrival is the first ping *observed* inside the
fence, so real arrival was at or before it and dwell is a lower bound. Free time runs from the
later of arrival and window open. Both choices shrink the claim. That is deliberate: this number
is only useful if it is defensible.

**Type consistency.** `Ping`/`DwellSegment` (Task 1) → `DetentionInput`/`DetentionClaim` (Task 2)
→ `StopDetention` (Task 4) → API (Task 5) → store (Task 6) → panel (Task 7) and brick (Task 8).

**Known interaction with T3/T4.** Tasks 6 and 8 touch `cockpit.ts`, `GanttBoard.vue` and
`LegBrick.vue`, which now carry break-plan and fuel wiring. Add beside; do not reshape. **And note
the recurring defect:** both prior slices shipped a field the store mapping dropped between the
task that produced it and the task that rendered it. Task 6 owns the store slice and Task 7 owns
the panel — if the value the panel needs has to cross a mapping function, one of those two tasks
must test the crossing, not just its own side.
