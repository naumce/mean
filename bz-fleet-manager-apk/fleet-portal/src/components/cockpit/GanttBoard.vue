<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type ComponentPublicInstance } from 'vue'
import { laneAtY, proposeDrop, proposeMove, proposeResize } from '../../lib/cockpit/drag'
import { connectors } from '../../lib/cockpit/deadhead'
import { fmtClock } from '../../lib/cockpit/format'
import { brickSpan, timeToX, totalWidth } from '../../lib/cockpit/geometry'
import { groupLanesByCarrier, plannedDriveTodayMin, spanOf, type CockpitLane } from '../../lib/cockpit/lanes'
import { isExpired } from '../../lib/compliance'
import type { StopDetention } from '../../lib/api'
import { useCockpitStore } from '../../stores/cockpit'
import { useEconomicsStore } from '../../stores/economics'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'
import { useLoadLocksStore } from '../../stores/loadLocks'
import { useTrackingStore } from '../../stores/tracking'
import DeadheadLine from './DeadheadLine.vue'
import DragGhost from './DragGhost.vue'
import LaneHeadCarrier from './LaneHeadCarrier.vue'
import LaneHeadDriver from './LaneHeadDriver.vue'
import LaneHeadUnit from './LaneHeadUnit.vue'
import LegBrick from './LegBrick.vue'
import NowLine from './NowLine.vue'
import TimeRulerX from './TimeRulerX.vue'

// The time-axis board: sticky lane headers on the left, one horizontally
// scrolling track per lane, bricks positioned by the org-tz geometry. Reads
// the cockpit (UI state) and loadboard (data) stores; emits clicks upward.
//
// Pointer gestures (move/resize/drop) live entirely in this component and lib
// / cockpit/drag.ts's pure math — the board is engine-authoritative, so a
// gesture only ever emits a *proposal* upward. It never mutates a load, never
// calls the API, and the real brick never moves: only the ghost, computed
// fresh from drag.ts on every pointermove, follows the pointer.
const LANE_W = 400
const CLICK_PX = 3
const DONE_STATUSES = new Set(['completed', 'delivered'])

const props = defineProps<{
  nowMs: number
  /** Lane hit-boxes for pointer gestures, in viewport (clientY-comparable)
   *  coordinates. Omit in production — the board measures its own rendered
   *  rows. Tests must supply this: jsdom has no layout engine, so
   *  getBoundingClientRect() is always zeroed. */
  laneRects?: Array<{ id: string; top: number; height: number }>
  /** Viewport x of the track's left edge (day0 @ dayStartHour), for the
   *  backlog-drop gesture's absolute-position math. Same jsdom caveat. */
  trackOriginX?: number
}>()
const emit = defineEmits<{
  open: [loadId: string]
  openDriver: [driverId: string]
  // Night Shift on the Board (Task 7): the pill lives inside LegBrick; this
  // is a plain passthrough of its own `open-agent` emit, the same shape as
  // `open`/`hover` just above, so CockpitView can mount the drawer without
  // GanttBoard knowing anything about the agent itself.
  'open-agent': [loadId: string]
  hover: [loadId: string | null, el: HTMLElement | null]
  'gesture-move': [payload: { loadId: string; assignmentId: string; driverId: string; availableAt: number }]
  'gesture-resize': [payload: { loadId: string; assignmentId: string; plannedEnd?: number; availableAt?: number }]
  'gesture-drop': [payload: { loadId: string; driverId: string; availableAt: number }]
  'gesture-pair': [payload: { driverId: string; tractorId?: string; trailerId?: string }]
}>()

const ck = useCockpitStore()
const lb = useLoadboardStore()
const tracking = useTrackingStore()
const econ = useEconomicsStore()
const loadLocks = useLoadLocksStore()

