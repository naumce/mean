# Cockpit S2b — Board Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cockpit board operable — drag a backlog load onto a lane, move a leg in time or between drivers, resize its edges, hook equipment from the yard — with the server deciding every outcome and the lock protocol keeping two dispatchers out of each other's lanes.

**Architecture:** All gesture arithmetic lives in one pure module (`lib/cockpit/drag.ts`) that converts pointer pixels into a proposed `availableAt` / `plannedEnd`, so the geometry is unit-tested without a DOM. `GanttBoard.vue` owns pointer capture and renders a ghost; it never mutates data. Every gesture ends in the same three-step pipeline — **acquire lock → dry-run → commit or show the verdict** — implemented once in `stores/cockpit.ts` so drop, move and resize cannot drift apart. The board stays engine-authoritative: nothing moves optimistically, because a brick that snaps back after the server refuses is worse than one that waits 200 ms.

**Tech Stack:** Vue 3 `<script setup>` + TS strict, Pinia options-API stores, Tailwind v3 with the S0 semantic tokens, axios, Vitest + jsdom + @vue/test-utils.

**Spec:** `docs/superpowers/specs/2026-08-28-cockpit-control-tower-design.md` — §7.3 (board), §7.4 (drawer), §7.5 (modals), §8 (interaction flows), §10 (error handling).

**Depends on:** `2026-08-31-cockpit-s2a-interaction-api.md` must land first. Every task below calls an endpoint that plan creates.

## Global Constraints

- **NO GIT COMMITS.** Standing user rule; the task report is the record.
- **`erasableSyntaxOnly: true`** — no TS parameter properties, no `enum`, no `namespace` (TS1294). Use `const` objects with `as const` and union types.
- **Semantic tokens only** for colour (`bg-surface`, `text-ink-2`, `border-line`, `text-conflict`…). No raw `gray-*`. Equipment-identity colours are the documented exception (S1 Task 11 ruling).
- **Engine-authoritative, never optimistic.** No gesture writes to the local store before the server responds. A ghost may follow the pointer; the brick moves only on 200.
- **Real data only.** A verdict the server did not return is not rendered. Unknown ≠ zero.
- **Every gesture is keyboard-reachable or has a non-drag equivalent** — a board only operable by mouse-drag excludes people who cannot drag. The drawer's schedule fields are that equivalent; they are not optional.
- **Tests:** Vitest + jsdom. Gate per task: `npx vitest run` (full portal suite — it does not segfault), `npx vue-tsc --noEmit -p tsconfig.app.json`, `npm run build`.
- Pointer events, not HTML5 drag-and-drop: `setPointerCapture` gives correct behaviour over scrolling containers and needs no `dataTransfer` shimming in jsdom.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/cockpit/drag.ts` | **new** — pure gesture math: pixel delta → snapped instant, resize bounds, lane hit-testing |
| `src/stores/locks.ts` | **new** — lock state, 30 s heartbeat, WS `lane_lock`/`lane_unlock` |
| `src/stores/cockpit.ts` | modify — `drag` state + the shared acquire→dry-run→commit pipeline |
| `src/lib/api.ts` | modify — `locks`, `planAssignment`, `tender*` client methods |
| `src/components/cockpit/GanttBoard.vue` | modify — pointer capture, ghost, drop targets |
| `src/components/cockpit/DragGhost.vue` | **new** — the translucent proposed brick |
| `src/components/cockpit/PlanVerdictModal.vue` | **new** — blocked-verdict dialog with Force |
| `src/components/cockpit/SuggestModal.vue` | **new** — ranked drivers for a load |
| `src/components/cockpit/LoadFinderModal.vue` | **new** — ranked loads for a lane |
| `src/components/cockpit/MasterDrawer.vue` | modify — actions + diff-gated save |
| `src/components/cockpit/LaneHeadDriver.vue` | modify — lock badge |
| `src/components/cockpit/YardChips.vue` | modify — draggable chips (the yard hook) |

Thirteen tasks. Task 1 is pure and carries the most risk-per-line; Tasks 6–9 are UI shells over it.

---

### Task 1: Gesture math

**Files:** Create `src/lib/cockpit/drag.ts`, `src/lib/cockpit/drag.spec.ts`

**Interfaces:**
```ts
export const SNAP_MIN = 15
export interface DragProposal { startMs: number; endMs: number }
export function snapMs(ms: number, tz: string, snapMin?: number): number
export function proposeMove(startMs: number, endMs: number, dxPx: number, cfg: CockpitConfig): DragProposal
export function proposeResize(startMs: number, endMs: number, dxPx: number, edge: 'l' | 'r', cfg: CockpitConfig): DragProposal | null
export function proposeDrop(xPx: number, cfg: CockpitConfig): number
export function laneAtY(yPx: number, lanes: Array<{ id: string; top: number; height: number }>): string | null
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/cockpit/drag.spec.ts
import { describe, expect, it } from 'vitest'
import { laneAtY, proposeDrop, proposeMove, proposeResize, snapMs, SNAP_MIN } from './drag'
import type { CockpitConfig } from './geometry'

