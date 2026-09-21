import { isExpired } from '../compliance'
import type { BoardLoad, BoardTractor, BoardTrailer, LoadboardLane } from '../../stores/loadboard'
import { addDaysYmd, wallYmd, zonedMidnightMs } from './geometry'
import { progressShare } from './lifecycle'

// Lane projection for the four groupings, plus the derived per-lane facts
// the header shows (status pill, HOS gate). Pure over the /loadboard payload.
//
// 'carrier' is not a unit kind like 'tractor'/'trailer' — a carrier is the
// client company behind a driver, not a piece of equipment with its own
// lane. Grouping by carrier still projects one lane per driver (kind stays
// 'driver', same as groupBy:'driver' — see projectLanes/laneKeyOf below); the
// carrier only changes how those driver lanes are *bucketed* for the board's
// headers, via groupLanesByCarrier.
export type GroupBy = 'driver' | 'tractor' | 'trailer' | 'carrier'
/** A lane's *kind* — what it represents on the board. Distinct from `GroupBy`
 *  (how the board is grouped): 'brokered' is never a grouping you ask for, it's
 *  a lane `projectLanes` appends in every grouping for loads Their Board says
 *  are covered by an outside carrier, with no unit (driver/tractor/trailer) of
 *  ours behind it. */
export type LaneKind = GroupBy | 'brokered'
export type PillColor = 'emerald' | 'blue' | 'amber' | 'red' | 'slate' | 'purple' | 'cyan'
export interface Pill {
  t: string
  c: PillColor
}
export interface CockpitLane {
  id: string
  kind: LaneKind
  name: string
  sub: string
  driver?: LoadboardLane
  tractor?: BoardTractor
  trailer?: BoardTrailer
  /** Set only on `kind === 'brokered'` lanes — the carrier the legs run under. */
  carrier?: { id: string; name: string; mc: string | null }
  legs: BoardLoad[]
}

export const LIVE_STATUSES = ['assigned', 'tendered', 'in_progress']
export const PLANNING_SPEED_MPH = 50
const OFF_STATUSES = ['inactive', 'off_duty', 'suspended', 'disabled']
const startMs = (l: BoardLoad): number => spanOf(l)?.startMs ?? Number.NEGATIVE_INFINITY

export function laneKeyOf(groupBy: GroupBy): 'driverId' | 'tractorId' | 'trailerId' {
  if (groupBy === 'tractor') return 'tractorId'
  if (groupBy === 'trailer') return 'trailerId'
  return 'driverId' // 'driver' and 'carrier' both key legs by driver
}

/** Covered on Their Board (spec §8.2): booked, rolling or done — a carrier
 *  lined up on an `open` load is not a lane, it is a chip in the backlog. */
export const COVERED_STATUSES = ['assigned', 'in_progress', 'delivered']
export const isCarrierLaneLoad = (l: BoardLoad): boolean => !l.assignment && !!l.carrierId && COVERED_STATUSES.includes(l.status)

/** Where a brick sits in time: a leg by its planned window, a brokered load by
 *  the Appointment rows the writer guarantees; null means unplaced. */
export function spanOf(l: BoardLoad): { startMs: number; endMs: number } | null {
  if (l.assignment) return { startMs: Date.parse(l.assignment.plannedStart), endMs: Date.parse(l.assignment.plannedEnd) }
  const start = l.pickupWindowStart ?? l.pickupWindowEnd
  const end = l.deliveryWindowEnd
  if (!start || !end) return null
  return { startMs: Date.parse(start), endMs: Date.parse(end) }
}

