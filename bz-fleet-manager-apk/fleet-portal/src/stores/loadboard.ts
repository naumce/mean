import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { BoardConfig } from '../lib/board/geometry'
import { OPEN, subscribe } from '../lib/realtime'
import { useCarriersStore } from './carriers'

// The Control Tower board store: driver lanes + the org's loads, plus the
// suggest/assign flow against the dispatch engine. Mirrors stores/board.ts
// (the Trip-based board) in shape and conventions.

export interface LoadboardLane {
  id: string
  name: string
  status: string
  // Lane-header data (all real): HOS clocks, window utilization, revenue.
  hosKnown?: boolean
  driveRemainingMin?: number | null
  windowRemainingMin?: number | null
  cycleRemainingMin?: number | null
  minutesSinceBreak?: number | null
  /** When real clock data last arrived (import/ELD); null = age unknown. */
  hosImportedAt?: string | null
  utilizationPct?: number
  revenueCents?: number
  // Cockpit header: endorsement, medical clock, pairing, live equipment, last ping.
  hazmatEndorsed?: boolean
  medicalCertExpiresAt?: string | null
  defaultTractorId?: string | null
  defaultTrailerId?: string | null
  currentTractorId?: string | null
  currentTrailerId?: string | null
  lastLat?: number | null
  lastLng?: number | null
  lastLocationAt?: string | null
  /** Nearest gazetteer city to the last ping (server-computed). */
  lastCity?: string | null
  // T1 Carrier Layer: the client company this driver's dispatch belongs to.
  // Always both-real-or-both-null — never one set without the other — so a
  // driver with no carrier is unambiguous, not a partial record.
  carrierId?: string | null
  carrierName?: string | null
}

export interface BoardTractor {
  id: string
  unit: string
  make: string | null
  cab: string
  status: string
  inspectionExpiresAt: string | null
  registrationExpiresAt: string | null
  nextServiceAt: string | null
  currentDriverId: string | null
}

export interface BoardTrailer {
  id: string
  unit: string
  type: string
  length: string | null
  status: string
  features: string | null
  inspectionExpiresAt: string | null
  registrationExpiresAt: string | null
  nextServiceAt: string | null
  currentDriverId: string | null
  /** The driver currently HAULING this trailer — set only when it's on an
   *  active (assigned/tendered/in_progress) assignment right now, never
   *  merely from a driver's default pairing. Distinct from `currentDriverId`
   *  above, which folds both cases together for its own existing consumers
   *  (lib/cockpit/lanes.ts's HOOKED/DROPPED pill, GanttBoard.vue's lane
   *  driver-name lookup) — this field exists because `positionedTrailers`
   *  (lib/cockpit/mapData.ts) needs the narrower question: a trailer's
   *  lastLat/lastLng/lastSeenAt are stamped only on leg completion, never on
   *  pickup, so a trailer that's merely someone's default pairing (but not
   *  actually attached right now) still has an honest stored position, while
   *  one on an active assignment does not. Optional so literals built before
   *  this field existed keep compiling; `== null` treats missing the same as
   *  explicit `null` ("not currently hooked"). */
  activeDriverId?: string | null
  // T2 "Map as Navigation", Task 7: the trailer's last known GPS fix. Written
  // together, never partially — a trailer that has never been positioned has
  // all three null. Optional (like LoadboardLane's lastLat/lastLng above) so
  // existing literals built before this task keep compiling.
  lastLat?: number | null
  lastLng?: number | null
  lastSeenAt?: string | null
}

export interface BoardStop {
  sequence: number
  type: string
  address: string
  lat: number | null
  lng: number | null
  dwellMin: number
  windowStart: string | null
  windowEnd: string | null
}

export interface LoadAssignment {
  id: string
  driverId: string
  tractorId?: string | null
  trailerId?: string | null
  /** assigned | tendered | in_progress | completed */
  status?: string
  plannedStart: string
  plannedEnd: string
  /** Legacy: Assignment.marginCents, an Int @default(0) that cannot tell
   *  "never priced" from "break-even". Read by the legacy /loadboard screen
   *  only — cockpit surfaces must use `economics`. */
  marginCents: number
  /** The committed Rate snapshot, or null when the load was never priced.
   *  Null means absent, and absent must render as "—", never as $0. */
  economics?: { estCostCents: number; marginCents: number } | null
  deadheadMi?: number
  /** Empty-drive lead time (planning speed) — drawn as the brick's hatched prefix. */
  deadheadMin?: number
  loadedMi?: number
  savedMi?: number
  startedAt?: string | null
  completedAt?: string | null
}