const TZ = 'America/Chicago'
// 3-day window, 22 px/h — the board's default preset.
const cfg: CockpitConfig = { tz: TZ, day0: '2026-08-31', days: 3, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 }
const at = (iso: string) => Date.parse(iso)

describe('snapMs', () => {
  it('snaps to the nearest quarter hour', () => {
    expect(snapMs(at('2026-08-31T14:07:00Z'), TZ)).toBe(at('2026-08-31T14:00:00Z'))
    expect(snapMs(at('2026-08-31T14:08:00Z'), TZ)).toBe(at('2026-08-31T14:15:00Z'))
  })
  it('snaps to wall-clock quarters, not UTC quarters', () => {
    // Every US zone is a whole number of half-hours from UTC, so this holds
    // today; the test exists so a future half-hour zone (or a change to
    // SNAP_MIN) fails loudly instead of drifting the board by minutes.
    expect(snapMs(at('2026-08-31T14:07:00Z'), 'Asia/Kolkata')).toBe(at('2026-08-31T14:00:00Z'))
  })
})

describe('proposeMove', () => {
  it('translates pixels into time at the current zoom', () => {
    const s = at('2026-08-31T15:00:00Z'), e = at('2026-08-31T19:00:00Z')
    const p = proposeMove(s, e, 22, cfg)          // 22px = 1h at 22px/h
    expect(p.startMs).toBe(at('2026-08-31T16:00:00Z'))
    expect(p.endMs).toBe(at('2026-08-31T20:00:00Z')) // duration preserved
  })
  it('preserves duration exactly across a DST boundary', () => {
    // 2026-11-01 is the US fall-back. A leg dragged across it must keep its
    // 4h duration in elapsed time, not gain an hour of wall clock.
    const s = at('2026-11-01T04:00:00Z'), e = at('2026-11-01T08:00:00Z')
    const p = proposeMove(s, e, 44, cfg)
    expect(p.endMs - p.startMs).toBe(e - s)
  })
  it('is a no-op for a zero drag', () => {
    const s = at('2026-08-31T15:00:00Z'), e = at('2026-08-31T19:00:00Z')
    expect(proposeMove(s, e, 0, cfg)).toEqual({ startMs: s, endMs: e })
  })
})

describe('proposeResize', () => {
  const s = at('2026-08-31T15:00:00Z'), e = at('2026-08-31T19:00:00Z')
  it('right edge moves the end only', () => {
    const p = proposeResize(s, e, 44, 'r', cfg)!
    expect(p.startMs).toBe(s)
    expect(p.endMs).toBe(at('2026-08-31T21:00:00Z'))
  })
  it('left edge moves the start only', () => {
    const p = proposeResize(s, e, -22, 'l', cfg)!
    expect(p.startMs).toBe(at('2026-08-31T14:00:00Z'))
    expect(p.endMs).toBe(e)
  })
  it('refuses to invert the leg', () => {
    // Dragging the right edge left past the start must return null, not a
    // negative-duration proposal the server would have to reject.
    expect(proposeResize(s, e, -22 * 5, 'r', cfg)).toBeNull()
  })
  it('refuses to collapse below one snap unit', () => {
    const oneSnapPx = (SNAP_MIN / 60) * cfg.pxPerHour
    expect(proposeResize(s, e, -(4 * 22) + oneSnapPx, 'r', cfg)).not.toBeNull()
    expect(proposeResize(s, e, -(4 * 22), 'r', cfg)).toBeNull()
  })
})