/** One lane per carrier for the loads that run on that carrier's truck (spec §8.3). */
export function carrierLanesOf(loads: BoardLoad[]): CockpitLane[] {
  const byCarrier = new Map<string, BoardLoad[]>()
  for (const l of loads) {
    if (!isCarrierLaneLoad(l)) continue
    const arr = byCarrier.get(l.carrierId!) ?? []
    arr.push(l)
    byCarrier.set(l.carrierId!, arr)
  }
  return [...byCarrier.entries()]
    .map(([carrierId, legs]) => {
      const first = legs[0]
      return {
        id: `carrier:${carrierId}`, kind: 'brokered' as const, name: first.carrierName ?? 'Carrier', sub: first.carrierMc ? `MC ${first.carrierMc}` : '',
        carrier: { id: carrierId, name: first.carrierName ?? 'Carrier', mc: first.carrierMc ?? null },
        // startMs falls back to NEGATIVE_INFINITY for an unplaced leg — the left edge is where they render.
        legs: legs.slice().sort((a, b) => startMs(a) - startMs(b)),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function projectLanes(
  groupBy: GroupBy,
  lanes: LoadboardLane[],
  tractors: BoardTractor[],
  trailers: BoardTrailer[],
  loads: BoardLoad[],
): CockpitLane[] {
  const key = laneKeyOf(groupBy)
  const byLane = new Map<string, BoardLoad[]>()
  for (const l of loads) {
    const id = l.assignment?.[key]
    if (!id) continue
    const arr = byLane.get(id) ?? []
    arr.push(l)
    byLane.set(id, arr)
  }
  const legsOf = (id: string): BoardLoad[] => (byLane.get(id) ?? []).slice().sort((a, b) => startMs(a) - startMs(b))

  // 'carrier' projects the same per-driver lanes as 'driver' — grouping by
  // carrier buckets those driver lanes afterward (groupLanesByCarrier), it
  // doesn't change what a lane *is*.
  // Every grouping also appends one lane per brokered carrier (spec §8.3):
  // loads that are covered by an outside carrier with no unit of ours behind
  // them still belong on the board, just not under a driver/tractor/trailer.
  if (groupBy === 'driver' || groupBy === 'carrier')
    return [
      ...lanes.map((d) => ({ id: d.id, kind: 'driver' as const, name: d.name, sub: d.status, driver: d, legs: legsOf(d.id) })),
      ...carrierLanesOf(loads),
    ]
  if (groupBy === 'tractor')
    return [
      ...tractors.map((t) => ({
        id: t.id, kind: 'tractor' as const, name: `#${t.unit}`, sub: [t.make, t.cab].filter(Boolean).join(' · '), tractor: t, legs: legsOf(t.id),
      })),
      ...carrierLanesOf(loads),
    ]
  return [
    ...trailers.map((r) => ({
      id: r.id, kind: 'trailer' as const, name: r.unit, sub: r.length ? `${r.type} · ${r.length}` : r.type, trailer: r, legs: legsOf(r.id),
    })),
    ...carrierLanesOf(loads),
  ]
}

/** One carrier's section of the board: its label plus the driver lanes that
 *  belong to it. `id`/`name` are `NO_CARRIER_ID`/`NO_CARRIER_LABEL` for the
 *  unassigned bucket — never omitted, never merged away. */
export interface CarrierGroup {
  id: string
  name: string
  lanes: CockpitLane[]
}

/** Sentinel id/label for drivers with no carrier — exported so callers (the
 *  board header, tests) can key off the same constant rather than the
 *  literal string. */
export const NO_CARRIER_ID = 'none'
export const NO_CARRIER_LABEL = 'No carrier'

/**
 * Buckets lanes by their carrier for the board's "Carrier" grouping.
 *
 * The one rule this function exists to enforce: a lane never disappears. A
 * driver lane with `carrierId: null` (no carrier assigned) lands in a single,
 * clearly-labelled "No carrier" group rather than being filtered out — a
 * dispatch board silently hiding a truck because a field is unset is exactly
 * the failure this guards against. Every lane passed in appears in exactly
 * one returned group, so `sum(groups.map(g => g.lanes.length))` always equals
 * `lanes.length`.
 *
 * Carrier is a property of the *driver* (`CockpitLane.driver.carrierId`) for
 * a driver lane, or the lane's own `carrier` for a brokered one (plan A3) —
 * tractor/trailer-kind lanes (neither) fall into "No carrier" too if ever
 * passed here — in practice this only ever receives the driver + brokered
 * lanes `projectLanes('carrier', ...)` produces.
 *
 * Named groups sort alphabetically by carrier name; "No carrier" is always
 * last, so the unassigned bucket doesn't jump around the list as carriers are
 * renamed, but never blends in with them either.
 */
export function groupLanesByCarrier(lanes: CockpitLane[]): CarrierGroup[] {
  const named = new Map<string, CarrierGroup>()
  const unassigned: CockpitLane[] = []
  for (const lane of lanes) {
    const carrierId = lane.kind === 'brokered' ? lane.carrier!.id : lane.driver?.carrierId ?? null
    if (!carrierId) {
      unassigned.push(lane)
      continue
    }
    const group = named.get(carrierId) ?? { id: carrierId, name: lane.carrier?.name ?? lane.driver?.carrierName ?? carrierId, lanes: [] }
    group.lanes.push(lane)
    named.set(carrierId, group)
  }
  const groups = Array.from(named.values()).sort((a, b) => a.name.localeCompare(b.name))
  if (unassigned.length) groups.push({ id: NO_CARRIER_ID, name: NO_CARRIER_LABEL, lanes: unassigned })
  return groups
}

export function pillOf(lane: CockpitLane, nowMs: number): Pill {
  // A brokered lane has no unit of ours behind it — HOOKED/ROLLING/etc. describe
  // our equipment/driver, which this lane doesn't have. It gets its own pill.
  if (lane.kind === 'brokered') return { t: 'BROKERED', c: 'cyan' }
  const live = lane.legs.filter(
    (l) => l.assignment && LIVE_STATUSES.includes(l.assignment.status ?? 'assigned') && Date.parse(l.assignment.plannedEnd) > nowMs,
  )
  const rolling = live.some((l) => l.assignment!.status === 'in_progress')

  if (lane.kind === 'tractor') {
    const t = lane.tractor!
    if (t.status === 'in_shop') return { t: 'IN SHOP', c: 'purple' }
    if (rolling) return { t: 'ROLLING', c: 'emerald' }
    if (t.currentDriverId) return { t: 'ASSIGNED', c: 'blue' }
    return { t: 'BOBTAIL', c: 'slate' }
  }
  if (lane.kind === 'trailer') {
    const r = lane.trailer!
    if (isExpired(r.registrationExpiresAt, nowMs)) return { t: 'REG EXPIRED', c: 'red' }
    if (r.status === 'in_shop') return { t: 'IN SHOP', c: 'purple' }
    if (rolling) return { t: 'ROLLING', c: 'emerald' }
    // `activeDriverId`, NOT `currentDriverId` — the same distinction mapData.ts
    // makes for the trailer layer, and for the same reason. `currentDriverId`
    // means "active OR default pairing", so a trailer merely assigned to a
    // driver's lane read HOOKED even while it sat dropped in a yard. The board
    // and the map were answering one question two ways, and disagreeing: the
    // map correctly showed FB-3310 dropped in Omaha while this pill called it
    // hooked. One fact, one field.
    if (r.activeDriverId) return { t: 'HOOKED', c: 'cyan' }
    return { t: 'DROPPED', c: 'slate' }
  }
  const d = lane.driver!
  if (OFF_STATUSES.includes(d.status)) return { t: 'OFF DUTY', c: 'slate' }
  if (d.status === 'on_break') return { t: 'RESTING', c: 'amber' }
  if (rolling) return { t: 'ROLLING', c: 'emerald' }
  if (live.some((l) => l.assignment!.status === 'tendered')) return { t: 'TENDERED', c: 'purple' }
  const next = live.filter((l) => l.assignment!.status === 'assigned').sort((a, b) => startMs(a) - startMs(b))[0]
  if (next && startMs(next) - nowMs < 3 * 3_600_000) return { t: 'LOADING', c: 'blue' }
  return { t: 'AVAILABLE', c: 'blue' }
}

/** Drive minutes still needed TODAY: remaining road time (miles / planning
 *  speed, less the share already driven) capped by the part of each leg that
 *  falls inside today — a 38h multi-day leg is not 38h of driving. */
export function plannedDriveTodayMin(lane: CockpitLane, nowMs: number, tz: string): number {
  // HOS drive-time doesn't apply to a brokered lane — there's no driver of
  // ours whose clock it could consume.
  if (lane.kind === 'brokered') return 0
  const dayEnd = endOfOrgDayMs(nowMs, tz)
  let sum = 0
  for (const l of lane.legs) {
    const a = l.assignment
    if (!a || !LIVE_STATUSES.includes(a.status ?? 'assigned')) continue
    const s = Date.parse(a.plannedStart)
    const e = Date.parse(a.plannedEnd)
    if (e <= nowMs || s >= dayEnd) continue
    const miles = (a.deadheadMi ?? 0) + (a.loadedMi ?? 0)
    const remaining = a.status === 'in_progress' ? 1 - progressShare(a.status, s, e, nowMs) : 1
    const drive = (miles / PLANNING_SPEED_MPH) * 60 * remaining
    const windowMin = (Math.min(e, dayEnd) - Math.max(s, nowMs)) / 60_000
    sum += Math.max(0, Math.min(drive, windowMin))
  }
  return sum
}

/** Next org-local midnight — the cockpit's one definition of "today".
 *  Everything that says "today" (planned drive, utilization) uses this, never
 *  a rolling now+24h, because the board itself is drawn in org-day columns. */
export function endOfOrgDayMs(nowMs: number, tz: string): number {
  return zonedMidnightMs(addDaysYmd(wallYmd(nowMs, tz), 1), tz)
}

/** Safety-gate result. `violations` counts only drivers whose clocks are
 *  actually known, so `known`/`total` must travel with it: 0 violations out of
 *  0 known clocks is "no data", not "protected". */
export interface HosGate {
  violations: number
  known: number
  total: number
}

export function hosGate(lanes: CockpitLane[], nowMs: number, tz: string): HosGate {
  const drivers = lanes.filter((ln) => ln.kind === 'driver')
  const known = drivers.filter((ln) => ln.driver?.hosKnown && ln.driver.driveRemainingMin != null)
  const violations = known.filter(
    (ln) => plannedDriveTodayMin(ln, nowMs, tz) > ln.driver!.driveRemainingMin! + 0.5,
  ).length
  return { violations, known: known.length, total: drivers.length }
}

/** Whether a leg still holds capacity at `nowMs`: a live status whose planned
 *  window has not already closed. Shared by the two revenue definitions below
 *  and by utilization, so "live" means one thing on this screen. A brokered
 *  brick has no assignment to read a status/window off of — it uses the
 *  load's own status and `spanOf`'s appointment-window span instead, so it
 *  counts toward committed gross the same way an assigned leg does. */
function isLiveAt(l: BoardLoad, nowMs: number): boolean {
  const status = l.assignment ? (l.assignment.status ?? 'assigned') : l.status
  const span = spanOf(l)
  return !!span && LIVE_STATUSES.includes(status) && span.endMs > nowMs
}

/**
 * COMMITTED GROSS — money the fleet has still to earn, right now.
 *
 * Counts each load once across all lanes, and only legs that are live
 * (assigned/tendered/in_progress) and whose planned window has not closed.
 * Completed work is excluded: it is already earned, not committed. This is the
 * KPI strip's headline number and it *shrinks* as the day is delivered.
 *
 * Deliberately different from `laneMoneyInView` below: that one answers "what
 * is on this lane in the window I'm looking at", which includes finished legs
 * and legs whose window has already passed. Same units, different question —
 * never substitute one for the other.
 */
export function committedGrossCents(lanes: CockpitLane[], nowMs: number): { cents: number; loads: number } {
  const seen = new Set<string>()
  let cents = 0
  for (const ln of lanes)
    for (const l of ln.legs) {
      if (seen.has(l.id) || !isLiveAt(l, nowMs)) continue
      seen.add(l.id)
      cents += l.revenueCents
    }
  return { cents, loads: seen.size }
}

/** A lane's money for the legs currently projected onto it. */
export interface LaneMoney {
  /** Revenue of every leg in view — live, completed, past or future. */
  revenueCents: number
  /** Margin of the priced legs only; null when no leg in view has a committed
   *  rate snapshot, so the lane shows "—" rather than a manufactured 0%. */
  marginCents: number | null
  /** Revenue of the priced legs only — the honest denominator for margin %. */
  pricedRevenueCents: number
}

/**
 * LANE REVENUE IN VIEW — every leg currently projected onto this lane, with no
 * status or time filter, because the lane footer describes the row the
 * dispatcher is looking at (the window is the filter, applied upstream by
 * `projectLanes` over the loads the API returned for it).
 *
 * Deliberately different from `committedGrossCents` above: this includes
 * completed and already-ended legs, and it is per-lane rather than
 * deduplicated fleet-wide. A lane footer and the Committed Gross tile are
 * *expected* to disagree; they answer different questions.
 */
export function laneMoneyInView(lane: CockpitLane): LaneMoney {
  let revenueCents = 0
  let pricedRevenueCents = 0
  let margin = 0
  let priced = 0
  for (const l of lane.legs) {
    revenueCents += l.revenueCents
    const e = l.assignment?.economics
    if (!e) continue
    priced++
    margin += e.marginCents
    pricedRevenueCents += l.revenueCents
  }
  return { revenueCents, marginCents: priced ? margin : null, pricedRevenueCents }
}

/** Drivers holding a live leg at some point in the rest of the org-local day,
 *  over drivers who could hold one (off-duty statuses excluded). "Today" is the
 *  org calendar day — the same one `plannedDriveTodayMin` uses. */
export function utilizationToday(lanes: CockpitLane[], nowMs: number, tz: string): { used: number; total: number } {
  const dayEnd = endOfOrgDayMs(nowMs, tz)
  const drivers = lanes.filter((ln) => ln.kind === 'driver' && !OFF_STATUSES.includes(ln.driver?.status ?? ''))
  const used = drivers.filter((ln) =>
    ln.legs.some((l) => isLiveAt(l, nowMs) && Date.parse(l.assignment!.plannedStart) < dayEnd),
  ).length
  return { used, total: drivers.length }
}