const cfg = computed(() => ck.config)
const width = computed(() => totalWidth(cfg.value))
const tractorsById = computed(() => new Map(lb.tractors.map((t) => [t.id, t])))
const trailersById = computed(() => new Map(lb.trailers.map((t) => [t.id, t])))
const driversById = computed(() => new Map(lb.lanes.map((d) => [d.id, d])))
const pingByDriver = computed(() => new Map(tracking.locations.map((p) => [p.driverId, p])))
/** T5 Dwell and Detention, Task 8: `ck.detention.items` is a flat array (one
 *  row per stop with a claim or a refusal), not a map keyed by load id like
 *  `breakPlanByLoadId`/`fuelPlanByLoadId` above — Task 7's panel needs the
 *  array as-is (it lists every stop), so this derives the board's own index
 *  here rather than reshaping the store. Only rows with a non-null `claim`
 *  are indexed: a load whose only rows are refusals (`claim: null`), or
 *  that has no detention row at all, both end up with no entry, so `.get()`
 *  returns `undefined` either way and LegBrick renders no marker for
 *  either case — one absence rule (LegBrick still re-checks `claim` itself
 *  rather than trusting this filtering; see its own prop doc).
 *
 *  A load can have several stops with a billable claim (e.g. detained at
 *  both pickup and delivery on the same run). This keeps the SINGLE row
 *  with the largest `claim.billableMin`, not the sum across stops: every
 *  claim must carry its own defensible evidence bundle — ping count,
 *  largest gap, the window it spans (Global Constraint 6) — and a summed
 *  total would not correspond to any one evidence bundle a dispatcher could
 *  point to on a dispute call. The marker states one real, fully-evidenced
 *  claim; the panel (Task 7) is still where every stop's own claim is
 *  listed in full. */
const detentionByLoadId = computed(() => {
  const out = new Map<string, StopDetention>()
  for (const row of ck.detention.items) {
    const billable = row.claim?.billableMin
    if (billable == null) continue
    const winner = out.get(row.loadId)
    if (!winner || billable > (winner.claim?.billableMin ?? 0)) out.set(row.loadId, row)
  }
  return out
})
const centsPerMi = computed(() => econ.costModel?.allInCentsPerMi ?? null)
const nowX = computed(() => timeToX(props.nowMs, cfg.value))
const searchOn = computed(() => ck.search.trim().length > 0)
const cornerLabel = computed(() =>
  ck.groupBy === 'driver'
    ? 'Fleet unit (specs · compliance · clocks)'
    : ck.groupBy === 'carrier'
      ? `By carrier · ${ck.lanes.length} drivers`
      : `${ck.groupBy}s · ${ck.lanes.length}`,
)
const grid = computed(() => {
  const out: Array<{ x: number; sep: boolean }> = []
  const hpd = cfg.value.dayEndHour - cfg.value.dayStartHour
  for (let d = 0; d < cfg.value.days; d++)
    for (let h = cfg.value.dayStartHour; h <= cfg.value.dayEndHour; h += 3)
      out.push({ x: d * hpd * cfg.value.pxPerHour + (h - cfg.value.dayStartHour) * cfg.value.pxPerHour, sep: h === cfg.value.dayStartHour && d > 0 })
  return out
})

interface BrickVisual {
  x: number
  w: number
  deadheadPx: number
  spotted: boolean
  dimmed: boolean
  selected: boolean
  conflict: boolean
  mismatch: boolean
  hazIssue: boolean
  regExpired: boolean
  risk: 'warn' | 'block' | null
  /** Plan A3 (spec §8.3): true whenever this leg has no assignment of ours —
   *  it runs on a carrier's own truck. `unplaced` narrows further: no
   *  assignment AND `spanOf` found no appointment window either, so the
   *  brick pins to the lane's left edge (x=0, UNPLACED_W wide) instead of a
   *  time-derived span. */
  brokered: boolean
  unplaced: boolean
  /** A4 Task 8: the dispatcher holding this load's lock, if it's someone
   *  else — `useLoadLocksStore().theirs` is the one source of lock truth
   *  (see that store's own doc), read here and handed down so LegBrick, a
   *  presentational component, never reaches into a store itself — the same
   *  prop-down shape as `breakPlan`/`fuelPlan`/`detention` above. */
  lockedBy: string | null
}

