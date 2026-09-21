import { defineStore } from 'pinia'
import {
  createAssignment,
  fetchDetention,
  pairDriver,
  planAssignment,
  type BreakPlanEntry,
  type CreateAssignmentBody,
  type FuelPlanBody,
  type Lock,
  type PairingBody,
  type PlanBody,
  type PlanConflict,
  type PlanEconomics,
  type PlanPlan,
  type PlanResult,
  type RoutePoi,
  type LocationRequestRow,
  type LoadLock,
  requestDriverLocation,
  fetchLocationRequests,
  type StopDetention,
  fetchRoutePois,
} from '../lib/api'
import { pickupDeadlineMs } from '../lib/board/urgency'
import { addDaysYmd, wallYmd, windowRange, type CockpitConfig } from '../lib/cockpit/geometry'
import { hosGate, projectLanes, type CockpitLane, type GroupBy, type HosGate } from '../lib/cockpit/lanes'
import { extractApiErrorMessage } from '../lib/errors'
import { subscribe } from '../lib/realtime'
import { useLoadLocksStore } from './loadLocks'
import { useLocksStore } from './locks'
import { useLoadboardStore, type BoardLoad } from './loadboard'

// Cockpit UI state only. Data lives in the loadboard/fleet/tracking/economics
// stores; this store owns the window, grouping, filters, selection, the
// activity feed and toasts, and projects the loadboard data into lanes.
/** The views the cockpit shell actually renders. Money and Compliance are NOT
 *  here on purpose: those screens are the untouched light-mode legacy views and
 *  would render white-on-near-black inside the cockpit, so they stay reachable
 *  from the sidebar (/money, /fleet) until their own dark pass lands. Market
 *  and Fuel & IFTA arrive with S4. */
export type CockpitViewKey = 'board' | 'radar'
export type BrickFilter = 'all' | 'in_progress' | 'haz' | 'conflict' | 'tendered'
export type ActivityKind = 'move' | 'plan' | 'conflict' | 'hook' | 'feed' | 'lock' | 'message'

export interface ActivityItem {
  id: number
  kind: ActivityKind
  title: string
  sub: string
  loadId: string | null
  at: number
  read: boolean
}
export interface Toast {
  id: number
  kind: ActivityKind
  title: string
  sub: string
  loadId: string | null
}

/** The dry-run / 422 verdict, shaped to feed `PlanVerdictModal` directly
 *  (structurally identical to its own exported `PlanVerdict` — declared here
 *  rather than imported from the .vue file so this store's type surface
 *  doesn't reach into a component). `economics` is coerced to `null` when the
 *  server omits it (an unpriced load): absent, not `PlanEconomics`, and the
 *  modal renders "—" for exactly that reason — see api.ts's PlanResult and
 *  the C1 defect class it documents.
 *
 *  T3 Break and Rest Planning, Task 9: `breakPlan`/`breakPlanKnown` carried
 *  through verbatim (never defaulted here, unlike `economics` above) so the
 *  modal's own "unknown vs. known-empty vs. known-with-entries" distinction
 *  is driven by what the server actually said, not by a value this store
 *  invented. A response missing either field (pre-T3 fixture) leaves both
 *  `undefined`, which `PlanVerdictModal` already treats as "unknown". */
export interface CockpitVerdict {
  feasible: boolean
  conflicts: PlanConflict[]
  plan: PlanPlan
  economics: PlanEconomics | null
  breakPlan?: BreakPlanEntry[]
  breakPlanKnown?: boolean
  /** T4 fuel plan, carried through to PlanVerdictModal's Fuel panel. Present
   *  for the same reason breakPlan is: the modal renders from `verdict`, so a
   *  field the server sends but this mapping drops can never reach the
   *  screen — the panel silently shows its "unavailable" state forever while
   *  every unit test passes, because the specs hand the prop in directly. */
  fuel?: FuelPlanBody
}

function toVerdict(data: PlanResult): CockpitVerdict {
  return {
    feasible: data.feasible ?? false,
    conflicts: data.conflicts,
    plan: data.plan,
    economics: (data.economics ?? null) as PlanEconomics | null,
    breakPlan: data.breakPlan,
    breakPlanKnown: data.breakPlanKnown,
    fuel: data.fuel,
  }
}

/** Pull an HTTP status off an axios-shaped rejection without importing axios
 *  — mirrors the cast loadboard.ts's `assign()` already uses for the same
 *  reason. Any other shape of failure (network error, a plain Error) yields
 *  undefined, which the caller treats as "not a 409, not a 422". */
function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | undefined)?.response?.status
}

/** The 409's holder, if the server sent one — see api.ts's `acquireLock`
 *  doc: `error.response.data.lock` travels intact so the toast can name
 *  them. */
function lockFromError(error: unknown): Lock | null {
  return (error as { response?: { data?: { lock?: Lock } } } | undefined)?.response?.data?.lock ?? null
}

/** Not every 409 is a lane lock. `PATCH /drivers/:id/pairing` also answers 409
 *  when the unit is already another driver's default, and that body carries a
 *  plain `error` message naming them — no `lock`. Telling a dispatcher "held by
 *  another dispatcher" when the truth is "that tractor is Tyrone's" sends them
 *  looking for a colleague who isn't the problem, so the lock toast is reserved
 *  for the one code the server actually uses for it. */
function isLaneLockError(error: unknown): boolean {
  return (error as { response?: { data?: { error?: string } } } | undefined)?.response?.data?.error === 'ENTITY_ALREADY_LOCKED'
}