export interface TrendBucket {
  loads: number
  revenueCents: number
  marginCents: number
  loadedMi: number
  deadheadMi: number
  totalMi: number
  deadheadPct: number
}

export interface FleetKpis {
  loads: Record<string, number>
  drivers: { total: number; hosKnown: number }
  /** Completed work, this week vs last — the direction of the operation. */
  trend?: { thisWeek: TrendBucket; lastWeek: TrendBucket }
  economics: {
    committedLoads: number
    revenueCents: number
    estCostCents: number
    marginCents: number
    avgMarginPct: number
    loadedMi: number
    deadheadMi: number
    deadheadPct: number
    ratePerLoadedMiCents: number
    deadheadCostCents: number
    emptyMilesSavedMi: number
  }
}

export interface BoardLoad {
  id: string
  reference: string
  status: string
  requiredEquip: string
  hazmatClass: string | null
  revenueCents: number
  stopCount: number
  /** Provider road geometry as [lng, lat] pairs. Null when none is cached —
   *  the map then draws a curved arc, which is an ESTIMATE of the path, not
   *  the road. FleetMap labels the difference. */
  routeGeometry?: [number, number][] | null
  origin: string
  destination: string
  /** First pickup's appointment window — the cover-by clock for the backlog. */
  pickupWindowStart?: string | null
  pickupWindowEnd?: string | null
  commodity?: string | null
  weightLbs?: number | null
  brokerName?: string | null
  unNumber?: string | null
  stops?: BoardStop[]
  assignment: LoadAssignment | null
  /** Plan A3 (spec §8.1): the brokered half of the record. A load whose
   *  carrier is lined up (open) or booked (assigned…) carries its carrier. */
  carrierId?: string | null
  carrierName?: string | null
  carrierMc?: string | null
  customerName?: string | null
  updateText?: string | null
  apptText?: string | null
  shipDate?: string | null
  boardLoadNo?: string | null
  version?: number
  brokered?: boolean
  attention?: string[]
  deliveryWindowEnd?: string | null
  // Night Shift on the Board (Task 6): the switch, its policy, and the pill
  // the brick and the inspect panel paint (spec §6.1/§17.1). Optional for the
  // same reason as the broker board's twin in lib/api.ts — fixtures across
  // this board's own spec files predate them. Cockpit's `agentLine` is a
  // plain string here (dispatcherLoadboard.ts's own projection), unlike the
  // broker board's `{ text, atMs }` shape.
  agentEnabled?: boolean
  agentPolicyId?: string | null
  agentPill?: string
  agentLine?: string | null
}

export interface AssignConflict {
  kind: string
  severity: 'block' | 'warn'
  detail: string
}

export interface AssignPlan {
  proposedStart: number
  proposedEnd: number
  deadheadMi: number
  loadedMi: number
  driveMin: number
  onDutyMin: number
  needsBreak: boolean
}

export interface AssignEconomics {
  revenueCents: number
  totalMi: number
  deadheadMi: number
  loadedMi: number
  estCostCents: number
  marginCents: number
  marginPct: number
  ratePerLoadedMiCents: number
  ratePerTotalMiCents: number
}

export interface AssignPreview {
  feasible: boolean
  conflicts: AssignConflict[]
  plan: AssignPlan
  economics: AssignEconomics
}

export interface SuggestRow {
  driverId: string
  driverName: string | null
  feasible: boolean
  score: number | null
  deadheadMi: number
  loadedMi: number
  etaMs: number
  marginCents: number
  marginPct: number
  blockedReason?: string
  warnings: string[]
}

export interface SuggestResult {
  loadId: string
  requiredEquip: string
  tractorId: string | null
  trailerId: string | null
  candidates: SuggestRow[]
  note?: string
}

export interface AssignPayload {
  loadId: string
  driverId: string
  tractorId: string
  trailerId: string
  availableAt?: string
  force?: boolean
}