/** Width of a brokered brick with no appointment window to place it by — wide
 *  enough to read its Attention on hover, narrow enough to read as "unplaced"
 *  rather than a real duration. */
const UNPLACED_W = 96
/** Horizontal gap between two unplaced bricks pinned to the same lane's left
 *  edge (Fix round 1: several unplaced legs on one carrier otherwise stack
 *  exactly on top of each other at x=0). */
const UNPLACED_GAP = 4

/** `unplacedIndex` places the Nth unplaced leg of a lane (0-based, in the
 *  order `rows` hands its legs to `brickProps`) side by side with the ones
 *  before it — see `rows`' `bricks` computation below, which tracks this
 *  index per lane. Placed legs and legs with an assignment ignore it. */
function brickProps(l: BoardLoad, laneName: string, unplacedIndex = 0): BrickVisual | null {
  const a = l.assignment
  // A brokered leg (a === null) has no planned window of ours to draw from —
  // it spans the carrier's own PU→DEL appointment window (spanOf), or pins to
  // the lane's left edge when even that is unknown (spanOf returns null),
  // staggered by `unplacedIndex` so several unplaced legs on one lane don't
  // sit exactly on top of one another.
  const span = a
    ? brickSpan(Date.parse(a.plannedStart), Date.parse(a.plannedEnd), cfg.value)
    : (() => {
        const s = spanOf(l)
        return s ? brickSpan(s.startMs, s.endMs, cfg.value) : { x: unplacedIndex * (UNPLACED_W + UNPLACED_GAP), w: UNPLACED_W }
      })()
  if (!span) return null
  const trailer = a?.trailerId ? trailersById.value.get(a.trailerId) : undefined
  const driver = a ? driversById.value.get(a.driverId) : undefined
  const matches = ck.matchesSearch(l, laneName)
  return {
    x: span.x,
    w: span.w,
    deadheadPx: a?.deadheadMin ? Math.min(span.w, (a.deadheadMin / 60) * cfg.value.pxPerHour) : 0,
    spotted: searchOn.value && matches,
    dimmed: (searchOn.value && !matches) || !ck.matchesFilter(l),
    selected: ck.selectedLoadId === l.id,
    conflict: ck.conflictLoadIds.has(l.id),
    mismatch: !!trailer && trailer.type !== l.requiredEquip,
    hazIssue: !!l.hazmatClass && driver?.hazmatEndorsed === false,
    regExpired: isExpired(trailer?.registrationExpiresAt, props.nowMs),
    risk: lb.riskByLoadId[l.id] ?? null,
    brokered: !a,
    unplaced: !a && spanOf(l) === null,
    lockedBy: loadLocks.theirs[l.id]?.by ?? null,
  }
}

const rows = computed(() =>
  ck.lanes.map((lane: CockpitLane) => {
    const q = ck.search.trim().toLowerCase()
    // Fix round 1: several unplaced legs (no assignment, no spanOf window) on
    // the same lane otherwise all render at x=0 stacked on each other —
    // count them off in leg order and hand each its own stagger index.
    let unplacedSeen = 0
    return {
      lane,
      bricks: lane.legs
        .map((l) => {
          const isUnplaced = !l.assignment && spanOf(l) === null
          const p = brickProps(l, lane.name, isUnplaced ? unplacedSeen++ : 0)
          return { load: l, p }
        })
        .filter((b): b is { load: BoardLoad; p: BrickVisual } => b.p !== null),
      dh: connectors(lane.legs, cfg.value),
      plannedDrive: lane.kind === 'driver' ? plannedDriveTodayMin(lane, props.nowMs, ck.tz) : 0,
      spotLane: searchOn.value && [lane.name, lane.sub, lane.driver?.lastCity ?? ''].join(' ').toLowerCase().includes(q),
      tractor: lane.driver?.currentTractorId ? tractorsById.value.get(lane.driver.currentTractorId) ?? null : null,
      trailer: lane.driver?.currentTrailerId ? trailersById.value.get(lane.driver.currentTrailerId) ?? null : null,
      driverName: lane.tractor?.currentDriverId
        ? driversById.value.get(lane.tractor.currentDriverId)?.name ?? null
        : lane.trailer?.currentDriverId
          ? driversById.value.get(lane.trailer.currentDriverId)?.name ?? null
          : null,
    }
  }),
)

