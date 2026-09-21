import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'
import { REFRESH_STORAGE_KEY, TOKEN_STORAGE_KEY } from './constants'

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001/api'

export const api = axios.create({ baseURL: API_BASE_URL })

// Exported standalone so it can be unit-tested without reaching into axios'
// internal interceptor registry. Reads the token straight from localStorage
// (rather than the Pinia store) to avoid a store <-> client import cycle —
// the auth store already keeps localStorage as the source of truth.
export function attachAuthToken(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (token) {
    const headers = config.headers ?? new AxiosHeaders()
    headers.set('Authorization', `Bearer ${token}`)
    config.headers = headers
  }
  return config
}

api.interceptors.request.use(attachAuthToken)

// One refresh in flight at a time: parallel 401s must share the rotation —
// the server single-uses refresh tokens, so a second concurrent refresh with
// the same token would be rejected and force a logout.
let refreshInFlight: Promise<string | null> | null = null

async function tryRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(REFRESH_STORAGE_KEY)
  if (!refreshToken) return null
  refreshInFlight ??= axios
    .post<{ token: string; refreshToken: string }>(`${API_BASE_URL}/auth/refresh`, { refreshToken })
    .then(({ data }) => {
      localStorage.setItem(TOKEN_STORAGE_KEY, data.token)
      localStorage.setItem(REFRESH_STORAGE_KEY, data.refreshToken)
      return data.token
    })
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      // Access tokens live 15 minutes; a silent refresh + retry keeps a
      // dispatcher's session alive instead of hard-logging them out mid-drag.
      const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined
      const isAuthCall = String(original?.url ?? '').includes('/auth/')
      if (original && !original._retried && !isAuthCall) {
        original._retried = true
        const fresh = await tryRefresh()
        if (fresh) {
          // Keep the store in sync (lazy import — static would be a cycle).
          try {
            const { useAuthStore } = await import('../stores/auth')
            useAuthStore().token = fresh
          } catch {
            // pinia not initialized (tests) — localStorage is already updated
          }
          return api(original)
        }
      }
      const { useAuthStore } = await import('../stores/auth')
      try {
        useAuthStore().logout()
      } catch {
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        localStorage.removeItem(REFRESH_STORAGE_KEY)
      }
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)

// ---------------------------------------------------------------------------
// Cockpit S2b: lane locks + the plan/assign client (Task 2).
//
// The rest of this file is generic axios plumbing; everything below is the
// typed client for the Control Tower's lock protocol and gesture pipeline —
// pulled into named functions (rather than left as inline api.get/post calls
// the way the older stores do it) because stores/locks.ts (the heartbeat) and
// stores/cockpit.ts's shared acquire->dry-run->commit pipeline both need the
// identical request shape, and a 409's `lock` payload must reach the caller
// completely intact for the toast to name the holder.
// ---------------------------------------------------------------------------

/** A pessimistic lane hold. Mirrors fleet-backend's lib/locks.ts `Lock`
 *  field-for-field — this IS that object, JSON round-tripped over
 *  GET/POST/DELETE /dispatcher/locks and the `lane_lock` socket frame. */
export interface Lock {
  laneId: string
  orgId: string | null
  dispatcherId: string
  name: string
  since: number
  expiresAt: number
}

export interface PlanConflict {
  kind: string
  severity: 'block' | 'warn'
  detail: string
}

export interface PlanPlan {
  proposedStart: number
  proposedEnd: number
  deadheadMi: number
  loadedMi: number
  driveMin: number
  onDutyMin: number
  needsBreak: boolean
}