/** The server's own explanation, read structurally the way `lockFromError` and
 *  `verdictFromError` read their bodies. `extractApiErrorMessage` needs a real
 *  `AxiosError` instance and silently degrades to "Something went wrong" for
 *  anything else — which is exactly the useless message this path exists to
 *  avoid. Falls back to it only when the server sent no `error` field. */
function serverMessage(error: unknown): string {
  const msg = (error as { response?: { data?: { error?: string } } } | undefined)?.response?.data?.error
  return msg ?? extractApiErrorMessage(error)
}

/** The 422's fresh engine verdict, if the server sent one. */
function verdictFromError(error: unknown): PlanResult | null {
  return (error as { response?: { data?: PlanResult } } | undefined)?.response?.data ?? null
}

/** px/hour per horizon so 1/3/5/7 days each fit a wide screen sensibly. */
export const DAY_PRESETS: Record<number, number> = { 1: 60, 3: 22, 5: 14, 7: 11 }
export const DAY_START_HOUR = 6
export const DAY_END_HOUR = 24
export const DEFAULT_TZ = 'America/Chicago'
const MAX_ACTIVITY = 60
const MAX_TOASTS = 4

/** The label a human uses for a load in the activity feed: the board's own
 *  number, then the reference, then a short id — never the whole UUID. */
function refOf(lb: ReturnType<typeof useLoadboardStore>, loadId: string): string {
  const l = lb.loads.find((x) => x.id === loadId)
  return l?.boardLoadNo || l?.reference || '#' + loadId.slice(0, 8)
}

interface CockpitState {
  tz: string
  day0: string
  days: number
  pxPerHour: number
  view: CockpitViewKey
  groupBy: GroupBy
  filter: BrickFilter
  equip: string
  search: string
  selectedLoadId: string | null
  /** T2 "Map as Navigation", Task 5: a one-shot "centre on this load now"
   *  request for FleetMap, set by `focusOnMap` and consumed (cleared) by
   *  FleetMap once it has acted on it. Deliberately NOT the same field as
   *  `selectedLoadId` — selection changes on every board click and on every
   *  map marker click, and must never itself re-centre the map; this field
   *  exists only to carry the explicit "Show on map" gesture across the
   *  view switch without fighting FleetMap's own once-only `fitBounds` (see
   *  FleetMap.vue's `boundsFitted` guard). */
  mapFocusLoadId: string | null
  activity: ActivityItem[]
  toasts: Toast[]
  nextId: number
  /** The dry-run/422 verdict currently shown in `PlanVerdictModal`, or null
   *  when it's closed. Set only by the gesture pipeline (`runGesture`) —
   *  never mutated directly by a component, so Cancel/Force always go
   *  through `cancelVerdict`/`forceVerdict` and can't drift from
   *  `pendingForce`. */
  verdict: CockpitVerdict | null
  /** The retry the modal's Force button re-invokes — `() => call(false,
   *  true)`, wrapped so a forced commit still refreshes/toasts/re-opens the
   *  modal like any other commit. Lives in state (not a module-local) for
   *  the same reason locks.ts's heartbeatId does: a fresh Pinia instance per
   *  test must never see a previous test's leftover callback. */
  pendingForce: (() => Promise<void>) | null
  /** F4: the load whose lock an open verdict is holding. `settleLoadLock`
   *  now releases ONE load (the store can hold several), and
   *  `cancelVerdict` — the one settle point with no load id in scope — reads
   *  it from here. Null for a verdict opened with no load at all
   *  (`pairUnit`'s error path, which never takes a load lock). */
  pendingLockLoadId: string | null
  /** T3 Break and Rest Planning, Task 8 (Ruling 7): the map's own source for
   *  break points, keyed by load id — deliberately NOT `verdict` above.
   *  `verdict` belongs to PlanVerdictModal and is nulled the instant that
   *  modal closes (`cancelVerdict`/`forceVerdict`), but a break marker must
   *  keep showing on the map after a dispatcher dismisses the modal that
   *  first surfaced it. Populated by `applyBreakPlan` from EVERY verdict
   *  body that carries one — a dry-run preview, a blocked 422, and a
   *  written commit alike — and never cleared by this store; an entry here
   *  is a "last known" fact about a load, not tied to any one gesture's
   *  lifetime. `known: false` mirrors the server's `breakPlanKnown: false`
   *  (the driver's HOS was never imported — a break point derived from
   *  assumed hours is fiction, Global Constraint 1); mapData.ts's
   *  `breakMarkers` reads this map and renders nothing for that case, and
   *  nothing at all for a load with no entry here (never evaluated this
   *  session). */
  breakPlanByLoadId: Record<string, { entries: BreakPlanEntry[]; known: boolean }>
  /** T4 Fuel and Stops, Task 9: the fuel-chip's own copy of `breakPlanByLoadId`
   *  above — same wire-twin object (`FuelPlanBody` is already shaped exactly
   *  as the store wants it, so unlike `breakPlanByLoadId` this needs no
   *  reshaping into a wrapper), same population points (`applyFuelPlan`,
   *  filed from every verdict body alongside `applyBreakPlan`), same lifetime
   *  (never cleared when the modal closes — a load's last-known burn/advice
   *  is a fact, not tied to one gesture). `known: false` mirrors the
   *  server's `fuel.known: false` (no mpg on file — a saving estimated off
   *  assumed burn is fiction, Global Constraint 1); `advice: null` means the
   *  engine found nowhere cheaper worth naming. `LegBrick`'s chip renders
   *  for neither case, and renders nothing at all for a load with no entry
   *  here — one absence rule, on both surfaces. */
  fuelPlanByLoadId: Record<string, FuelPlanBody>
  /** T5 Dwell and Detention, Task 6: the org-wide detention scan (GET
   *  /dispatcher/detention). Unlike `breakPlanByLoadId`/`fuelPlanByLoadId`
   *  above, this is not filed from verdict responses — it's its own
   *  independent fetch (`loadDetention`), so it carries its own
   *  loading/error rather than piggybacking on the gesture pipeline's.
   *
   *  The error state is the point of this slice, not housekeeping: an empty
   *  `items` and a failed fetch render identically to a naive consumer, but
   *  they mean opposite things — "nothing is detained" vs. "we have no idea
   *  what is detained." For a dispatch service that bills brokers off this
   *  number, collapsing the second into the first is the most expensive
   *  possible lie (Global Constraint 1). So: a failed fetch sets `error`
   *  and leaves `items` completely untouched — never reset to `[]` — so a
   *  stale-but-labelled list survives a transient failure instead of a
   *  panel silently reading "no detention anywhere." `loading` is cleared
   *  on both the success and failure path. */
  /** POIs along the route of ONE load — whichever trip the map has selected.
   *  Scoped to a single load deliberately: fetching every lane's corridor
   *  would be a lot of provider calls to draw a map nobody can read. */
  routePois: {
    loadId: string | null
    items: RoutePoi[]
    loading: boolean
    /** set when the server could not measure a corridor (no road geometry),
     *  carried verbatim so the map can say WHY it is showing nothing */
    reason: string | null
  }
  detention: { items: StopDetention[]; loading: boolean; error: string | null }
  /** Outstanding and recent "where are you?" requests, newest first. */
  locationRequests: { items: LocationRequestRow[]; asking: string | null }
  /** A4 Task 8: the Cockpit's own subscription to the shared socket
   *  (lib/realtime.ts), combining the `board_update`/`driver_status`/
   *  `load_changed` unsubscribes into one closure — same shape as
   *  loadLocks.ts's `unsubscribe`, and in state for the same reason
   *  `pendingForce` above is: a fresh Pinia instance per test must never see
   *  a previous test's leftover subscription. CockpitView used to reach the
   *  feed by watching loadboard's `lastEvent`; this replaces that watch. */
  realtimeUnsubscribe: (() => void) | null
}