// -------------------------------------------------------------------------
// Carrier grouping (T1 Carrier Layer, Task 7): when ck.groupBy === 'carrier',
// the same `rows` above are reordered into carrier sections and a heading is
// inserted before the first row of each section — including the "No carrier"
// bucket, which groupLanesByCarrier guarantees is always present when any
// lane lacks a carrier, never silently dropped. For every other grouping,
// `renderRows` is `rows` itself and `carrierHeaderByLaneId` is empty, so the
// rendered DOM is byte-for-byte identical to before this feature existed.
const renderRows = computed(() => {
  if (ck.groupBy !== 'carrier') return rows.value
  const byLaneId = new Map(rows.value.map((r) => [r.lane.id, r]))
  return groupLanesByCarrier(ck.lanes).flatMap((g) =>
    g.lanes.map((l) => byLaneId.get(l.id)).filter((r): r is (typeof rows.value)[number] => !!r),
  )
})
const carrierHeaderByLaneId = computed(() => {
  const map = new Map<string, { id: string; name: string; count: number }>()
  if (ck.groupBy === 'carrier')
    for (const g of groupLanesByCarrier(ck.lanes)) if (g.lanes.length) map.set(g.lanes[0].id, { id: g.id, name: g.name, count: g.lanes.length })
  return map
})

function isDone(l: BoardLoad): boolean {
  return DONE_STATUSES.has(l.assignment?.status ?? l.status)
}

// ---------------------------------------------------------------------------
// Pointer gestures — move / resize / backlog-drop.
//
// One delegated pointerdown on the board root catches bricks and their edge
// handles (both live in this component's own tree). Backlog cards and yard
// chips live in sibling components (BacklogPanel, YardChips), so a second,
// document-level pointerdown listener catches those by their `data-bid` /
// `data-res` attributes — mirroring the mockup's single dispatch table
// (mockups/bertschi-master-cockpit.html:1010) without this file reaching into
// either sibling. A yard chip (`data-res="tractor"` or `"trailer"`, `data-rid`
// the unit id) dropped on a driver's lane emits `gesture-pair`; `data-res=
// "driver"` chips are not draggable — no gesture consumes them yet.
const boardRootEl = ref<HTMLElement | null>(null)
const ghost = ref<{ laneId: string; x: number; w: number; label: string; sub: string; blocked: boolean } | null>(null)
const laneRowEls = new Map<string, HTMLElement>()
const trackEls = new Map<string, HTMLElement>()

function setLaneRowEl(laneId: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) laneRowEls.set(laneId, el)
  else laneRowEls.delete(laneId)
}
function setTrackEl(laneId: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) trackEls.set(laneId, el)
  else trackEls.delete(laneId)
}

/** Lane hit-boxes for laneAtY. `laneRects` is the injected-measurement seam
 *  jsdom needs (no layout engine); production measures the rendered rows. */
function measureLaneRects(): Array<{ id: string; top: number; height: number }> {
  if (props.laneRects) return props.laneRects
  const out: Array<{ id: string; top: number; height: number }> = []
  for (const row of rows.value) {
    const el = laneRowEls.get(row.lane.id)
    if (!el) continue
    const r = el.getBoundingClientRect()
    out.push({ id: row.lane.id, top: r.top, height: r.height })
  }
  return out
}

function trackOriginX(laneId: string): number {
  if (props.trackOriginX != null) return props.trackOriginX
  return trackEls.get(laneId)?.getBoundingClientRect().left ?? 0
}

/** The driver a lane resolves to, whatever the current grouping — a tractor
 *  or trailer lane only accepts a move/drop when it currently has a driver
 *  hooked, since the pipeline's contract is always driver-keyed. */