export interface DispatchAlert {
  id: string
  kind: string
  severity: 'block' | 'warn'
  detail: string
  createdAt: string
  loadId: string
  loadReference: string
  loadStatus: string
  driverId: string
  driverName: string | null
}

export interface RiskRow {
  /** null for a covered brokered load: it runs on the carrier's truck, not ours. */
  assignmentId: string | null
  loadId: string
  ref: string
  /** null for a covered brokered load: no driver of ours is on it. */
  driverId: string | null
  driverName: string | null
  /** the carrier running a brokered load; null/absent for our own assignments. */
  carrierName?: string | null
  kind: 'late_start' | 'behind_schedule'
  severity: 'warn' | 'block'
  detail: string
  deadline: string
  projectedArrival: string
  slackMin: number
}

export interface NextLoadRow {
  loadId: string
  reference: string
  requiredEquip: string
  origin: string
  destination: string
  revenueCents: number
  tractorId?: string
  trailerId?: string
  feasible: boolean
  score: number | null
  deadheadMi: number
  marginCents: number
  marginPct: number
  etaMs: number
  blockedReason?: string
  warnings: string[]
}

export interface DriverNext {
  driver: {
    id: string
    name: string
    status: string
    hazmatEndorsed: boolean
    hosKnown: boolean
    hos: { driveRemainingMin: number; windowRemainingMin: number; cycleRemainingMin: number; minutesSinceBreak: number; importedAt?: string | null } | null
    currentAssignment: {
      id: string
      loadId: string
      loadReference: string
      plannedStart: string
      plannedEnd: string
      destination: string | null
    } | null
    availableAt: string
  }
  nextLoads: NextLoadRow[]
}

export interface YardTractor {
  id: string
  unit: string
  make: string | null
  status: string
}
export interface YardTrailer {
  id: string
  unit: string
  type: string
  length: string | null
  status: string
}
export interface YardDriver {
  id: string
  name: string
  status: string
  hosKnown: boolean
  driveRemainingMin: number | null
}
export interface YardState {
  tractors: YardTractor[]
  trailers: YardTrailer[]
  drivers: YardDriver[]
}

interface LoadboardState {
  fromDate: Date
  toDate: Date
  dayStartHour: number
  dayEndHour: number
  /** Zoom: pixels per hour; board width = pxPerHour × hours × days, so a
   *  3-day window scrolls instead of squishing. */
  pxPerHour: number
  lanes: LoadboardLane[]
  loads: BoardLoad[]
  loading: boolean
  error: string | null
  suggest: SuggestResult | null
  suggestLoading: boolean
  alerts: DispatchAlert[]
  kpis: FleetKpis | null
  driverNext: DriverNext | null
  yard: YardState | null
  risks: RiskRow[]
  tractors: BoardTractor[]
  trailers: BoardTrailer[]
  /** When set (cockpit), load() asks for exactly this ISO range instead of the UTC-day window. */
  windowOverride: { from: string; to: string } | null
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000)
}

// Kept here so existing importers (`stores/tracking.ts` historically, tests)
// don't have to change: the function itself now lives in `lib/wsUrl.ts`,
// which both this store and `lib/realtime.ts` can import without forming a
// cycle (see that file's doc comment).
export { boardWsUrl } from '../lib/wsUrl'

let unsubscribers: Array<() => void> = []

/** Ids collected from `load_changed` frames since the last flush. A paste
 *  across thirty cells is thirty frames; the board owes the dispatcher one
 *  request, not thirty. */
const pendingIds = new Set<string>()
let coalesceTimer: number | null = null
/** Long enough to swallow a paste's burst, short enough that a single edit
 *  still feels immediate. */
const COALESCE_MS = 50
/** Debounce for the auxiliary feeds a patched load can move: alerts, KPIs
 *  and the risk feed. Separate from `coalesceTimer` above — that one decides
 *  WHEN to re-read the changed rows, this one decides when to recompute the
 *  summaries derived from them. */
let derivedTimer: number | null = null
const DERIVED_MS = 3_000