describe('laneAtY', () => {
  const lanes = [
    { id: 'a', top: 0, height: 100 },
    { id: 'b', top: 100, height: 100 },
  ]
  it('finds the lane under the pointer', () => {
    expect(laneAtY(50, lanes)).toBe('a')
    expect(laneAtY(150, lanes)).toBe('b')
  })
  it('puts a boundary pixel in the lower lane, consistently', () => {
    expect(laneAtY(100, lanes)).toBe('b')
  })
  it('returns null outside every lane rather than guessing the nearest', () => {
    expect(laneAtY(-5, lanes)).toBeNull()
    expect(laneAtY(500, lanes)).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail** — `npx vitest run src/lib/cockpit/drag.spec.ts`.

- [ ] **Step 3: Implement**

```ts
// src/lib/cockpit/drag.ts
// Pure gesture arithmetic. No DOM, no store, no clock — every input is an
// argument so the whole module is unit-testable, which matters because a
// one-pixel error here silently reschedules a truck by minutes.
import { wallMinutes, xToTime, type CockpitConfig } from './geometry'

export const SNAP_MIN = 15

export interface DragProposal {
  startMs: number
  endMs: number
}

/** Snap to the nearest quarter hour *of wall time in the org's zone*, not of
 *  UTC — a board drawn in local hours must snap to the lines it draws. */
export function snapMs(ms: number, tz: string, snapMin: number = SNAP_MIN): number {
  const mins = wallMinutes(ms, tz)
  const delta = Math.round(mins / snapMin) * snapMin - mins
  return ms + delta * 60_000
}

const msPerPx = (cfg: CockpitConfig): number => 3_600_000 / cfg.pxPerHour

/** Move the whole leg. Duration is preserved in elapsed milliseconds, so a leg
 *  dragged across a DST boundary keeps its real length rather than gaining or
 *  losing an hour of driving. */
export function proposeMove(startMs: number, endMs: number, dxPx: number, cfg: CockpitConfig): DragProposal {
  const start = snapMs(startMs + dxPx * msPerPx(cfg), cfg.tz)
  return { startMs: start, endMs: start + (endMs - startMs) }
}

/** Drag one edge. Returns null when the gesture would invert the leg or shrink
 *  it below a single snap unit — the caller shows no ghost rather than
 *  proposing something the server must reject. */
export function proposeResize(
  startMs: number,
  endMs: number,
  dxPx: number,
  edge: 'l' | 'r',
  cfg: CockpitConfig,
): DragProposal | null {
  const shift = dxPx * msPerPx(cfg)
  const p =
    edge === 'r'
      ? { startMs, endMs: snapMs(endMs + shift, cfg.tz) }
      : { startMs: snapMs(startMs + shift, cfg.tz), endMs }
  return p.endMs - p.startMs >= SNAP_MIN * 60_000 ? p : null
}

/** Where a dropped backlog card starts. `xToTime` already rounds to 15-minute
 *  wall marks (geometry.ts:141) and clamps to the visible window, so this is a
 *  named pass-through — snapping again would be a no-op that reads as though
 *  the two rounding rules were independent. If SNAP_MIN ever diverges from
 *  geometry's 15, this is the seam to change. */
export function proposeDrop(xPx: number, cfg: CockpitConfig): number {
  return xToTime(xPx, cfg)
}

/** Hit-test a pointer y against laid-out lanes. Boundaries belong to the lower
 *  lane so adjacent lanes tile without a dead pixel between them; outside every
 *  lane returns null rather than snapping to the nearest, because dropping a
 *  load on "whichever lane was closest" is how you assign the wrong driver. */
export function laneAtY(yPx: number, lanes: Array<{ id: string; top: number; height: number }>): string | null {
  for (const l of lanes) if (yPx >= l.top && yPx < l.top + l.height) return l.id
  return null
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/lib/cockpit/drag.spec.ts && npx vue-tsc --noEmit -p tsconfig.app.json`

---

### Task 2: API client methods

**Files:** Modify `src/lib/api.ts`; Test `src/lib/api.spec.ts` (extend if present, else create)

**Interfaces (produces):**
```ts
acquireLock(laneId: string): Promise<{ lock: Lock }>            // 409 rejects with the holder in error.response.data.lock
releaseLock(laneId: string): Promise<void>
fetchLocks(): Promise<{ locks: Lock[] }>
planAssignment(id: string, body: PlanBody): Promise<PlanResult> // PATCH /assignments/:id/plan
createAssignment(body: CreateBody): Promise<PlanResult>          // POST /assignments (dryRun/force/tender)
acceptTender(id): Promise<{ assignment: BoardAssignment }>
declineTender(id, reason?): Promise<void>
```
Mirror the existing axios wrapper style in `api.ts`; do not introduce a second HTTP idiom.

- [ ] **Step 1:** Test each method hits the right URL and verb with a mocked axios, and that a 409 surfaces `error.response.data.lock` intact (the toast needs the holder's name).
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/lib/api.spec.ts`

---

### Task 3: Lock store and heartbeat

**Files:** Create `src/stores/locks.ts`, `src/stores/locks.spec.ts`

**Interfaces:**
```ts
state: { held: string | null; byLane: Record<string, Lock>; }
actions: hold(laneId), release(), refresh(), applyEvent(evt), heldBy(laneId): Lock | null, isLockedByOther(laneId): boolean
```

**Behaviour that the tests must pin:**
- `hold()` starts a **30 s** heartbeat re-POSTing the same lane (TTL is 90 s server-side; two missed beats are survivable).
- `release()` stops the heartbeat and DELETEs. It must be **idempotent** — called on drawer close, route leave, and unmount.
- A 409 from `hold()` does not throw to the caller; it records the holder and returns `false`, so the drawer can open read-only.
- `applyEvent({type:'lane_unlock'})` for a lane we believe we hold must **not** silently drop our own heartbeat — trust our own state over an echo of our own event.

- [ ] **Step 1: Write the failing test** — use `vi.useFakeTimers()`; assert exactly one heartbeat per 30 s, that `release()` twice sends one DELETE, and that a 409 leaves `held === null`.
- [ ] **Step 2–4:** implement, then `npx vitest run src/stores/locks.spec.ts`.

> **Leak hazard:** an interval that outlives the component keeps a lane locked for every other dispatcher until the TTL. `release()` must be called from `onBeforeUnmount` **and** the router's `beforeRouteLeave`. Test the unmount path explicitly — S1's review caught exactly this class of bug in `CockpitView`.

---

### Task 4: The gesture pipeline

**Files:** Modify `src/stores/cockpit.ts`; Test `src/stores/cockpit.spec.ts`

The single place every gesture funnels through, so drop, move and resize cannot diverge:

```ts
async function runGesture(laneId: string, call: (dryRun: boolean, force: boolean) => Promise<PlanResult>) {
  if (!(await locks.hold(laneId))) { toastLockRefused(locks.heldBy(laneId)); return }
  try {
    const preview = await call(true, false)
    if (!preview.feasible) { openVerdictModal(preview, () => call(false, true)); return }
    await call(false, false)
    await refreshBoard()                       // loadboard + kpis + alerts + risk + yard
    toast('plan', 'Leg updated', …)
  } catch (e) {
    if (status(e) === 409) { toastLockRefused(lockFrom(e)); await refreshBoard() }
    else if (status(e) === 422) openVerdictModal(dataFrom(e), () => call(false, true))
    else toast('error', extractApiErrorMessage(e))
  }
}
```

- [ ] **Step 1: Write the failing test** — with a mocked api module, assert: dry-run precedes commit; a blocked preview opens the verdict modal and **does not** commit; Force re-calls with `force:true`; a 409 shows the lock toast and refreshes; the board is never mutated before a 200.
- [ ] **Step 2–4:** implement; `npx vitest run src/stores/cockpit.spec.ts`.

---

### Task 5: Board pointer handling and the ghost

**Files:** Modify `src/components/cockpit/GanttBoard.vue`; create `src/components/cockpit/DragGhost.vue`; test `src/components/cockpit/GanttBoard.spec.ts` (extend)

- `pointerdown` on a brick's 7 px edge strip → resize; on its body → move; on a backlog card or yard chip → drop. (This is the mockup's `.handle` affordance at `mockups/bertschi-master-cockpit.html:627` — restore the hover grip: a 2 px bar at 50 % opacity, `cursor: ew-resize`.)
- `setPointerCapture` on the board; `pointermove` updates ghost geometry from Task 1; `pointerup` calls the Task 4 pipeline; **Escape cancels** without a request.
- The real brick keeps its original position for the whole gesture. Only the ghost moves.

- [ ] **Step 1: Write the failing test** — dispatch synthetic pointer events and assert: a 44 px drag at 22 px/h proposes +2 h; the ghost renders at the proposed x; Escape mid-drag emits nothing; `pointerup` outside every lane emits nothing (`laneAtY` → null); a drag under 3 px is treated as a click and opens the drawer instead.
- [ ] **Step 2–4:** implement; full portal suite.

> jsdom has no layout, so lane rects must come from a prop or an injected measurement function rather than `getBoundingClientRect()`. Design for that from the start — retrofitting testability here is expensive.

---

### Task 6: `PlanVerdictModal`

**Files:** Create `src/components/cockpit/PlanVerdictModal.vue` + spec

Renders the 422/dry-run verdict: blockers ✗ and warnings ⚠ with `kind` and `detail`, the economics delta, **Cancel** and **Force anyway**.

- [ ] Test: block rows render with their detail text; **Force is absent when there are no blockers**; the economics row shows "—" (never `$0`) when `economics` is null; Escape and Cancel both close without committing.
- [ ] **Force must ALSO be absent when any blocker is an `overlap`** — see the constraint below. Test that a verdict containing an overlap renders no Force button, and renders the reason instead.
- [ ] Implement; verify.

> **An overlap cannot be forced — discovered while building S2a Task 8.** The server's in-transaction
> Serializable re-check refuses an overlapping window *unconditionally*, on both `POST /assignments` and
> `PATCH /plan`. `force` clears the advisory 422 and the write is then refused anyway with a 409. This is
> deliberate and must not change: an overlap is physics, not judgement — one driver cannot run two loads at
> once — and making the guard force-aware would let a forced write win a genuine race, which is the double-
> booking this whole subsystem exists to prevent.
>
> The consequence for this modal: **offering Force on an overlap offers something that cannot succeed.** The
> dispatcher clicks it, waits, and gets an error. Hide the button and state the reason. `force` remains correct
> for judgement-call blockers — HOS warnings, compliance flags — where a dispatcher may knowingly accept risk.

> The null-economics case is the C1 defect class from S1. A verdict modal that prints `$0 margin` for an unpriced load is the same lie in a new place.

---

### Task 7: `SuggestModal`

**Files:** Create `src/components/cockpit/SuggestModal.vue` + spec

`GET /suggest?loadId` ranked rows: #1 emerald, feasible amber, infeasible red **with the blocking reason**; each row offers *Commit & Assign* and *📤 Tender*; footer shows the org cost model.

- [ ] Test: rows render in server order (never re-sorted client-side); an infeasible row's action buttons are disabled and its reason is shown; Tender calls `createAssignment({tender:true})`.
- [ ] Implement; verify.

---

### Task 8: `LoadFinderModal`

**Files:** Create `src/components/cockpit/LoadFinderModal.vue` + spec

`GET /drivers/:id/next` — ranked loads for one lane, launched from the lane's free-window "⚡ Match" affordance. Same row/action shape as Task 7; extract the shared row into `RankedRow.vue` rather than copying it.

- [ ] Test, implement, verify.

---

### Task 9: Drawer actions

**Files:** Modify `src/components/cockpit/MasterDrawer.vue` + spec

- Quick actions: ▶ Advance (`POST /status`), ↩ Unassign (`DELETE`), 🗑 Cancel, Accept/Reject when tendered.
- Schedule & assignment section: driver/tractor/trailer selects and start/end inputs → **`PATCH /plan`**. This is the non-drag equivalent of every gesture and satisfies the accessibility constraint.
- **Diff-gated Save**: disabled until something actually changed; the diff is computed against the loaded assignment, not against the last keystroke.
- Read-only mode with the holder's name when `locks.isLockedByOther(laneId)`.

- [ ] Test: Save is disabled with no edits and enabled after one; a read-only drawer renders no mutating control **and** no enabled Save; Advance calls status with the right transition; Reject on a tendered leg calls decline.
- [ ] Implement; verify.

---

### Task 10: Lock presence on lane heads

**Files:** Modify `src/components/cockpit/LaneHeadDriver.vue`, `LaneHeadUnit.vue` + `LaneHead.spec.ts`

A lock badge naming the holder; a subtle lane tint when held by someone else. Ours renders differently from theirs — a dispatcher must be able to tell at a glance whether the lane they cannot edit is locked by *them*.

- [ ] Test: badge shows the holder's name; own-lock and other-lock render distinguishably; no badge when free.
- [ ] Implement; verify.

---

### Task 11: WS wiring

**Files:** Modify `src/stores/loadboard.ts` (or wherever the socket lives — verify at task time)

Handle `lane_lock` / `lane_unlock` into the lock store, and the enriched `board_update` payloads (`replanned`, `tendered`, `accepted`, `declined`) into the activity feed and toasts.

- [ ] Test: a `lane_lock` for another dispatcher marks the lane; `lane_unlock` clears it; a `board_update {replanned:true}` triggers exactly one board refresh (not one per field).
- [ ] Implement; verify.

---

### Task 12: Yard hook — pairing by drag

**Files:** Modify `src/components/cockpit/YardChips.vue`, `GanttBoard.vue`; test `Panels.spec.ts`

Drag a tractor or trailer chip from the yard onto a driver lane → `PATCH /drivers/:id/pairing` (S2a Task 10). Dropping a driver chip onto a unit lane does the same pairing from the other side.

Per §8, a pairing change is followed by `PATCH /plan` for that lane's **assigned** legs when the equipment actually changed — the server deliberately does not do this implicitly, so the client sequences it and surfaces one verdict if the replan is blocked.

- [ ] **Step 1: Test** — dropping a Reefer chip on Jake's lane calls pairing with `{trailerId}`; a chip dropped outside any lane calls nothing; a 409 lock response shows the lock toast; when the lane has assigned legs, `planAssignment` is called once per leg *after* the pairing succeeds, never before.
- [ ] **Step 2–4:** implement; full portal suite.

> **Ordering hazard:** replanning before the pairing is written makes the engine evaluate against the old equipment and quietly approve a move that the new trailer cannot serve. Pairing first, then replan — the test above pins the order.

---

### Task 13: Live pass

Not a code task — the verification the automated suite cannot do.

- [ ] Reseed: `cd fleet-backend && node seed-control-tower.mjs && node seed-demo.mjs`
- [ ] Two browser sessions, two dispatcher accounts, same org.
- [ ] Session A opens a lane's drawer; session B drags a brick on that lane → **red lock toast naming A**, brick does not move.
- [ ] A closes the drawer; B's identical drag now succeeds; A's board updates live without a reload.
- [ ] Drag a backlog load onto Jake's lane → verdict or commit; drag L-90411 to a driver lacking the endorsement → verdict lists the blocker.
- [ ] Resize a leg's right edge past its drive time → commits; drag it far left → refuses with `plan_too_short`.
- [ ] Zero console errors in both sessions; screenshot both themes.

---

## Final gate

```bash
npx vitest run && npx vue-tsc --noEmit -p tsconfig.app.json && npm run build
```

## Acceptance (spec §12, S2)

Every row of §8 works live, and the lock 409 is demonstrated with two sessions.

## Deliberately deferred within S2

The spec's S2 row also lists the drawer's **💬 Message driver** slide-over and **⚡ Push to driver app**. Both are pure additions over existing endpoints (`dispatcherComms`, `POST /drivers/:id/notify`) and neither is on the drag path, so they are the first two tasks of an S2c follow-up rather than blockers for "the board is operable". Record this as a ruling when executing; do not silently drop them.

## Deferred to S3 (do not build here)

Fleet actions and occupancy blocks, tractor/trailer grouping, free-window match slots, checklists and the stepper, `NewLegModal`, `FleetHud`. S2 ends when the gestures in §8 work.