function driverIdOfLane(laneId: string): string | null {
  const lane = ck.lanes.find((l) => l.id === laneId)
  if (!lane) return null
  if (lane.kind === 'driver') return lane.id
  if (lane.kind === 'tractor') return lane.tractor?.currentDriverId ?? null
  return lane.trailer?.currentDriverId ?? null
}

function findBrick(loadId: string): { load: BoardLoad; laneId: string } | null {
  for (const row of rows.value) {
    const b = row.bricks.find((x) => x.load.id === loadId)
    if (b) return { load: b.load, laneId: row.lane.id }
  }
  return null
}

function timeSub(startMs: number, endMs: number): string {
  return `${fmtClock(startMs, ck.tz)}–${fmtClock(endMs, ck.tz)}`
}

interface BrickDragBase {
  pointerId: number
  load: BoardLoad
  originLaneId: string
  startClientX: number
  startClientY: number
  origStartMs: number
  origEndMs: number
  moved: boolean
}
interface MoveDragState extends BrickDragBase {
  kind: 'move'
}
interface ResizeDragState extends BrickDragBase {
  kind: 'resize'
  edge: 'l' | 'r'
}
interface DropDragState {
  kind: 'drop'
  pointerId: number
  loadId: string
  label: string
  startClientX: number
  startClientY: number
  moved: boolean
}
interface PairDragState {
  kind: 'pair'
  pointerId: number
  unitKind: 'tractor' | 'trailer'
  unitId: string
  label: string
  startClientX: number
  startClientY: number
  moved: boolean
}
type DragState = MoveDragState | ResizeDragState | DropDragState | PairDragState

let drag: DragState | null = null

function armGesture(e: PointerEvent, cursor: string): void {
  const root = boardRootEl.value
  if (root && typeof root.setPointerCapture === 'function') {
    try {
      root.setPointerCapture(e.pointerId)
    } catch {
      /* unsupported in this environment (e.g. jsdom) — window listeners still drive the gesture */
    }
  }
  document.body.style.cursor = cursor
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('keydown', onEscape)
}

function endGesture(): void {
  const root = boardRootEl.value
  if (root && drag && typeof root.releasePointerCapture === 'function') {
    try {
      root.releasePointerCapture(drag.pointerId)
    } catch {
      /* already released / unsupported */
    }
  }
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('keydown', onEscape)
  drag = null
  ghost.value = null
}

/** Escape cancels mid-drag and emits nothing — the pointerup that (maybe)
 *  still follows finds `drag` already cleared and is a no-op. */
function onEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') endGesture()
}

function beginBrickGesture(e: PointerEvent, load: BoardLoad, laneId: string, edge?: 'l' | 'r'): void {
  // Plan A3: a brokered leg (no assignment of ours) has nothing here to
  // move/resize — this guard already covers it, since `brokered` in
  // `brickProps` is defined as exactly `!load.assignment`.
  if (!load.assignment || isDone(load)) return
  e.preventDefault()
  const base: BrickDragBase = {
    pointerId: e.pointerId,
    load,
    originLaneId: laneId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    origStartMs: Date.parse(load.assignment.plannedStart),
    origEndMs: Date.parse(load.assignment.plannedEnd),
    moved: false,
  }
  drag = edge ? { kind: 'resize', edge, ...base } : { kind: 'move', ...base }
  armGesture(e, edge ? 'ew-resize' : 'grabbing')
}

function beginDropGesture(e: PointerEvent, loadId: string): void {
  const load = lb.loads.find((l) => l.id === loadId)
  e.preventDefault()
  drag = {
    kind: 'drop',
    pointerId: e.pointerId,
    loadId,
    label: load?.reference ?? loadId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    moved: false,
  }
  armGesture(e, 'grabbing')
}