export const useCockpitStore = defineStore('cockpit', {
  state: (): CockpitState => ({
    tz: DEFAULT_TZ,
    day0: wallYmd(Date.now(), DEFAULT_TZ),
    days: 3,
    pxPerHour: DAY_PRESETS[3],
    view: 'board',
    groupBy: 'driver',
    filter: 'all',
    equip: 'all',
    search: '',
    selectedLoadId: null,
    mapFocusLoadId: null,
    activity: [],
    toasts: [],
    nextId: 1,
    verdict: null,
    pendingForce: null,
    pendingLockLoadId: null,
    breakPlanByLoadId: {},
    fuelPlanByLoadId: {},
    routePois: { loadId: null, items: [], loading: false, reason: null },
    detention: { items: [], loading: false, error: null },
    locationRequests: { items: [], asking: null },
    realtimeUnsubscribe: null,
  }),

  getters: {
    config: (state): CockpitConfig => ({
      tz: state.tz,
      day0: state.day0,
      days: state.days,
      dayStartHour: DAY_START_HOUR,
      dayEndHour: DAY_END_HOUR,
      pxPerHour: state.pxPerHour,
    }),
    lanes(): CockpitLane[] {
      const lb = useLoadboardStore()
      return projectLanes(this.groupBy, lb.lanes, lb.tractors, lb.trailers, lb.loads)
    },
    /** Loads with a live blocking problem: persisted block conflicts or a projected miss.
     *  Runs on every board render, so a malformed payload (non-array alerts,
     *  missing risk map) must degrade to "no conflicts" rather than throw. */
    conflictLoadIds(): Set<string> {
      const lb = useLoadboardStore()
      const ids = new Set<string>()
      const alerts = Array.isArray(lb.alerts) ? lb.alerts : []
      for (const a of alerts) if (a.severity === 'block') ids.add(a.loadId)
      const risk = lb.riskByLoadId ?? {}
      for (const [id, sev] of Object.entries(risk)) if (sev === 'block') ids.add(id)
      return ids
    },
    backlog(): BoardLoad[] {
      const lb = useLoadboardStore()
      return lb.loads
        .filter((l) => !l.assignment && (l.status === 'open' || l.status === 'tendered'))
        .slice()
        .sort((a, b) => pickupDeadlineMs(a.pickupWindowEnd) - pickupDeadlineMs(b.pickupWindowEnd))
    },
    unreadActivity: (state): number => state.activity.filter((a) => !a.read).length,
    /** now is a parameter, not state — the strip re-reads it off its own clock. */
    hosGateAt(): (nowMs: number) => HosGate {
      return (nowMs) => hosGate(this.lanes, nowMs, this.tz)
    },
  },

  actions: {
    init(tz: string | null | undefined, nowMs = Date.now()): void {
      this.tz = tz || DEFAULT_TZ
      this.day0 = wallYmd(nowMs, this.tz)
      this.syncWindow()
    },
    /** Push the cockpit's org-day window onto the data store (whole days, so
     *  overnight legs that started yesterday are still fetched). */
    syncWindow(): void {
      const r = windowRange(this.config)
      useLoadboardStore().setWindowOverride({ from: new Date(r.fromMs).toISOString(), to: new Date(r.toMs).toISOString() })
    },
    async reload(): Promise<void> {
      this.syncWindow()
      await useLoadboardStore().load()
    },
    async setDays(days: number): Promise<void> {
      this.days = days
      this.pxPerHour = DAY_PRESETS[days] ?? this.pxPerHour
      await this.reload()
    },
    async shiftDays(n: number): Promise<void> {
      this.day0 = addDaysYmd(this.day0, n)
      await this.reload()
    },
    async goToToday(nowMs = Date.now()): Promise<void> {
      this.day0 = wallYmd(nowMs, this.tz)
      await this.reload()
    },
    setZoom(px: number): void {
      this.pxPerHour = Math.min(72, Math.max(10, Math.round(px)))
    },
    setView(v: CockpitViewKey): void {
      this.view = v
    },
    setGroupBy(g: GroupBy): void {
      this.groupBy = g
    },
    setFilter(f: BrickFilter): void {
      this.filter = f
    },
    setEquip(e: string): void {
      this.equip = e
    },
    setSearch(q: string): void {
      this.search = q
    },
    select(id: string | null): void {
      this.selectedLoadId = id
    },
    /** T2 "Map as Navigation", Task 4: what a map popup's "Show on board" (and
     *  the schematic radar's own click-to-jump, via CockpitView's `jumpTo`)
     *  both need — select the load, switch to the board view, and scroll that
     *  brick into view. Lives here, not only in CockpitView, so a popup
     *  component nested deep under FleetMap can call it directly instead of
     *  round-tripping an emitted event up through FleetMap -> RadarView ->
     *  CockpitView the way the old click-to-jump path did.
     *
     *  Touches `document`/`requestAnimationFrame` directly — an established
     *  exception in this otherwise DOM-free store, same as theme.ts's
     *  `applyTheme` call. `scrollIntoView` is called optionally: real
     *  browsers always have it, but nothing here should throw if the brick
     *  hasn't rendered yet (a fresh board reload) or in a DOM that doesn't
     *  implement it. */
    focusOnBoard(loadId: string): void {
      this.setView('board')
      this.select(loadId)
      requestAnimationFrame(() => {
        document.querySelector(`[data-load="${loadId}"]`)?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'center' })
      })
    },
    /** T2 "Map as Navigation", Task 4 (follow-up): a map popup's "Show on
     *  board" for a PARKED driver — one with no active load, which is what
     *  "parked" means (see mapData.ts's driverActivity). There is no load id
     *  to select for a driver with none, and picking "the nearest load in
     *  time" (an earlier version of this) is worse than no button at all: it
     *  sends a dispatcher to a brick that isn't theirs. This scrolls to the
     *  driver's own lane row instead (GanttBoard.vue's `data-lane="<id>"`,
     *  the row-level twin of `focusOnBoard`'s brick-level `data-load`) and
     *  deliberately leaves selection alone — nothing to select, so nothing
     *  is selected, same as the drawer's own idle state.
     *
     *  `data-lane` only exists for a row actually rendered on the board:
     *  driver-kind lanes are rendered for both the 'driver' and 'carrier'
     *  groupings (both key by driver id — see lanes.ts's projectLanes), but
     *  NOT for 'tractor'/'trailer' grouping, where rows are keyed by unit id
     *  instead and a given driver has no row of their own at all. The scroll
     *  silently no-ops in that case (same graceful-miss as `focusOnBoard`
     *  above) rather than forcing a regroup as a side effect of this click. */
    focusLaneOnBoard(driverId: string): void {
      this.setView('board')
      this.select(null)
      requestAnimationFrame(() => {
        document.querySelector(`[data-lane="${driverId}"]`)?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'center' })
      })
    },
    /** T2 "Map as Navigation", Task 5: the reverse of `focusOnBoard` — a
     *  board brick's (or the drawer's) "Show on map" jumps to the live map
     *  centred on that exact load. Switches to the radar/map view and
     *  selects the load, the same select+switch-view shape `focusOnBoard`
     *  uses for the opposite direction, plus `mapFocusLoadId`: the one-shot
     *  signal FleetMap reads to override its own once-only `fitBounds` for
     *  this one arrival, cleared by FleetMap once it has acted on it (see
     *  `clearMapFocus` below and FleetMap.vue's `sync`). Centring itself is
     *  NOT done here — this store has no notion of map bounds/projection;
     *  it only carries the request across the view switch, same division of
     *  responsibility as `select`/`setView` never touching the DOM directly
     *  except through the scroll side-effect above. */
    focusOnMap(loadId: string): void {
      this.setView('radar')
      this.select(loadId)
      this.mapFocusLoadId = loadId
    },
    /** Consumed once by FleetMap right after it acts on a pending focus
     *  request (whether it centred on the load or found nothing to centre
     *  on) — see `focusOnMap`'s doc. Never called from anywhere else: a
     *  stray second call is a no-op, same as `forceVerdict`'s guard. */
    clearMapFocus(): void {
      this.mapFocusLoadId = null
    },

    matchesFilter(l: BoardLoad): boolean {
      if (this.equip !== 'all' && l.requiredEquip !== this.equip) return false
      switch (this.filter) {
        case 'in_progress':
          return l.assignment?.status === 'in_progress' || l.status === 'in_progress'
        case 'haz':
          return !!l.hazmatClass
        case 'conflict':
          return this.conflictLoadIds.has(l.id)
        case 'tendered':
          return l.status === 'tendered'
        default:
          return true
      }
    },
    /** Spot search over the load's visible text plus its lane name. */
    matchesSearch(l: BoardLoad, laneName = ''): boolean {
      const q = this.search.trim().toLowerCase()
      if (!q) return true
      return [l.reference, l.origin, l.destination, l.commodity, l.brokerName, l.requiredEquip, laneName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    },

    pushActivity(kind: ActivityKind, title: string, sub: string, loadId: string | null = null, at = Date.now()): number {
      const id = this.nextId++
      this.activity = [{ id, kind, title, sub, loadId, at, read: false }, ...this.activity].slice(0, MAX_ACTIVITY)
      this.toasts = [...this.toasts, { id, kind, title, sub, loadId }].slice(-MAX_TOASTS)
      return id
    },
    dismissToast(id: number): void {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    },
    markAllRead(): void {
      this.activity = this.activity.map((a) => ({ ...a, read: true }))
    },

    /** Turn a realtime frame into a feed line. `connectRealtime` below
     *  subscribes directly to the shared socket (lib/realtime.ts) and calls
     *  this for each frame it wants — CockpitView no longer reaches it by
     *  watching loadboard's `lastEvent`. */
    ingestEvent(ev: { type: string; payload: Record<string, unknown> }): void {
      const p = ev.payload
      const lb = useLoadboardStore()
      const loadId = typeof p.loadId === 'string' ? p.loadId : null
      const ref = loadId ? refOf(lb, loadId) : null
      if (ev.type === 'board_update') {
        const what = p.unassigned
          ? 'unassigned'
          : p.lifecycle
            ? 'status advanced'
            : p.canceled
              ? 'canceled'
              : p.reopened
                ? 'reopened'
                : p.edited
                  ? 'edited'
                  : p.source === 'webhook'
                    ? `${Number(p.imported ?? 0)} loads pushed by webhook`
                    : 'dispatched'
        const kind: ActivityKind = p.unassigned || p.canceled ? 'conflict' : 'plan'
        this.pushActivity(kind, `${ref ?? 'Board'} ${what}`, 'live · another dispatcher or the driver app', loadId)
      } else if (ev.type === 'driver_status') {
        const lane = lb.lanes.find((l) => l.id === p.driverId)
        this.pushActivity('feed', `${lane?.name ?? 'Driver'} ${String(p.status ?? '').replace('_', ' ')}`, 'presence update', null)
      } else if (ev.type === 'load_changed') {
        // A4 Task 1's payload: { orgId, loadId, version, fields }. The
        // loadboard store (Task 6) already re-reads the changed row — this
        // only narrates it; refetching here too would be a second, redundant
        // request for data patchLoads already fetched.
        const fields = Array.isArray(p.fields) ? p.fields.filter((f): f is string => typeof f === 'string') : []
        this.pushActivity('feed', `${ref ?? 'Load'} changed`, fields.length ? fields.join(', ') : 'updated', loadId)
      }
      // driver_location frames feed the radar only — no feed noise.
    },

    /** A4 Task 8: the Cockpit's own ears on the shared socket. Everything
     *  `ingestEvent` knows how to narrate — `board_update`, `driver_status`,
     *  `load_changed` — is subscribed here directly, the same shape as
     *  loadboard.ts's/tracking.ts's own `connectRealtime`, rather than by
     *  watching another store's state. */
    connectRealtime(): void {
      if (this.realtimeUnsubscribe) return
      const offBoard = subscribe('board_update', (frame) => this.ingestEvent({ type: frame.type, payload: frame }))
      const offDriver = subscribe('driver_status', (frame) => this.ingestEvent({ type: frame.type, payload: frame }))
      const offChanged = subscribe('load_changed', (frame) => this.ingestEvent({ type: frame.type, payload: frame }))
      this.realtimeUnsubscribe = () => { offBoard(); offDriver(); offChanged() }
    },
    disconnectRealtime(): void {
      this.realtimeUnsubscribe?.()
      this.realtimeUnsubscribe = null
    },

    // -------------------------------------------------------------------
    // Cockpit S2b Task 4: the gesture pipeline.
    //
    // Every board gesture — move, resize, drop — funnels through
    // `runGesture` so they share one acquire→dry-run→commit→refresh path
    // and cannot drift apart. Engine-authoritative throughout: nothing here
    // writes to loadboard state directly: a write's *only* visible effect
    // on the board is `refreshBoard()` re-pulling the server's truth after a
    // 200. A blocked dry-run never reaches the try/catch below — `dryRun`
    // requests always resolve 200 with `feasible` in the body (it evaluates,
    // never writes); only a *commit* attempt can itself come back blocked
    // (a fresh 422, discovered between the preview and the write) or
    // lock-refused (409), which is what the catch handles.
    // -------------------------------------------------------------------

    /** The one place a gesture (move/resize/drop) turns into a request.
     *  `call` is supplied by the caller and re-invoked with the four
     *  (dryRun, force) combinations the pipeline needs — the caller owns
     *  which endpoint/body that means, this owns the sequencing. `loadId` is
     *  carried alongside purely so every response along the way can be
     *  filed into `breakPlanByLoadId` (Ruling 7) — the server's own body
     *  names no load id (it identifies the assignment/driver, not the load),
     *  so this is the only place that fact is known. */
    async runGesture(laneId: string, loadId: string, call: (dryRun: boolean, force: boolean) => Promise<PlanResult>): Promise<void> {
      const locks = useLocksStore()
      if (!(await locks.hold(laneId))) {
        this.toastLockRefused(locks.heldBy(laneId))
        return
      }
      // A2 Load Locks, Task 9: the load lock beside the lane lock — a load
      // someone is editing on Their Board is not moved under their cursor.
      const loadLocks = useLoadLocksStore()
      if (!(await loadLocks.hold(loadId))) {
        locks.release()
        this.toastLoadLockRefused(loadLocks.heldBy(loadId))
        return
      }
      try {
        const preview = await call(true, false)
        this.applyBreakPlan(loadId, preview)
        this.applyFuelPlan(loadId, preview)
        if (!preview.feasible) {
          // Fix round 1/2: the load lock is held for as long as the gesture
          // can still write. A blocked preview is not settled — it's
          // pending a dispatcher decision — so this call must NOT release
          // it. `commitGesture` itself is the one place that settles it
          // (see its own doc + `settleLoadLock`) once a retried commit —
          // Force's, or a retry OF that retry — actually resolves.
          this.openVerdict(preview, () => this.commitGesture(loadId, call, true), loadId)
          return
        }
        await this.commitGesture(loadId, call, false)
        this.settleLoadLock(loadId)
      } catch (error) {
        await this.handleGestureError(error, loadId, () => this.commitGesture(loadId, call, true))
        this.settleLoadLock(loadId)
      }
    },

    /** The actual write (dryRun:false). Shared by the first-try commit and
     *  by Force, so a forced write gets the identical refresh/toast/re-block
     *  handling as an ordinary one — Force is not a separate code path.
     *
     *  Fix round 2: also THE single place every write attempt — the first
     *  try, a Force retry, or a retry of a retry (a commit whose own 422
     *  reopens yet another verdict, via `handleGestureError`'s 422 branch
     *  below) — settles the load lock through, via the trailing
     *  `settleLoadLock()` call. That one call, gated on `this.verdict ===
     *  null`, replaces having to individually wrap every retry closure this
     *  file constructs: whatever chain of blocks/retries a gesture goes
     *  through, the lock only ever lets go once nothing is left open. The
     *  explicit `settleLoadLock()` calls in `runGesture` (after this same
     *  call on the feasible path, and in its outer catch) are deliberately
     *  redundant with this one — idempotent, and the only settle points at
     *  all for the two branches (a 409, a plain error) that never call
     *  `commitGesture` again. */
    async commitGesture(loadId: string, call: (dryRun: boolean, force: boolean) => Promise<PlanResult>, force: boolean): Promise<void> {
      try {
        const data = await call(false, force)
        this.applyBreakPlan(loadId, data)
        this.applyFuelPlan(loadId, data)
        this.verdict = null
        this.pendingForce = null
        this.pendingLockLoadId = null
        await this.refreshBoard()
        this.pushActivity('plan', `${refOf(useLoadboardStore(), loadId)} planned`, 'Plan committed', loadId)
      } catch (error) {
        await this.handleGestureError(error, loadId, () => this.commitGesture(loadId, call, true))
      }
      this.settleLoadLock(loadId)
    },

    /** 409 (someone else holds the lane): toast naming the holder, then
     *  refresh — the board may already be stale by the time the lock was
     *  lost. 422 (a fresh block found at write time): open the verdict
     *  modal, same as a blocked dry-run. Anything else: a plain error toast,
     *  never a silent failure. `loadId` is `null` for the one caller with no
     *  load at all (`pairUnit` — a yard-chip pairing isn't a plan/assign
     *  gesture and its error body never carries a break plan). */
    async handleGestureError(error: unknown, loadId: string | null, retry: () => Promise<void>): Promise<void> {
      const status = statusOf(error)
      if (status === 409 && isLaneLockError(error)) {
        this.toastLockRefused(lockFromError(error))
        this.verdict = null
        this.pendingForce = null
        this.pendingLockLoadId = null
        await this.refreshBoard()
      } else if (status === 409) {
        // A non-lock 409: a unit already paired elsewhere, a load already
        // assigned, a concurrent commit. The server's own message names the
        // actual obstacle, so show it rather than guessing.
        this.verdict = null
        this.pendingForce = null
        this.pendingLockLoadId = null
        this.pushActivity('conflict', 'Change refused', serverMessage(error), null)
        await this.refreshBoard()
      } else if (status === 422) {
        const data = verdictFromError(error)
        if (data) {
          if (loadId) this.applyBreakPlan(loadId, data)
          if (loadId) this.applyFuelPlan(loadId, data)
          this.openVerdict(data, retry, loadId)
        } else this.pushActivity('conflict', 'Update failed', extractApiErrorMessage(error), null)
      } else {
        this.pushActivity('conflict', 'Update failed', extractApiErrorMessage(error), null)
      }
    },

    /** T3 Break and Rest Planning, Task 8 (Ruling 7): file one verdict
     *  response's break plan into `breakPlanByLoadId`, immutably (a fresh
     *  object, never a mutation of the existing map — this codebase's
     *  standing convention, see `pushActivity`). A response with no
     *  `breakPlan`/`breakPlanKnown` at all (pre-T3 fixture, or a non-plan
     *  endpoint's body shape) is left untouched rather than recorded as
     *  "known and empty" — silence here means exactly what it means
     *  everywhere else in this file: nothing to say yet, not a fact. */
    applyBreakPlan(loadId: string, data: PlanResult): void {
      if (data.breakPlan === undefined || data.breakPlanKnown === undefined) return
      this.breakPlanByLoadId = { ...this.breakPlanByLoadId, [loadId]: { entries: data.breakPlan, known: data.breakPlanKnown } }
    },

    /** T4 Fuel and Stops, Task 9: `applyBreakPlan`'s fuel sibling — files one
     *  verdict response's fuel plan into `fuelPlanByLoadId`, immutably. A
     *  response with no `fuel` at all (pre-T4 fixture, or a non-plan
     *  endpoint's body shape) is left untouched rather than recorded as
     *  "known and empty" — same silence-means-nothing-to-say rule as
     *  `applyBreakPlan` above. */
    applyFuelPlan(loadId: string, data: PlanResult): void {
      if (data.fuel === undefined) return
      this.fuelPlanByLoadId = { ...this.fuelPlanByLoadId, [loadId]: data.fuel }
    },

    /** Show the blocked-verdict modal and remember what Force should
     *  re-invoke. `retry` is `() => commitGesture(call, true)`, never the
     *  raw `call` — Force must get the same refresh/toast handling as any
     *  other commit. */
    openVerdict(data: PlanResult, retry: () => Promise<void>, loadId: string | null = null): void {
      this.verdict = toVerdict(data)
      this.pendingForce = retry
      // F4: whose lock this verdict is holding open. `cancelVerdict` is the
      // one settle point with no load id of its own to work from.
      this.pendingLockLoadId = loadId
    },

    /** Fix round 2: the ONE rule for releasing the load lock a gesture took
     *  — release it only when no verdict is pending (`this.verdict ===
     *  null`). Called wherever a gesture's write settles: at the end of
     *  `commitGesture` itself (every write attempt — first try, a Force
     *  retry, or a retry of a retry — flows through there, so that single
     *  call site covers all of them), redundantly after the feasible-path
     *  commit and in the outer catch in `runGesture` (the only real settle
     *  points for the two `handleGestureError` branches — a 409, a plain
     *  error — that never call `commitGesture` again), and from
     *  `cancelVerdict`.
     *
     *  This replaces round 1's per-path reasoning, which missed a case the
     *  reviewer found on the ORDINARY path: a feasible dry-run whose commit
     *  itself 422s. `handleGestureError`'s 422 branch calls `openVerdict`
     *  again there — a FRESH verdict, discovered at write time — and
     *  `commitGesture` still resolves normally afterwards, so a caller that
     *  released unconditionally right after `await commitGesture(...)` let
     *  the lock go while that fresh verdict sat open. Checking `verdict ===
     *  null` at every settle point, instead of hand-reasoning which of
     *  those points is "really" a settle, closes every such case at once —
     *  including a 422 discovered on a FORCED retry re-opening yet another
     *  verdict, which round 1 explicitly left open. */
    settleLoadLock(loadId: string | null): void {
      if (this.verdict === null && loadId !== null) useLoadLocksStore().release(loadId)
    },

    /** Cancel: close the modal without writing anything. Nulls `verdict`
     *  FIRST, then calls `settleLoadLock` — the only path that ends a
     *  blocked verdict without ever calling `commitGesture` again, so it's
     *  the one place besides a settling commit that can let the load lock
     *  go. Safe even for a verdict opened with no load at all (`pairUnit`'s
     *  error path, which never takes a load lock) — `settleLoadLock` calls
     *  through to `release()`, which is itself idempotent. */
    cancelVerdict(): void {
      const loadId = this.pendingLockLoadId
      this.verdict = null
      this.pendingForce = null
      this.pendingLockLoadId = null
      this.settleLoadLock(loadId)
    },

    /** Force: re-run the pending commit with force:true. A no-op if nothing
     *  is pending (e.g. a stray second click after the modal already
     *  closed) rather than throwing. */
    async forceVerdict(): Promise<void> {
      const retry = this.pendingForce
      this.verdict = null
      this.pendingForce = null
      // NOT pendingLockLoadId: the retry is a commit, and the commit's own
      // settle releases that load once nothing is left open.
      if (retry) await retry()
    },

    toastLockRefused(lock: Lock | null): void {
      this.pushActivity('lock', 'Lane locked', lock ? `Held by ${lock.name} — try again once they're done` : 'Held by another dispatcher', null)
    },

    /** `toastLockRefused`'s load-lock sibling (A2 Load Locks, Task 9): a load
     *  someone is editing on Their Board, named the same way. */
    toastLoadLockRefused(lock: LoadLock | null): void {
      this.pushActivity('lock', 'Load locked', `${lock?.by ?? 'Someone'} is editing this load on Their Board`, null)
    },

    /** Everything a commit can change: the loadboard itself plus the four
     *  auxiliary feeds a plan/assign can move (kpis, alerts, yard, risk).
     *  This is the ONLY place gesture state reaches the board — see the
     *  engine-authoritative note above. */
    async refreshBoard(): Promise<void> {
      const lb = useLoadboardStore()
      await Promise.all([this.reload(), lb.loadAlerts(), lb.loadKpis(), lb.loadYard(), lb.loadRisk()])
    },

    /** Move or resize an existing leg — both are PATCH /assignments/:id/plan,
     *  differing only in which fields of the body they set (CockpitView
     *  supplies `driverId`+`availableAt` for a move, `plannedEnd`[+`availableAt`]
     *  for a resize), so one action covers both gestures. `loadId` is not
     *  part of the PATCH body (the assignment id already names the leg) —
     *  it's threaded through only for `applyBreakPlan` (see `runGesture`). */
    async planLeg(assignmentId: string, laneId: string, loadId: string, body: Pick<PlanBody, 'driverId' | 'availableAt' | 'plannedEnd'>): Promise<void> {
      await this.runGesture(laneId, loadId, (dryRun, force) => planAssignment(assignmentId, { ...body, dryRun, force }))
    },

    /** Drop a backlog load onto a driver lane — POST /assignments. The
     *  caller (CockpitView) resolves `tractorId`/`trailerId` from the
     *  target driver's current pairing before calling this; it must never
     *  be called with equipment the driver doesn't have. */
    async dropLoad(laneId: string, body: Omit<CreateAssignmentBody, 'dryRun' | 'force'>): Promise<void> {
      await this.runGesture(laneId, body.loadId, (dryRun, force) => createAssignment({ ...body, dryRun, force }))
    },

    /** Drag a yard chip (tractor or trailer) onto a driver lane — PATCH
     *  /drivers/:id/pairing. Not a plan/assign gesture: the endpoint is a
     *  single write with no dry-run/verdict body, so this doesn't go through
     *  `runGesture` — but it reuses that pipeline's lock-acquire step and its
     *  `handleGestureError`/`toastLockRefused` handling verbatim, so a 409
     *  (the lane is held, or the unit is already someone else's default)
     *  produces the identical "held by X" toast as every other gesture. Does
     *  NOT replan the lane's existing legs — same as the server, deliberately
     *  (see dispatcherDrivers.ts's route comment). */
    async pairUnit(driverId: string, body: PairingBody): Promise<void> {
      const locks = useLocksStore()
      if (!(await locks.hold(driverId))) {
        this.toastLockRefused(locks.heldBy(driverId))
        return
      }
      try {
        await pairDriver(driverId, body)
        await this.refreshBoard()
        this.pushActivity('hook', 'Equipment paired', 'Yard chip hooked to the lane', null)
      } catch (error) {
        await this.handleGestureError(error, null, () => this.pairUnit(driverId, body))
      }
    },

    /** GET /dispatcher/detention?sinceHours=N — T5 Dwell and Detention,
     *  Task 6. See the `detention` field's doc for why the failure path is
     *  the point of this action: `items` is reassigned ONLY on success; the
     *  catch branch touches `loading`/`error` and nothing else, so a
     *  previously loaded list survives a transient failure intact instead
     *  of being blanked into "nothing is detained." Uses `serverMessage`
     *  (this file's existing axios-shaped-rejection reader, see
     *  `handleGestureError`) rather than importing axios directly. */
    /** Load the POIs along one load's route. Clears to empty on failure but
     *  keeps `reason` null vs. a server-stated reason distinct: an empty list
     *  with no reason means "this route has no stops we could find", an empty
     *  list WITH one means "we could not measure this corridor at all". The
     *  map says which. */
    /** Ask a driver where they are. Their phone prompts; nothing arrives here
     *  until they press approve. `asking` marks the in-flight driver so the
     *  button can disable rather than firing a second prompt at them. */
    async askDriverLocation(driverId: string): Promise<void> {
      if (this.locationRequests.asking) return
      this.locationRequests.asking = driverId
      try {
        await requestDriverLocation(driverId)
        this.locationRequests.items = await fetchLocationRequests()
      } catch {
        // Nothing to show but the unchanged list: a failed ASK is not a denial,
        // and must not be recorded as one.
      } finally {
        this.locationRequests.asking = null
      }
    },

    async refreshLocationRequests(): Promise<void> {
      try {
        this.locationRequests.items = await fetchLocationRequests()
      } catch {
        // keep whatever we had; a failed refresh is not an empty inbox
      }
    },

    /** Fetch the break + fuel plan for a load that is ALREADY assigned,
     *  without changing anything about it.
     *
     *  Clicking a route on the map asks "what is the plan for this run" — and
     *  until this existed those numbers only happened to be in the store if a
     *  dispatcher had dragged that leg at some point, because they arrive on a
     *  plan verdict. The map card therefore read "break plan not loaded" for
     *  every run on a freshly opened board: honest, and useless.
     *
     *  `dryRun: true` is the same evaluate-and-price-only path the drag
     *  preview uses — the server never writes. Deliberately NOT routed through
     *  `runGesture`: that acquires a lane lock, and reading a plan is not a
     *  gesture. Taking a lock because someone clicked a line would block the
     *  dispatcher actually editing that lane. */
    async loadPlanFor(loadId: string): Promise<void> {
      // Already have both halves: the plan does not change while the map sits
      // open, and re-asking would spend a routing call per click.
      if (this.breakPlanByLoadId[loadId] && this.fuelPlanByLoadId[loadId]) return
      const lb = useLoadboardStore()
      const assignmentId = lb.loads.find((l) => l.id === loadId)?.assignment?.id
      if (!assignmentId) return
      try {
        const data = await planAssignment(assignmentId, { dryRun: true })
        this.applyBreakPlan(loadId, data)
        this.applyFuelPlan(loadId, data)
      } catch (error) {
        // A 422 is a BLOCKED verdict, and it still carries the plan — a leg
        // that violates hours is exactly the one whose breaks matter most.
        const data = verdictFromError(error)
        if (data) {
          this.applyBreakPlan(loadId, data)
          this.applyFuelPlan(loadId, data)
          return
        }
        // Anything else stays silent: the card already says "not loaded", and
        // that remains true. A map click must never raise a plan error toast.
      }
    },

    async loadRoutePois(loadId: string): Promise<void> {
      if (this.routePois.loadId === loadId && this.routePois.items.length > 0) return
      this.routePois = { loadId, items: [], loading: true, reason: null }
      try {
        const res = await fetchRoutePois(loadId)
        // A late response for a load the user has already navigated away from
        // must not overwrite the current one.
        if (this.routePois.loadId !== loadId) return
        this.routePois = { loadId, items: res.pois, loading: false, reason: res.routed ? null : res.reason }
      } catch {
        if (this.routePois.loadId !== loadId) return
        this.routePois = { loadId, items: [], loading: false, reason: 'Could not load stops along this route' }
      }
    },

    async loadDetention(sinceHours: number): Promise<void> {
      this.detention = { ...this.detention, loading: true, error: null }
      try {
        const items = await fetchDetention(sinceHours)
        this.detention = { items, loading: false, error: null }
      } catch (error) {
        this.detention = { ...this.detention, loading: false, error: serverMessage(error) }
      }
    },
  },
})