export interface PlanEconomics {
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

/** T3 Break and Rest Planning, Task 7: one reachable rest stop, ranked by
 *  detour from a break point. Mirrors fleet-backend's domain/dispatch's
 *  `RestOption` field-for-field — this IS that object, JSON round-tripped,
 *  same "wire twin" convention `Lock` above already uses. `spaces: null`
 *  means the facility's capacity is unknown — render "—", never coerce to
 *  `0` (a real, surveyed zero and "we don't know" are different facts). */
export interface RestOption {
  id: string
  name: string
  kind: string
  lat: number
  lng: number
  spaces: number | null
  detourMi: number
  offRouteMi: number
}

/** T3 Break and Rest Planning, Task 7: one mandatory HOS break point on a
 *  plan, and what the org's rest-stop registry knows about it — mirrors
 *  fleet-backend's restCoverage.ts `BreakPlanEntry` field-for-field.
 *  `hasCoverage: false` is NOT "no rest stops near here" — it is "the org
 *  has told us nothing about this corridor" (Global Constraint 1: absent
 *  must never render as measured). `precision: 'estimated'` means the leg
 *  had no real road-mileage router behind it; the UI prefixes those with
 *  `≈` rather than presenting a guess as a survey. */
export interface BreakPlanEntry {
  atMs: number
  at: { lat: number; lng: number } | null
  precision: 'routed' | 'estimated'
  options: RestOption[]
  hasCoverage: boolean
}

/** T4 Fuel and Stops, Task 8: the server's diesel-burn + buy-advice + IFTA
 *  attribution for a plan, attached to every verdict body (dry-run, 422, and
 *  a written commit alike) — same wire-twin convention as `BreakPlanEntry`
 *  above. `mpgUsed: null` means the carrier has no mpg on file; render
 *  unknown, never `0` (Global Constraint 1: absent must never render as
 *  measured). */
export interface FuelBurn {
  deadheadGal: number
  loadedGal: number
  totalGal: number
  mpgUsed: number | null
}

/** `null` means the engine found nowhere cheaper to recommend — never a
 *  synthesized "buy here anyway" guess. `savingCents` is integer cents. */
export interface FuelAdvice {
  atSequence: number
  atLabel: string
  state: string
  gallons: number
  centsPerGal: number
  vsLabel: string
  vsCentsPerGal: number
  savingCents: number
}

export interface FuelIftaByState {
  state: string
  gallons: number
}

/** `unattributedGal` is gallons the engine could not tie to any state because
 *  it had no route geometry for that leg — Global Constraint 6 forbids
 *  smearing it proportionally across `byState`, since this number feeds a
 *  state tax filing. `complete: false` means `unattributedGal` MUST be shown;
 *  hiding it would make a partial attribution look like a complete one. */
export interface FuelIfta {
  byState: FuelIftaByState[]
  unattributedGal: number
  complete: boolean
}

/** `known: false` means the engine could not estimate burn at all (e.g. no
 *  mpg for the carrier) — render "fuel estimate unavailable", not zero
 *  gallons and not a $0 saving. */
export interface FuelPlanBody {
  burn: FuelBurn
  advice: FuelAdvice | null
  ifta: FuelIfta
  known: boolean
}

export interface BoardAssignment {
  id: string
  loadId: string
  driverId: string
  tractorId: string | null
  trailerId: string | null
  status: string
  plannedStart: string
  plannedEnd: string
  tenderedAt?: string | null
}

/** The dry-run/blocked verdict and a successful commit share this shape on
 *  the wire: POST /assignments and PATCH /plan both answer `dryRun` and a
 *  blocked (422) call with exactly `{feasible, conflicts, plan, economics}`,
 *  and a written commit (201/200) with the same three fields plus
 *  `assignment` and `forced`. One type for both rather than two, since every
 *  caller (the gesture pipeline) reads `.feasible`/`.conflicts` off either. */
export interface PlanResult {
  feasible?: boolean
  conflicts: PlanConflict[]
  plan: PlanPlan
  economics: PlanEconomics
  assignment?: BoardAssignment
  forced?: boolean
  error?: string
  /** T3 Break and Rest Planning, Task 7: attached to every verdict body the
   *  server sends (dry-run, 422, and a written commit alike). Optional here
   *  only so pre-T3 fixtures/mocks in this codebase's own tests still
   *  typecheck without updating every one of them — a response that omits
   *  it is treated the same as `breakPlanKnown: false` by the store (never
   *  as "known and empty"; see cockpit.ts's `applyBreakPlan`). */
  breakPlan?: BreakPlanEntry[]
  breakPlanKnown?: boolean
  /** T4 Fuel and Stops, Task 8: attached to every verdict body the server
   *  sends, same optionality reasoning as `breakPlan` above — a response
   *  that omits it must degrade to `fuel.known === false`'s rendering, never
   *  crash and never claim a measured burn it was never given. */
  fuel?: FuelPlanBody
}

export interface PlanBody {
  driverId?: string
  tractorId?: string
  trailerId?: string
  /** epoch-ms or ISO time the leg should now start; omit to keep where it is */
  availableAt?: string | number
  /** right-edge resize: hold the leg open past the engine's proposed end */
  plannedEnd?: string | number
  /** replan despite hard conflicts (dispatcher override) */
  force?: boolean
  /** evaluate + price only; never write (powers the drag preview) */
  dryRun?: boolean
}

export interface CreateAssignmentBody {
  loadId: string
  driverId: string
  tractorId: string
  trailerId: string
  availableAt?: string | number
  force?: boolean
  dryRun?: boolean
  tender?: boolean
}

/** POST /dispatcher/locks — acquire (or heartbeat) a lane hold. A 409 rejects
 *  as a normal axios error with the current holder intact at
 *  `error.response.data.lock`; this function never swallows that — the
 *  lock store is where the "don't throw to the caller" rule lives. */
export async function acquireLock(laneId: string): Promise<{ lock: Lock }> {
  const { data } = await api.post<{ lock: Lock }>('/dispatcher/locks', { laneId })
  return data
}

/** DELETE /dispatcher/locks/:laneId — 204 on success. The server treats
 *  releasing a free or already-expired lane as success too, so only a
 *  genuine "someone else holds it" reaches here as a 409. */
export async function releaseLock(laneId: string): Promise<void> {
  await api.delete(`/dispatcher/locks/${laneId}`)
}

export async function fetchLocks(): Promise<{ locks: Lock[] }> {
  const { data } = await api.get<{ locks: Lock[] }>('/dispatcher/locks')
  return data
}

/** A load lock (spec §5.3/§7): who is editing a load on Their Board or in
 *  the Cockpit. `by` is the holder's name; `since`/`expiresAt` are epoch ms. */
export interface LoadLock { loadId: string; orgId: string; dispatcherId: string; by: string; since: number; expiresAt: number }
export async function acquireLoadLock(loadId: string): Promise<{ lock: LoadLock }> {
  const { data } = await api.post<{ lock: LoadLock }>(`/dispatcher/loads/${loadId}/lock`)
  return data
}
export async function heartbeatLoadLock(loadId: string): Promise<{ lock: LoadLock }> {
  const { data } = await api.post<{ lock: LoadLock }>(`/dispatcher/loads/${loadId}/lock/heartbeat`)
  return data
}
export async function releaseLoadLock(loadId: string): Promise<void> {
  await api.delete(`/dispatcher/loads/${loadId}/lock`)
}
export async function fetchLoadLocks(): Promise<{ locks: LoadLock[] }> {
  const { data } = await api.get<{ locks: LoadLock[] }>('/dispatcher/load-locks')
  return data
}
/** The two 409s a board write can answer with (spec §7.3, §7.4). */
export interface StaleVersionBody { error: 'STALE_VERSION'; current: number; theirs: string; load: BoardLoad }
export interface LoadLockedBody { error: 'LOAD_LOCKED'; message: string; lock?: LoadLock; holders?: Array<{ loadId: string; loadNo: string; by: string }> }

/** PATCH /dispatcher/assignments/:id/plan — the one endpoint every board
 *  gesture (move, resize, drop-onto-a-different-driver) lands in. */
export async function planAssignment(id: string, body: PlanBody): Promise<PlanResult> {
  const { data } = await api.patch<PlanResult>(`/dispatcher/assignments/${id}/plan`, body)
  return data
}

/** POST /dispatcher/assignments — a fresh backlog-load drop onto a lane. */
export async function createAssignment(body: CreateAssignmentBody): Promise<PlanResult> {
  const { data } = await api.post<PlanResult>('/dispatcher/assignments', body)
  return data
}

export interface PairingBody {
  tractorId?: string | null
  trailerId?: string | null
}

/** PATCH /dispatcher/drivers/:id/pairing — the yard-chip drag: hook (or, with
 *  an explicit `null`, unhook) a driver's default tractor/trailer. An omitted
 *  key leaves that side untouched — callers must not send a key they don't
 *  mean to change. Not a plan/assign endpoint (no dryRun, no verdict body):
 *  a single write, 200 with the updated driver. */
export async function pairDriver(driverId: string, body: PairingBody): Promise<{ driver: Record<string, unknown> }> {
  const { data } = await api.patch<{ driver: Record<string, unknown> }>(`/dispatcher/drivers/${driverId}/pairing`, body)
  return data
}

export async function acceptTender(id: string): Promise<{ assignment: BoardAssignment }> {
  const { data } = await api.post<{ assignment: BoardAssignment }>(`/dispatcher/assignments/${id}/tender/accept`)
  return data
}

export async function declineTender(id: string, reason?: string): Promise<void> {
  await api.post(`/dispatcher/assignments/${id}/tender/decline`, reason == null ? {} : { reason })
}

// ---------------------------------------------------------------------------
// T1 Carrier Layer, Task 6: the client companies whose trucks this org
// dispatches. Placed here (not types/fleet.ts) because Carrier is a
// dispatch/cost-engine concept — like Lock/PlanResult above — rather than a
// plain admin CRUD entity; T7-T9 read it for the cockpit's group/filter/badge
// surfaces.
// ---------------------------------------------------------------------------

/** Mirrors fleet-backend's Carrier row (routes/dispatcherCarriers.ts). The
 *  four cost fields are independently nullable and null means "inherit the
 *  org's default" — resolveRateConfig on the server reads them field-by-field.
 *  Never default a null one to 0 on this side: that would silently claim a
 *  carrier's cost is a measured zero instead of "not set for this carrier." */
export interface Carrier {
  id: string
  name: string
  mcNumber: string | null
  dotNumber: string | null
  status: string
  mpg: number | null
  dieselCentsPerGal: number | null
  driverPayCentsPerMi: number | null
  fixedCentsPerMi: number | null
}

/** GET /dispatcher/carriers — the caller org's carriers, name-sorted server-side. */
export async function fetchCarriers(): Promise<Carrier[]> {
  const { data } = await api.get<Carrier[]>('/dispatcher/carriers')
  return data
}

// ---------------------------------------------------------------------------
// T5 Dwell and Detention, Task 6: the org-wide detention scan. Mirrors
// fleet-backend's lib/detentionScan.ts `StopDetention` (and its nested
// `DetentionClaim`/evidence shape from domain/dwell/detention.ts)
// field-for-field — same wire-twin convention as `Lock`/`BreakPlanEntry`/
// `FuelPlanBody` above. `claim: null` means the engine could not honestly
// bill this stop; `noClaimReason` is then always non-null and must be
// rendered verbatim (Global Constraint 6) — never collapse a null claim
// into "$0 detention" (Global Constraint 1). `observedMin` is a real
// measured fact independent of whether a claim could be made, so it can be
// non-null even when `claim` is null.
// ---------------------------------------------------------------------------

/** Ping-level support for one claim: count, largest gap, and the window they
 *  span — what lets a dispatcher defend the figure line-by-line (Global
 *  Constraint 6). `departureObserved: false` means the window's end was
 *  inferred (the last ping before pings stopped), not a confirmed exit. */
export interface DetentionEvidence {
  pingCount: number
  maxGapMin: number
  firstSeenMs: number
  lastSeenMs: number
  departureObserved: boolean
}

/** `billableMin` is already net of `freeMin` and already understated per
 *  Global Constraint 5 — render it as-is, never re-derive it from
 *  `observedMin`. `needsReview: true` means the engine still produced a
 *  figure but flags it as one a dispatcher should eyeball before sending;
 *  `reviewReasons` must be shown verbatim, same as `noClaimReason`. */
export interface DetentionClaim {
  clockStartMs: number
  freeMin: number
  billableMin: number
  evidence: DetentionEvidence
  needsReview: boolean
  reviewReasons: string[]
}

export interface StopDetention {
  loadId: string
  loadRef: string | null
  stopId: string
  stopLabel: string
  stopType: string
  driverId: string
  driverName: string
  claim: DetentionClaim | null
  /** Always non-null exactly when `claim` is null — the engine's own reason
   *  it refused to bill this stop, rendered verbatim by the panel (Task 7). */
  noClaimReason: string | null
  /** Measured dwell even when no claim could be made — null only when there
   *  is no dwell fact at all (never coerced to 0; Global Constraint 1). */
  observedMin: number | null
}

/** GET /dispatcher/detention?sinceHours=N — one row per stop with a claim,
 *  a refusal reason, or both. The route answers the bare array (see
 *  dispatcherDetention.ts's `res.json(claims)`), not an envelope. */
export async function fetchDetention(sinceHours: number): Promise<StopDetention[]> {
  const { data } = await api.get<StopDetention[]>('/dispatcher/detention', { params: { sinceHours } })
  return data
}

/** A fuel stop or rest area along one load's route, measured against the real
 *  road (lib/routePois.ts). `category` is the PROVIDER's classification: a
 *  `gas_station` is not guaranteed truck-accessible, and the provider returns
 *  nothing at all for weigh stations or truck repair — so this layer shows
 *  fuel and rest, and must not be labelled "truck stops". */
export interface RoutePoi {
  id: string
  name: string
  category: 'gas_station' | 'rest_area'
  lat: number
  lng: number
  address: string | null
  /** miles from the route's start, along the road */
  distanceAlongMi: number
  /** how far off the route line it sits */
  offRouteMi: number
}

export interface RoutePoisResult {
  pois: RoutePoi[]
  totalMi: number
  /** false when there is no real road geometry to measure against — the POIs
   *  are then EMPTY and `reason` says why, rather than being placed at
   *  distances the driver will never see. */
  routed: boolean
  reason: string | null
}

export async function fetchRoutePois(loadId: string): Promise<RoutePoisResult> {
  const { data } = await api.get<RoutePoisResult>('/dispatcher/route-pois', { params: { loadId } })
  return data
}

/** A dispatcher's "where are you?" and the driver's answer. Four states, and
 *  nothing may collapse them: `pending` is NOT a position, `denied` is a real
 *  answer rather than missing data, `expired` means nobody replied in time,
 *  and only `approved` carries a location. */
export interface LocationRequestRow {
  id: string
  driverId: string
  driverName: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  requestedAt: string
  respondedAt: string | null
  location: { id: string; latitude: number; longitude: number; createdAt: string } | null
}

export async function requestDriverLocation(driverId: string): Promise<{ alreadyPending: boolean }> {
  const { data } = await api.post<{ alreadyPending: boolean }>('/dispatcher/location-requests', { driverId })
  return data
}

export async function fetchLocationRequests(): Promise<LocationRequestRow[]> {
  const { data } = await api.get<LocationRequestRow[]>('/dispatcher/location-requests')
  return data
}

/** What this dispatch service invoices a client carrier for a period. Four
 *  states the UI must keep apart: terms agreed and complete; terms agreed but
 *  some loads unbillable (an INCOMPLETE total); no terms agreed (nothing to
 *  bill, not $0); and own-fleet work with nobody to invoice. */
export interface CarrierStatementRow {
  carrierId: string
  carrierName: string
  terms: {
    model: 'percent_linehaul' | 'per_load' | 'per_truck_week' | null
    pctBps: number | null
    flatCents: number | null
  }
  truckWeeks: number
  statement: {
    lines: { loadId: string; reference: string | null; basisCents: number; commissionCents: number }[]
    unbillable: { loadId: string; reference: string | null; reason: string }[]
    billedLoadCount: number
    basisCents: number
    loadCommissionCents: number
    truckWeekCents: number
    totalCents: number
    complete: boolean
  }
}

export interface CarrierStatementsResult {
  rows: CarrierStatementRow[]
  ownFleet: { loadCount: number; linehaulCents: number }
  fromMs: number
  toMs: number
}

export async function fetchCarrierStatements(from: string, to: string): Promise<CarrierStatementsResult> {
  const { data } = await api.get<CarrierStatementsResult>('/dispatcher/carrier-statements', { params: { from, to } })
  return data
}

/** Demo controls. The endpoint is ABSENT (404) unless the server runs with
 *  DEMO_MODE=true, which is how the portal decides whether to show the control
 *  at all — there is no separate "is this a demo" flag to drift out of sync. */
export interface DemoShiftPlan {
  shifted: boolean
  days: number
  reason: string | null
  anchorAt?: string | null
}

/** What pressing the button would do, without doing it. Returns null when the
 *  server has demo mode off — the caller renders nothing. */
export async function fetchDemoShiftPlan(): Promise<DemoShiftPlan | null> {
  try {
    const { data } = await api.get<DemoShiftPlan>('/dispatcher/demo/shift')
    return data
  } catch {
    // 404 (not a demo server) and a network failure are the same answer here:
    // do not offer a control that cannot work.
    return null
  }
}

export async function runDemoShift(): Promise<DemoShiftPlan> {
  const { data } = await api.post<DemoShiftPlan>('/dispatcher/demo/shift')
  return data
}

// ---------------------------------------------------------------------------
// Broker Board (spec 2026-09-07 §11): the org's layout and the loads as row
// pairs, plus the two-step (preview, then confirm) .xlsx import. Read-only
// this slice — cell edits are slice 2.
// ---------------------------------------------------------------------------

export type BoardColumnKey = 'bol' | 'customer' | 'phone' | 'contact' | 'pickupCity' | 'puZip' | 'delZip' | 'deliveryCity' | 'rate' | 'soldRate' | 'profit' | 'mc' | 'loadNo' | 'shipDate' | 'update' | 'appt' | 'agent' | 'driverCell' | 'extra'
export interface BoardColumn { key: BoardColumnKey; label: string; source?: string }
export type CellsByKey = Partial<Record<BoardColumnKey, string>>
export interface BoardPill { state: 'none' | 'attention'; text: string | null }
export interface BoardLoad {
  id: string; line: number; top: CellsByKey; bottom: CellsByKey | null; pill: BoardPill; agentLine: { text: string; atMs: number } | null;
  status: string; boardLine: number | null; version: number;
  /** what the record holds where a cell's text disagrees with it (the mark) */
  record?: { update?: string; appt?: string };
  // Night Shift on the Board (Task 6): the switch, its policy, and the pill
  // the AGENT column paints (spec §6.1/§17.1) — a different vocabulary from
  // `pill` above, which is the import-time "can't read this cell" attention
  // marker. Optional: many fixtures across this board's own spec files predate
  // these fields and a load that has never been switched on still needs to
  // render (server sends `agentEnabled: false, agentPolicyId: null, agentPill:
  // "off"` in practice, but the type does not require it).
  agentEnabled?: boolean
  agentPolicyId?: string | null
  agentPill?: string
}
export interface BrokerBoard { layout: BoardColumn[]; loads: BoardLoad[] }
export interface BrokerPreview { sheetName?: string; layout: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[]; loads: Array<Record<string, unknown> & { line: number; notes: string[] }>; notes: string[] }
// `archivedKept`: loads matched in the file that were archived and STAYED
// archived (a re-import never resurrects a load the dispatcher archived). They
// are counted in `updated` too, so the dialog says them out loud rather than
// promising rows the board then does not show.
/** `locked`: rows the importer skipped because a dispatcher was editing
 *  that load (spec §7.3) — a refusal with a name on it, not a failure. */
export interface BrokerImportResult { batchId: string; created: number; updated: number; skipped: number; locked: number; attention: number; archivedKept: number; notes: string[] }

export async function fetchBrokerBoard(includeArchived = false): Promise<BrokerBoard> {
  const { data } = await api.get<BrokerBoard>('/dispatcher/broker-board' + (includeArchived ? '?archived=1' : ''))
  return data
}
function workbookForm(file: File): FormData { const fd = new FormData(); fd.append('file', file, file.name); return fd }
export async function previewBrokerBoard(file: File): Promise<BrokerPreview> {
  const { data } = await api.post<{ preview: BrokerPreview }>('/dispatcher/broker-board/import', workbookForm(file), { headers: { 'Content-Type': 'multipart/form-data' } })
  return data.preview
}
export async function confirmBrokerBoard(file: File): Promise<BrokerImportResult> {
  const { data } = await api.post<BrokerImportResult>('/dispatcher/broker-board/import/confirm', workbookForm(file), { headers: { 'Content-Type': 'multipart/form-data' } })
  return data
}

// --- Editing the board (slice 2B) -------------------------------------------
/** Which of a load's two lines a cell sits on. */
export type BoardRow = 'top' | 'bottom'
export interface BoardCellWrite { row: BoardRow; key: BoardColumnKey; source?: string; value: string; baseVersion: number }
export interface BoardCellPaste extends BoardCellWrite { loadId: string }
/** A status the cell asked for and the record refused (spec §6.3), in the
 *  server's own words — `record says assigned — advance the trip in the
 *  Cockpit`. The cell landed; only the status move did not. */
export interface BoardRefusal { loadId: string; sentence: string }
export interface BoardCellResponse { load: BoardLoad; version: number; statusRefused: string | null }
export interface BoardPasteResponse { loads: BoardLoad[]; refusals: BoardRefusal[] }
/** What a dispatcher painted, and which columns they split into two lines.
 *  Server-side (per org) because it came off their sheet — unlike column
 *  order and width, which are one person's habits and stay in the browser. */
export interface BoardFills { row?: Record<string, string>; col?: Record<string, string>; cell?: Record<string, string> }
export interface BoardViewState { fills: BoardFills; merges: Record<string, string[]> }

export default api