/** Board-scoped: catches pointerdown on a brick's body (move) or its 7px edge
 *  handle (resize) — both are inside this component's own template. */
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || drag) return
  const target = e.target as HTMLElement
  if (target.closest('button, input, select, textarea, a')) return
  const brickEl = target.closest<HTMLElement>('[data-load]')
  if (!brickEl?.dataset.load) return
  const found = findBrick(brickEl.dataset.load)
  if (!found) return
  beginBrickGesture(e, found.load, found.laneId, brickEl.dataset.h as 'l' | 'r' | undefined)
}

function beginPairGesture(e: PointerEvent, unitKind: 'tractor' | 'trailer', unitId: string): void {
  e.preventDefault()
  const label = unitKind === 'tractor' ? (tractorsById.value.get(unitId)?.unit ?? unitId) : (trailersById.value.get(unitId)?.unit ?? unitId)
  drag = {
    kind: 'pair',
    pointerId: e.pointerId,
    unitKind,
    unitId,
    label,
    startClientX: e.clientX,
    startClientY: e.clientY,
    moved: false,
  }
  armGesture(e, 'grabbing')
}

/** Document-scoped: BacklogPanel's cards and YardChips' chips are sibling
 *  components, not descendants of the board, so only a document-level
 *  listener can see their pointerdown — same reach the mockup's single
 *  global handler had. */
function onDocumentPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || drag) return
  const target = e.target as HTMLElement
  const card = target.closest<HTMLElement>('[data-bid]')
  if (card?.dataset.bid) {
    beginDropGesture(e, card.dataset.bid)
    return
  }
  const chip = target.closest<HTMLElement>('[data-res="tractor"], [data-res="trailer"]')
  if (chip?.dataset.rid && (chip.dataset.res === 'tractor' || chip.dataset.res === 'trailer')) {
    beginPairGesture(e, chip.dataset.res, chip.dataset.rid)
  }
}

function onPointerMove(e: PointerEvent): void {
  const d = drag
  if (!d || e.pointerId !== d.pointerId) return
  const dx = e.clientX - d.startClientX
  const dy = e.clientY - d.startClientY
  if (!d.moved && Math.hypot(dx, dy) >= CLICK_PX) d.moved = true
  if (!d.moved) {
    ghost.value = null
    return
  }

  if (d.kind === 'resize') {
    const p = proposeResize(d.origStartMs, d.origEndMs, dx, d.edge, cfg.value)
    const span = p ? brickSpan(p.startMs, p.endMs, cfg.value) : null
    ghost.value = p && span ? { laneId: d.originLaneId, x: span.x, w: span.w, label: d.load.reference, sub: timeSub(p.startMs, p.endMs), blocked: false } : null
    return
  }
  if (d.kind === 'move') {
    const p = proposeMove(d.origStartMs, d.origEndMs, dx, cfg.value)
    const span = brickSpan(p.startMs, p.endMs, cfg.value)
    const targetLaneId = laneAtY(e.clientY, measureLaneRects())
    ghost.value =
      span && targetLaneId
        ? { laneId: targetLaneId, x: span.x, w: span.w, label: d.load.reference, sub: timeSub(p.startMs, p.endMs), blocked: !driverIdOfLane(targetLaneId) }
        : null
    return
  }
  if (d.kind === 'pair') {
    const targetLaneId = laneAtY(e.clientY, measureLaneRects())
    if (!targetLaneId) {
      ghost.value = null
      return
    }
    const driverId = driverIdOfLane(targetLaneId)
    const driverName = driverId ? (driversById.value.get(driverId)?.name ?? null) : null
    const w = 160
    const xPx = e.clientX - trackOriginX(targetLaneId) - w / 2
    ghost.value = { laneId: targetLaneId, x: Math.max(0, xPx), w, label: d.label, sub: driverName ? `Pair to ${driverName}` : 'No driver on this lane', blocked: !driverId }
    return
  }
  // drop
  const targetLaneId = laneAtY(e.clientY, measureLaneRects())
  if (!targetLaneId) {
    ghost.value = null
    return
  }
  const xPx = e.clientX - trackOriginX(targetLaneId)
  const at = proposeDrop(xPx, cfg.value)
  const x = timeToX(at, cfg.value)
  ghost.value = x === null ? null : { laneId: targetLaneId, x, w: cfg.value.pxPerHour * 4, label: d.label, sub: `Available ${fmtClock(at, ck.tz)}`, blocked: !driverIdOfLane(targetLaneId) }
}