// L10: dispatcherLoadboard.ts's GET orders loads by `createdAt asc`, but that
// field never reaches the wire (BoardLoad carries no such property) — so a
// brand new row has no value the client can sort by directly. `patched` (the
// patch response, itself still `createdAt`-ordered for exactly the ids that
// were asked for) is the one honest source of relative order this store has
// for a row it did not know about: any OTHER id in that same response that
// IS already on the board anchors where the new one belongs, since the two
// came back in their true relative order. A created id with no such anchor
// in its own response (nothing else in the burst was already known) carries
// no ordering information at all, so it falls back to the append this
// replaces — no worse than before, but never the common case.
function mergeOrdered(kept: BoardLoad[], added: BoardLoad[], patched: BoardLoad[]): BoardLoad[] {
  if (added.length === 0) return kept
  const remaining = new Map(added.map((l) => [l.id, l]))
  const result = [...kept]
  let insertAt = 0
  for (const l of patched) {
    const keptPos = result.findIndex((k) => k.id === l.id)
    if (keptPos !== -1) { insertAt = keptPos + 1; continue }
    const row = remaining.get(l.id)
    if (!row) continue
    result.splice(insertAt, 0, row)
    remaining.delete(l.id)
    insertAt += 1
  }
  return [...result, ...remaining.values()]
}