function onPointerUp(e: PointerEvent): void {
  const d = drag
  if (!d || e.pointerId !== d.pointerId) return
  endGesture()

  if (!d.moved) {
    // A plain click: bricks and dropped backlog cards open the drawer for
    // their load. A yard chip has no load to open — a click on it is a no-op.
    if (d.kind === 'drop') emit('open', d.loadId)
    else if (d.kind === 'move' || d.kind === 'resize') emit('open', d.load.id)
    return
  }
  const dx = e.clientX - d.startClientX

  if (d.kind === 'resize') {
    const p = proposeResize(d.origStartMs, d.origEndMs, dx, d.edge, cfg.value)
    if (!p) return // would invert or over-shrink the leg — no proposal to send
    const payload: { loadId: string; assignmentId: string; plannedEnd?: number; availableAt?: number } = {
      loadId: d.load.id,
      assignmentId: d.load.assignment!.id,
    }
    if (d.edge === 'r') payload.plannedEnd = p.endMs
    else payload.availableAt = p.startMs
    emit('gesture-resize', payload)
    return
  }
  if (d.kind === 'move') {
    const targetLaneId = laneAtY(e.clientY, measureLaneRects())
    if (!targetLaneId) return // outside every lane — cancel, not guess
    const driverId = driverIdOfLane(targetLaneId)
    if (!driverId) return
    const p = proposeMove(d.origStartMs, d.origEndMs, dx, cfg.value)
    emit('gesture-move', { loadId: d.load.id, assignmentId: d.load.assignment!.id, driverId, availableAt: p.startMs })
    return
  }
  if (d.kind === 'pair') {
    const targetLaneId = laneAtY(e.clientY, measureLaneRects())
    if (!targetLaneId) return // outside every lane — cancel, not guess
    const driverId = driverIdOfLane(targetLaneId)
    if (!driverId) return
    if (d.unitKind === 'tractor') emit('gesture-pair', { driverId, tractorId: d.unitId })
    else emit('gesture-pair', { driverId, trailerId: d.unitId })
    return
  }
  // drop
  const targetLaneId = laneAtY(e.clientY, measureLaneRects())
  if (!targetLaneId) return
  const driverId = driverIdOfLane(targetLaneId)
  if (!driverId) return
  const xPx = e.clientX - trackOriginX(targetLaneId)
  emit('gesture-drop', { loadId: d.loadId, driverId, availableAt: proposeDrop(xPx, cfg.value) })
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  endGesture()
})
</script>