export const useLoadboardStore = defineStore('loadboard', {
  state: (): LoadboardState => ({
    fromDate: utcMidnight(new Date()),
    toDate: utcMidnight(new Date()),
    dayStartHour: 6,
    dayEndHour: 20,
    pxPerHour: 86,
    lanes: [],
    loads: [],
    loading: false,
    error: null,
    suggest: null,
    suggestLoading: false,
    alerts: [],
    kpis: null,
    driverNext: null,
    yard: null,
    risks: [],
    tractors: [],
    trailers: [],
    windowOverride: null,
  }),

  getters: {
    config: (state): BoardConfig => {
      const days =
        Math.round((utcMidnight(state.toDate).getTime() - utcMidnight(state.fromDate).getTime()) / 86400000) + 1
      return {
        fromDate: state.fromDate,
        toDate: state.toDate,
        dayStartHour: state.dayStartHour,
        dayEndHour: state.dayEndHour,
        boardWidthPx: state.pxPerHour * (state.dayEndHour - state.dayStartHour) * days,
      }
    },
    // Plan A3: a covered brokered load (assigned/in_progress/delivered, no
    // Assignment of ours) is not backlog — `!l.assignment` alone stopped
    // meaning "needs a truck" once that population joined `loads`. Same rule
    // as stores/cockpit.ts's `backlog` getter and LoadboardView.vue's
    // `visibleBacklog`. Nothing on the portal reads this getter today (the
    // view derives its own `visibleBacklog` from the filtered/sorted load
    // list instead) — fixed anyway so it isn't a trap for whoever wires it up.
    backlog: (state): BoardLoad[] => state.loads.filter((l) => !l.assignment && (l.status === 'open' || l.status === 'tendered')),
    /** Worst live risk per load, for brick outlines (block wins over warn). */
    riskByLoadId: (state): Record<string, 'warn' | 'block'> => {
      const map: Record<string, 'warn' | 'block'> = {}
      for (const r of state.risks) {
        if (map[r.loadId] !== 'block') map[r.loadId] = r.severity
      }
      return map
    },
    /** Worst live risk per driver (block wins over warn) — same reduction as
     *  `riskByLoadId`, keyed by driver instead of load, for surfaces that
     *  identify a unit by who's driving it (the fleet map's truck markers). */
    riskByDriverId: (state): Record<string, 'warn' | 'block'> => {
      const map: Record<string, 'warn' | 'block'> = {}
      for (const r of state.risks) {
        if (!r.driverId) continue // brokered load: no driver of ours to blame it on
        if (map[r.driverId] !== 'block') map[r.driverId] = r.severity
      }
      return map
    },
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const from = this.windowOverride?.from ?? utcMidnight(this.fromDate).toISOString()
        const to = this.windowOverride?.to ?? addDays(utcMidnight(this.toDate), 1).toISOString()
        // T1 Carrier Layer, Task 8: read fresh off the carriers store on
        // every load — never cached on this store — so shiftWindow/setSpan/
        // assign/etc. all inherit the active carrier filter for free.
        // Omitted entirely (not sent as null/'') when there's no selection:
        // the backend's carrierId is `.optional()`, and a present-but-empty
        // param is exactly the shape that would tempt a "carrierId === ''
        // means unfiltered" special case server-side instead of the filter
        // simply not being there.
        const carrierId = useCarriersStore().selectedCarrierId
        const { data } = await api.get<{
          lanes: LoadboardLane[]
          loads: BoardLoad[]
          tractors?: BoardTractor[]
          trailers?: BoardTrailer[]
        }>(
          '/dispatcher/loadboard',
          { params: { from, to, ...(carrierId ? { carrierId } : {}) } },
        )
        this.lanes = data.lanes
        this.loads = data.loads
        this.tractors = data.tractors ?? []
        this.trailers = data.trailers ?? []
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.loading = false
      }
    },

    /** Cockpit windows are org-timezone days; the legacy board keeps UTC days. */
    setWindowOverride(range: { from: string; to: string } | null): void {
      this.windowOverride = range
    },

    /** Zoom the time axis (mockup range 34–120 px/h). Pure view state. */
    setZoom(pxPerHour: number): void {
      this.pxPerHour = Math.min(120, Math.max(34, Math.round(pxPerHour)))
    },

    /** Move the visible window by n days (negative = back) and reload. */
    async shiftWindow(days: number): Promise<void> {
      this.fromDate = addDays(this.fromDate, days)
      this.toDate = addDays(this.toDate, days)
      await this.load()
    },

    /** Jump back to a window anchored at today, keeping the current span. */
    async goToToday(): Promise<void> {
      const span = Math.round(
        (utcMidnight(this.toDate).getTime() - utcMidnight(this.fromDate).getTime()) / 86400000,
      )
      this.fromDate = utcMidnight(new Date())
      this.toDate = addDays(this.fromDate, span)
      await this.load()
    },

    /** Set the window length in days (1 = day view, 3 = 3-day), anchored at fromDate. */
    async setSpan(days: number): Promise<void> {
      this.toDate = addDays(utcMidnight(this.fromDate), Math.max(0, days - 1))
      await this.load()
    },

    /** Rank the org's drivers for a load; also yields the pool-picked equipment. */
    async suggestFor(loadId: string): Promise<SuggestResult | null> {
      this.suggestLoading = true
      this.error = null
      try {
        const { data } = await api.get<SuggestResult>('/dispatcher/suggest', { params: { loadId } })
        this.suggest = data
        return data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return null
      } finally {
        this.suggestLoading = false
      }
    },

    clearSuggest(): void {
      this.suggest = null
    },

    /** Evaluate + price a candidate assignment without committing (drop preview). */
    async preview(payload: AssignPayload): Promise<AssignPreview | null> {
      this.error = null
      try {
        const { data } = await api.post<AssignPreview>('/dispatcher/assignments', {
          ...payload,
          dryRun: true,
        })
        return data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return null
      }
    },

    /** Commit the assignment; refreshes the board + alerts on success. */
    async assign(payload: AssignPayload): Promise<boolean> {
      this.error = null
      try {
        await api.post('/dispatcher/assignments', payload)
        await Promise.all([this.load(), this.loadAlerts(), this.loadKpis(), this.loadYard(), this.loadRisk()])
        return true
      } catch (error) {
        // A commit-time 422 carries the fresh engine verdict (conflicts[]),
        // not an `error` field — surface the actual blockers, not axios noise.
        const verdict = (error as { response?: { data?: { conflicts?: AssignConflict[] } } })?.response?.data
        const blocks = verdict?.conflicts?.filter((c) => c.severity === 'block') ?? []
        this.error = blocks.length
          ? `Blocked: ${blocks.map((c) => c.detail).join('; ')}`
          : extractApiErrorMessage(error)
        return false
      }
    },

    /** The exceptions feed: conflicts persisted at commit time. */
    async loadAlerts(): Promise<void> {
      try {
        const { data } = await api.get<{ alerts: DispatchAlert[] }>('/dispatcher/alerts', {
          params: { limit: 20 },
        })
        this.alerts = data.alerts
      } catch {
        // The feed is auxiliary — a failure here must not break the board.
      }
    },

    /** Driver detail + best-next-loads (screen 6). */
    async loadDriverNext(driverId: string): Promise<void> {
      this.error = null
      try {
        const { data } = await api.get<DriverNext>(`/dispatcher/drivers/${driverId}/next`)
        this.driverNext = data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    clearDriverNext(): void {
      this.driverNext = null
    },

    /** Live late-risk feed: recomputed server-side on every call, so it also
     *  changes with the clock — the view re-polls it on a timer. */
    async loadRisk(): Promise<void> {
      try {
        const { data } = await api.get<{ risks: RiskRow[] }>('/dispatcher/risk')
        this.risks = data.risks
      } catch {
        // auxiliary — never break the board
      }
    },

    /** Available-now resources (auxiliary, like alerts). T1 Carrier Layer,
     *  Task 8 (follow-up): the chips a dispatcher actually drags come from
     *  here (YardChips.vue renders `this.yard`, not `this.tractors`/
     *  `this.trailers`), so this needs the same carrierId wiring as
     *  `load()` — read fresh off the carriers store, omitted entirely
     *  (never sent as null/'') when there's no selection. */
    async loadYard(): Promise<void> {
      try {
        const carrierId = useCarriersStore().selectedCarrierId
        const { data } = await api.get<YardState>('/dispatcher/yard', {
          params: carrierId ? { carrierId } : {},
        })
        this.yard = data
      } catch {
        // auxiliary — never break the board
      }
    },

    /** Fleet KPIs for the bar above the board (auxiliary, like alerts). */
    async loadKpis(): Promise<void> {
      try {
        const { data } = await api.get<FleetKpis>('/dispatcher/kpis')
        this.kpis = data
      } catch {
        // auxiliary — never break the board
      }
    },

    /** Lifecycle: start (in_progress) or deliver (completed). Forward-only;
     *  completion frees the driver but never refunds driven hours. */
    async setAssignmentStatus(assignmentId: string, status: 'in_progress' | 'completed'): Promise<boolean> {
      this.error = null
      try {
        await api.post(`/dispatcher/assignments/${assignmentId}/status`, { status })
        await Promise.all([this.load(), this.loadKpis(), this.loadRisk()])
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      }
    },

    /** Cancel a load (broker pulled it). Open/tendered only — the server
     *  refuses while a driver is committed. */
    async cancelLoad(loadId: string): Promise<boolean> {
      this.error = null
      try {
        await api.post(`/dispatcher/loads/${loadId}/cancel`)
        await Promise.all([this.load(), this.loadKpis()])
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      }
    },

    /** Undo for cancelLoad: canceled -> back into the backlog. */
    async reopenLoad(loadId: string): Promise<boolean> {
      this.error = null
      try {
        await api.post(`/dispatcher/loads/${loadId}/reopen`)
        await Promise.all([this.load(), this.loadKpis()])
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      }
    },

    /** Cancel an assignment: load returns to the backlog, HOS restored. */
    async unassign(assignmentId: string): Promise<boolean> {
      this.error = null
      try {
        await api.delete(`/dispatcher/assignments/${assignmentId}`)
        await Promise.all([this.load(), this.loadAlerts(), this.loadKpis(), this.loadYard(), this.loadRisk()])
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      }
    },

    /** Live board: the shared socket (lib/realtime.ts) delivers frames; this
     *  store only says which ones it wants. Reconnection, retry and the `$open`
     *  replay all live in the singleton now — there is nothing left here to get
     *  out of step with the other stores. */
    connectRealtime(): void {
      if (unsubscribers.length) return
      unsubscribers = [
        subscribe('board_update', () => {
          this.load()
          this.loadAlerts()
          this.loadKpis()
          this.loadYard()
          this.loadRisk()
        }),
        subscribe('driver_status', (frame) => {
          const driverId = typeof frame.driverId === 'string' ? frame.driverId : null
          const status = typeof frame.status === 'string' ? frame.status : null
          if (!driverId || !status) return
          // Lane dot only — no reload needed for a presence change.
          this.lanes = this.lanes.map((lane) => (lane.id === driverId ? { ...lane, status } : lane))
        }),
        // Plan A4, Task 6: re-read only the loads that actually moved instead
        // of the whole board. Bursts (a paste across many cells, an import)
        // are coalesced into one request — see `pendingIds`/`coalesceTimer`.
        subscribe('load_changed', (frame) => {
          const loadId = typeof frame.loadId === 'string' ? frame.loadId : null
          const version = typeof frame.version === 'number' ? frame.version : null
          if (!loadId) return
          // C1 (A4-R13): the delete route emits this frame with the load's
          // PRE-delete version — exactly what an up-to-date client already
          // has, since a deleted row has no newer version to send. The echo
          // guard just below exists to skip our OWN write landing back on
          // the wire; a removal is never that, so it is exempt from it —
          // never judged by a version comparison it cannot possibly satisfy.
          const removed = Array.isArray(frame.fields) && frame.fields.includes('deleted')
          // Our own write already put the new row on screen with this version (or a
          // newer one). Re-reading it would repaint a cell the dispatcher is still
          // looking at, for no new information.
          const known = this.loads.find((l) => l.id === loadId)
          if (!removed && known && version !== null && typeof known.version === 'number' && known.version >= version) return
          pendingIds.add(loadId)
          if (coalesceTimer == null) {
            coalesceTimer = window.setTimeout(() => {
              coalesceTimer = null
              const ids = [...pendingIds]
              pendingIds.clear()
              void this.patchLoads(ids)
            }, COALESCE_MS)
          }
        }),
        // F7 (lib/realtime.ts): a socket that dropped and came back missed
        // whatever changed while it was down. There is no id list to patch a
        // gap like that — the only honest recovery is a full re-read.
        subscribe(OPEN, () => {
          void this.load()
          void this.refreshDerived()
        }),
      ]
    },

    disconnectRealtime(): void {
      for (const off of unsubscribers) off()
      unsubscribers = []
    },

    /**
     * Re-read exactly these loads and swap them into `loads` in place.
     *
     * An id that comes back absent is a load that left this board — it moved out
     * of the window, was archived, was deleted, or the carrier filter no longer
     * matches it. It is removed, not kept stale. Anything else would leave a
     * brick on the board that the server says is not there.
     *
     * An id this store did NOT already know is a load that appeared elsewhere
     * (L10) — merged in via `mergeOrdered`, not appended after everything
     * already on screen; see that function's own comment for why.
     */
    async patchLoads(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      const from = this.windowOverride?.from ?? utcMidnight(this.fromDate).toISOString()
      const to = this.windowOverride?.to ?? addDays(utcMidnight(this.toDate), 1).toISOString()
      const carrierId = useCarriersStore().selectedCarrierId
      try {
        const { data } = await api.get<{ loads: BoardLoad[] }>('/dispatcher/loadboard', {
          params: { from, to, ids: ids.join(','), ...(carrierId ? { carrierId } : {}) },
        })
        const fresh = new Map(data.loads.map((l) => [l.id, l]))
        const asked = new Set(ids)
        const kept = this.loads
          .filter((l) => !asked.has(l.id) || fresh.has(l.id))
          .map((l) => fresh.get(l.id) ?? l)
        const added = data.loads.filter((l) => !this.loads.some((existing) => existing.id === l.id))
        // L10: a load a colleague created belongs where the server's own
        // order puts it, not appended after everything already on screen.
        this.loads = mergeOrdered(kept, added, data.loads)
      } catch (error) {
        // A failed patch must not leave the board wrong: fall back to the full
        // read, which is the behaviour this whole path replaced.
        this.error = extractApiErrorMessage(error)
        await this.load()
      }
      void this.refreshDerived()
    },

    /** The numbers that are computed from loads rather than rendered from them:
     *  alerts, KPIs and the risk feed. Trailing-debounced, because they are a
     *  summary — a second late is invisible, a request per keystroke is not.
     *  `loadYard()` is deliberately not in here: yard is tractors and
     *  trailers, which no load write touches. */
    async refreshDerived(): Promise<void> {
      if (derivedTimer != null) return
      derivedTimer = window.setTimeout(() => {
        derivedTimer = null
        void Promise.all([this.loadAlerts(), this.loadKpis(), this.loadRisk()])
      }, DERIVED_MS)
    },
  },
})