<template>
  <div ref="boardRootEl" class="ck-board overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" @pointerdown="onPointerDown">
    <div class="overflow-x-auto" data-testid="board-scroll">
      <div class="relative min-w-max">
        <div class="sticky top-0 z-30 flex border-b border-line bg-surface-2">
          <div class="sticky left-0 z-40 flex shrink-0 items-end justify-between border-r border-line bg-surface-2 p-2.5" :style="{ width: `${LANE_W}px` }">
            <span class="text-[11px] font-bold uppercase tracking-widest text-ink-3">{{ cornerLabel }}</span>
            <span class="font-mono text-[10px] text-ink-3">HOS &amp; DOT</span>
          </div>
          <TimeRulerX :cfg="cfg" :now-ms="nowMs" />
        </div>

        <div class="relative">
          <template v-for="row in renderRows" :key="row.lane.id">
            <div
              v-if="carrierHeaderByLaneId.has(row.lane.id)"
              class="sticky left-0 z-10 border-b border-line bg-surface-2/80 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-ink-3"
              :data-carrier-group="carrierHeaderByLaneId.get(row.lane.id)!.id"
            >
              {{ carrierHeaderByLaneId.get(row.lane.id)!.name }} <span class="text-ink-3/70">({{ carrierHeaderByLaneId.get(row.lane.id)!.count }})</span>
            </div>
            <div
              :ref="(el) => setLaneRowEl(row.lane.id, el)"
              class="flex border-b border-line/60 transition hover:bg-surface-2/40"
              :class="row.spotLane ? 'ring-1 ring-inset ring-spot' : ''"
              :data-lane="row.lane.id"
            >
            <div class="sticky left-0 z-20 shrink-0 border-r border-line bg-surface-2 p-2.5" :style="{ width: `${LANE_W}px` }">
              <LaneHeadDriver
                v-if="row.lane.kind === 'driver'"
                :lane="row.lane"
                :tractor="row.tractor"
                :trailer="row.trailer"
                :now-ms="nowMs"
                :tz="ck.tz"
                :planned-drive-min="row.plannedDrive"
                :last-ping="pingByDriver.get(row.lane.id) ?? null"
                @open="emit('openDriver', $event)"
              />
              <LaneHeadCarrier v-else-if="row.lane.kind === 'brokered'" :lane="row.lane" :now-ms="nowMs" />
              <LaneHeadUnit v-else :lane="row.lane" :driver-name="row.driverName" :now-ms="nowMs" />
            </div>
            <div
              :ref="(el) => setTrackEl(row.lane.id, el)"
              class="relative shrink-0"
              :style="{ width: `${width}px`, height: 'var(--row-h)' }"
              :data-track="row.lane.id"
            >
              <div v-for="g in grid" :key="g.x" class="pointer-events-none absolute inset-y-0 border-l" :class="g.sep ? 'border-line-strong' : 'border-line/40'" :style="{ left: `${g.x}px` }" />
              <DeadheadLine v-for="c in row.dh" :key="c.toLoadId" :conn="c" :cents-per-mi="centsPerMi" />
              <template v-for="b in row.bricks" :key="b.load.id">
                <LegBrick
                  :load="b.load"
                  v-bind="b.p"
                  :tz="ck.tz"
                  :now-ms="nowMs"
                  :break-plan="ck.breakPlanByLoadId[b.load.id]"
                  :fuel-plan="ck.fuelPlanByLoadId[b.load.id]"
                  :detention="detentionByLoadId.get(b.load.id)"
                  @open="emit('open', $event)"
                  @hover="(id, el) => emit('hover', id, el)"
                  @open-agent="emit('open-agent', $event)"
                />
                <div
                  v-if="!isDone(b.load) && !b.p.brokered"
                  class="absolute z-[6] w-[7px] cursor-ew-resize after:absolute after:left-1/2 after:top-1/2 after:h-[40%] after:w-[2px] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-ink after:opacity-0 after:content-[''] after:transition-opacity hover:after:opacity-50"
                  :style="{ left: `${Math.round(b.p.x)}px`, top: 'var(--brick-top)', height: 'var(--brick-h)' }"
                  data-h="l"
                  :data-load="b.load.id"
                />
                <div
                  v-if="!isDone(b.load) && !b.p.brokered"
                  class="absolute z-[6] w-[7px] cursor-ew-resize after:absolute after:left-1/2 after:top-1/2 after:h-[40%] after:w-[2px] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-ink after:opacity-0 after:content-[''] after:transition-opacity hover:after:opacity-50"
                  :style="{ left: `${Math.round(b.p.x + b.p.w - 7)}px`, top: 'var(--brick-top)', height: 'var(--brick-h)' }"
                  data-h="r"
                  :data-load="b.load.id"
                />
              </template>
              <DragGhost v-if="ghost && ghost.laneId === row.lane.id" :x="ghost.x" :w="ghost.w" :label="ghost.label" :sub="ghost.sub" :blocked="ghost.blocked" />
            </div>
          </div>
          </template>
          <NowLine v-if="nowX !== null" :x="LANE_W + nowX" />
          <div v-if="!rows.length" class="p-8 text-center text-xs text-ink-3">No lanes yet — import drivers to light up the board.</div>
        </div>
      </div>
    </div>
  </div>
</template>
