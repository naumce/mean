import type { BreakPlanEntry, RestOption } from '../api'
import type { BoardLoad, BoardStop, BoardTrailer, LoadboardLane } from '../../stores/loadboard'
import type { DriverLocation } from '../../types/dispatcher'
import { hashId } from './format'
import { progressShare } from './lifecycle'

// Data logic shared by the two GPS views: the schematic radar (RadarView,
// hand-rolled SVG projection) and the live map (FleetMap, Mapbox). Only the
// *projection* differs between them — what counts as a route, where a driver
// currently is, and which colour a status gets are defined exactly once,
// here, so the two views cannot drift apart the way this codebase has before.

/** One route: an assigned load's geocoded stops, in sequence order.
 *  `a`/`b` (first/last) are kept as their own fields — most callers only
 *  ever cared about the endpoints, and RadarView's schematic still projects
 *  off them directly — while `stops` carries every geocoded stop in between
 *  too, for drawing the live map's route as the multi-leg shape it actually
 *  is instead of a single first-to-last chord. */
export interface RouteInfo {
  load: BoardLoad
  a: BoardStop
  b: BoardStop
  stops: BoardStop[]
  status: string
}

/** Assigned loads with at least two geocoded stops become one route each,
 *  carrying every geocoded stop in sequence order (first -> ... -> last). A
 *  load with only one (or zero) geocoded stop is dropped rather than
 *  drawing an invented/zero-length route. */
export function extractRoutes(loads: BoardLoad[]): RouteInfo[] {
  return loads
    .filter((l) => l.assignment && l.stops && l.stops.length >= 2)
    .map((l) => {
      const s = l.stops!.filter((x) => x.lat != null && x.lng != null)
      return { load: l, a: s[0], b: s[s.length - 1], stops: s, status: l.assignment!.status ?? l.status }
    })
    .filter((r): r is RouteInfo => !!r.a && !!r.b && r.a !== r.b)
}

export interface LatLng {
  lat: number
  lng: number
}

/** A GPS ping older than this is stale — a projected/last-known position is
 *  trusted over it. Both views apply this one rule the same way. */
export const FRESH_MS = 15 * 60_000

/** True when `ping` exists and is newer than `FRESH_MS`.
 *
 *  Deliberately typed as a plain `boolean`, not a `ping is DriverLocation`
 *  type predicate: "false" here means either "no ping" OR "a stale ping" —
 *  a stale ping is still a real `DriverLocation`, just not a trustworthy
 *  one. A type predicate would tell TypeScript's control-flow analysis the
 *  opposite (that `ping` is excluded from `DriverLocation` whenever this
 *  returns false), which is wrong and — once the result is stored in a
 *  variable and used to gate unrelated code — silently narrows a live
 *  ping down to `never` at a call site that has nothing to do with
 *  freshness. Callers that need the narrowed value still do their own
 *  `ping!` after checking this, same as before this helper existed. */
export function isFreshPing(ping: DriverLocation | null | undefined, nowMs: number): boolean {
  return !!ping && nowMs - Date.parse(ping.createdAt) < FRESH_MS
}

/** Index tracking pings by driver — the shape both `driverPositions` and the
 *  per-leg "ping beats projection" lookups key off. */
export function pingsByDriver(locations: DriverLocation[]): Map<string, DriverLocation> {
  return new Map(locations.map((p) => [p.driverId, p]))
}

/** A GPS ping updates on every frame; a lane's lastLat/lastLng only refreshes
 *  on a board reload. Prefer the ping — the freshest real position — and fall
 *  back to the lane's last-known fix only when there is no ping at all.
 *  (Freshness is not checked here: an idle driver's stale lane fix is still
 *  the best information available, and an old ping is still better than
 *  nothing — `isFreshPing` only matters for the rolling-leg override below.) */
export function driverPositions(lanes: LoadboardLane[], pings: Map<string, DriverLocation>): Map<string, LatLng> {
  const map = new Map<string, LatLng>()
  for (const d of lanes) {
    const p = pings.get(d.id)
    if (p) map.set(d.id, { lat: p.latitude, lng: p.longitude })
    else if (d.lastLat != null && d.lastLng != null) map.set(d.id, { lat: d.lastLat, lng: d.lastLng })
  }
  return map
}

/** A rolling (in_progress) leg's current position: the elapsed share of its
 *  planned window, linearly interpolated from pickup to delivery, overridden
 *  by a fresh GPS ping when one exists — the same "a measured position beats
 *  a projection" rule `driverPositions` uses for idle drivers. */
export function rollingPosition(route: RouteInfo, ping: DriverLocation | null | undefined, nowMs: number): LatLng {
  if (isFreshPing(ping, nowMs)) return { lat: ping!.latitude, lng: ping!.longitude }
  const t = progressShare(
    route.status,
    Date.parse(route.load.assignment!.plannedStart),
    Date.parse(route.load.assignment!.plannedEnd),
    nowMs,
  )
  return {
    lat: route.a.lat! + (route.b.lat! - route.a.lat!) * t,
    lng: route.a.lng! + (route.b.lng! - route.a.lng!) * t,
  }
}

/** One driver's at-a-glance movement state — computed once here so the live
 *  map (FleetMap, Mapbox) and the schematic radar (RadarView, hand-rolled
 *  SVG) render the exact same three states instead of each hand-rolling its
 *  own copy of "is this driver rolling/parked/untracked", the same reason
 *  extractRoutes/driverPositions/rollingPosition already live here rather
 *  than in either view (see file header).
 *
 *  - `rolling`: on an in_progress leg. `position` is always set — a route's
 *    endpoints are always geocoded (see extractRoutes), so `rollingPosition`
 *    always has something to interpolate from even with no ping.
 *  - `parked`: no in_progress leg, but a position is known — a ping, or the
 *    lane's lastLat/lastLng (driverPositions' ping-preferred/last-fix
 *    rule). `position` is always set.
 *  - `no_gps`: neither an active leg nor any known position. `position` is
 *    `undefined` — DELIBERATELY, never a fallback/default/last-org
 *    coordinate. This is the product invariant this helper exists to
 *    enforce: a driver with no known position must never be placed on a
 *    map (a dispatcher will act on a pin — assign a load off a location
 *    that was invented, the same class of bug this codebase has already
 *    fixed three times elsewhere). Callers must not substitute a
 *    coordinate when `position` is `undefined`; instead surface the driver
 *    in a "position unknown" list alongside the map. */
export type DriverActivityState = 'rolling' | 'parked' | 'no_gps'

export interface DriverActivity {
  driverId: string
  name: string
  state: DriverActivityState
  /** Undefined only for `no_gps` — see that state's doc above. Never a
   *  guessed/default coordinate. */
  position: LatLng | undefined
  /** The in_progress load this driver is rolling on. Undefined for
   *  parked/no_gps — they aren't tied to an active load. */
  loadId: string | undefined
}

/** Classifies every lane into exactly one of the three states above. Takes
 *  the same already-computed inputs `sync()` needs anyway (routes, pings,
 *  the clock tick) so callers don't pay for a second pass over the data. */
export function driverActivity(lanes: LoadboardLane[], routes: RouteInfo[], pings: Map<string, DriverLocation>, nowMs: number): DriverActivity[] {
  const rollingByDriver = new Map<string, RouteInfo>()
  for (const r of routes) {
    if (r.status === 'in_progress') rollingByDriver.set(r.load.assignment!.driverId, r)
  }
  const positions = driverPositions(lanes, pings)

  return lanes.map((lane): DriverActivity => {
    const rolling = rollingByDriver.get(lane.id)
    if (rolling) {
      return {
        driverId: lane.id,
        name: lane.name,
        state: 'rolling',
        position: rollingPosition(rolling, pings.get(lane.id), nowMs),
        loadId: rolling.load.id,
      }
    }
    const pos = positions.get(lane.id)
    return {
      driverId: lane.id,
      name: lane.name,
      state: pos ? 'parked' : 'no_gps',
      position: pos,
      loadId: undefined,
    }
  })
}

/** T2 "Map as Navigation", Task 7: a trailer with a known, TIMESTAMPED
 *  position — the only shape a trailer pin is allowed to render from. */
export interface TrailerActivity {
  trailerId: string
  unit: string
  position: LatLng
  /** ISO 8601. Never null here — see `positionedTrailers` below; it's the
   *  reason a `TrailerActivity` can exist at all. */
  lastSeenAt: string
}

/** Filters the org's trailers down to the ones honest to put on the map.
 *
 *  `lastLat`/`lastLng`/`lastSeenAt` are written together server-side —
 *  never a partial write (see BoardTrailer's own doc in stores/loadboard.ts)
 *  — but this still checks all three rather than trusting that invariant
 *  blindly, because the failure mode if it's ever violated is exactly the
 *  bug this codebase has already fixed four times elsewhere: a trailer
 *  dropped weeks ago rendered as a confident, undated dot indistinguishable
 *  from one repositioned a minute ago. A dispatcher routes off a map pin;
 *  a position with no known age is not "where this trailer is", it is
 *  "somewhere this trailer used to be", and must never be drawn as if it
 *  were the former. `lastSeenAt` is therefore required — not optional — on
 *  the returned shape: FleetMap can only ever render an age it actually
 *  has, never a blank/default one. A trailer that has never been
 *  positioned at all (every field null) is dropped by this same filter.
 *
 *  ALSO excludes any trailer with an `activeDriverId` — one currently
 *  hooked to a driver via an ACTIVE (assigned/tendered/in_progress)
 *  assignment. This is the same invariant in a second, sneakier form:
 *  `lastLat`/`lastLng`/`lastSeenAt` are only ever stamped when a leg
 *  *completes* (see Task 6), never when a trailer is picked back up, so a
 *  hooked trailer's stored position is its LAST DROP-OFF POINT, not where
 *  it actually is — it may be hours down the highway on the back of a
 *  truck that has since driven away. Rendering that as a pin is "stale
 *  shown as current", the same lie as "absent shown as measured" with a
 *  timestamp attached to make it look trustworthy: a dispatcher scans pins,
 *  not popups, and would route to equipment that is not there. A trailer
 *  pin therefore means exactly one thing — "this equipment is sitting
 *  somewhere with no tractor" — which is also the only question this layer
 *  exists to answer; a hooked trailer's position is already shown by its
 *  truck's own marker.
 *
 *  Deliberately `activeDriverId`, NOT `currentDriverId`: the latter also
 *  reports a trailer as "current" merely because it's a driver's DEFAULT
 *  pairing (dispatcherLoadboard.ts's `cur?.trailerId ?? d.defaultTrailerId`),
 *  even with no active assignment at all — e.g. every trailer in the demo
 *  seed, paired to a driver but sitting in the yard. Filtering on
 *  `currentDriverId` was the bug this comment used to describe: it hid
 *  every dropped trailer that happened to also be someone's usual trailer,
 *  which in practice was all of them. `activeDriverId` is set ONLY from the
 *  read model's already-`ACTIVE_STATUSES`-filtered live assignment (`cur`),
 *  never the default-pairing fallback — see dispatcherLoadboard.ts's own
 *  doc on `activeTrailerDriver` for the wire-side half of this. */
export function positionedTrailers(trailers: BoardTrailer[]): TrailerActivity[] {
  return trailers
    .filter((t) => t.lastLat != null && t.lastLng != null && t.lastSeenAt != null && t.activeDriverId == null)
    .map((t): TrailerActivity => ({
      trailerId: t.id,
      unit: t.unit,
      position: { lat: t.lastLat!, lng: t.lastLng! },
      lastSeenAt: t.lastSeenAt!,
    }))
}

/** Literal trailer-pin fill — a single stable hue for every trailer marker
 *  (unlike STATUS_COLOR/carrierColor, a trailer pin doesn't encode a status
 *  or a carrier, only "this is a trailer, here's its age"). Deliberately far
 *  from STATUS_COLOR's palette and from RISK_COLOR (FleetMap.vue) so a
 *  trailer pin can never be mistaken for a truck marker or a risk ring at a
 *  glance — the map-level half of "visually distinct from truck markers";
 *  the pin's square shape (FleetMap.vue's `makeTrailerMarker`) is the other
 *  half. */
export const TRAILER_COLOR = '#facc15'

/** Status -> semantic colour-token suffix (see src/assets/main.css's
 *  `--tk-s-*`). RadarView's Tailwind stroke-/fill- classes key off this map. */
export const STATUS_TOKEN: Record<string, string> = {
  assigned: 's-assigned',
  tendered: 's-tendered',
  in_progress: 's-progress',
  completed: 's-completed',
  delivered: 's-completed',
}

/** Status -> literal colour, for contexts that cannot consume a Tailwind
 *  class (Mapbox paint properties take real colour values, not CSS classes).
 *  These are the *dark*-palette values of the tokens above — the map always
 *  renders the dark Mapbox style regardless of the app's light/dark toggle
 *  (see src/assets/main.css's `.dark` block), so a route drawn on its tiles
 *  must stay legible even when the surrounding chrome is in light mode.
 *  Keyed identically to `STATUS_TOKEN` — same statuses, same meaning, one
 *  colour per status either way it's expressed. */
export const STATUS_COLOR: Record<string, string> = {
  assigned: '#3b82f6',
  tendered: '#a855f7',
  in_progress: '#22d3ee',
  completed: '#64748b',
  delivered: '#64748b',
}

/** Literal marker colours for the carrier grouping (T1 Carrier Layer, Task
 *  9) — same rationale as STATUS_COLOR just above: a Mapbox marker element
 *  takes a real CSS colour value, not a Tailwind/semantic class, so this
 *  palette is deliberately literal rather than token-based. Distinct hues
 *  from STATUS_COLOR/RISK_COLOR (FleetMap.vue) on purpose: a rolling leg's
 *  risk ring and a carrier's fill must never be mistaken for each other.
 *  NO_CARRIER_COLOR is kept out of this array so a hash can never land on
 *  it — see `carrierColor` below. */
export const CARRIER_COLORS: string[] = [
  '#f97316', // orange
  '#84cc16', // lime
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#8b5cf6', // violet
  '#0ea5e9', // sky
  '#f43f5e', // rose
]

/** The "no carrier" marker fill — flat neutral slate, the same grey the rest
 *  of the cockpit already uses for "nothing to report" (STATUS_COLOR's
 *  completed/delivered, format.ts's `slate` ColorKey). Never returned by a
 *  real carrier hash, so a driver with no carrier can't ever be mistaken for
 *  one that merely hashed to a similar-looking colour. */
export const NO_CARRIER_COLOR = '#64748b'

/** Stable colour for a carrier id, from CARRIER_COLORS — keyed by hashing
 *  the id itself (reusing format.ts's `hashId`, the same technique
 *  `avatarColor` already uses to give a driver a stable avatar colour).
 *  Deliberately NOT keyed by the carrier's position in useCarriersStore's
 *  `list`: that list's order comes from the server and is free to change on
 *  every refetch (re-sort, pagination, a carrier added/removed), so an
 *  index-based pick would repaint the whole fleet a different colour on
 *  every reload even though nothing about the carriers themselves changed.
 *  A hash of the immutable id cannot drift that way. `null`/`undefined`
 *  (no carrier) always resolves to NO_CARRIER_COLOR rather than falling
 *  through to `CARRIER_COLORS[0]` — "no carrier" must read as its own
 *  neutral state, never as a coincidental hash collision with a real one. */
export function carrierColor(carrierId: string | null | undefined): string {
  if (!carrierId) return NO_CARRIER_COLOR
  return CARRIER_COLORS[hashId(carrierId) % CARRIER_COLORS.length]
}

/** T2 "Map as Navigation", Task 5: the coordinates FleetMap centres on for
 *  ONE load — the "Show on map" jump's target. Geocoded stops first (every
 *  stop this load actually has, not just the first/last — a load with three
 *  or more stops still centres correctly even if an interior stop is the
 *  only one geocoded), falling back to the assigned driver's current
 *  position (ping-preferred over the lane's last-known fix, the same rule
 *  `driverPositions` applies everywhere else) only when the load has no
 *  geocoded stop at all.
 *
 *  Returns an empty array when neither is known. Callers (FleetMap's
 *  centring, MasterDrawer's "Show on map" affordance) MUST treat that as
 *  "cannot centre this load" and do nothing/stay disabled — never fall back
 *  to a default/org coordinate. Same invariant `driverActivity`'s `no_gps`
 *  state already enforces for a driver with no known position; this is its
 *  load-shaped twin. */
export function focusPointsForLoad(load: BoardLoad, lanes: LoadboardLane[], pings: Map<string, DriverLocation>): LatLng[] {
  const geocoded = (load.stops ?? [])
    .filter((s) => s.lat != null && s.lng != null)
    .map((s): LatLng => ({ lat: s.lat!, lng: s.lng! }))
  if (geocoded.length) return geocoded
  const driverId = load.assignment?.driverId
  if (!driverId) return []
  const pos = driverPositions(lanes, pings).get(driverId)
  return pos ? [pos] : []
}

/** T2 "Map as Navigation", Task 9: the live map places one marker per truck
 *  (driver), which is fine for the five-driver demo fleet but becomes an
 *  unreadable blob at country zoom for the actual buyer — a dispatch service
 *  running dozens of trucks across many client carriers. Below this zoom,
 *  FleetMap groups nearby truck markers into one summary bubble per cluster
 *  instead of drawing them individually; at/above it, every truck still gets
 *  its own marker exactly as before this task. Mapbox's own zoom scale runs
 *  roughly 0 (whole world) to 22 (a building); 5 is "regional" — the point
 *  past which a fleet's markers start to genuinely separate on screen rather
 *  than pile on top of each other. Deliberately >= FleetMap's default mount
 *  zoom (3, "country view" — see onMounted) so clustering is actually active
 *  on the very first screen a dispatcher sees, not just after they zoom out
 *  further than the default. */
export const CLUSTER_ZOOM_THRESHOLD = 5
/** How close two trucks must be (in degrees of lat/lng — a planar
 *  approximation, not a geodesic distance; adequate at the country-view
 *  scale this exists for) to land in the same cluster while zoomed at/below
 *  CLUSTER_ZOOM_THRESHOLD. Mapbox's native `cluster: true` GeoJSON sources
 *  scale their grouping continuously with zoom via real pixel-space
 *  distance; that path was ruled out here because it only works on a
 *  GeoJSON source + symbol layer, not the individually-created HTML
 *  `Marker`s this component uses for every pin (see FleetMap.vue's own doc
 *  on that decision, and Task 9's brief). A fixed-degree radius, gated by a
 *  single zoom breakpoint rather than a continuous zoom-to-radius curve, is
 *  the deliberately simpler v1 that keeps the existing markers — and every
 *  tested invariant they carry — completely intact. */
export const CLUSTER_RADIUS_DEG = 0.75
/** A "cluster" of exactly one truck is just that truck — never rendered as
 *  a bubble. Two is the smallest count that actually needs summarizing. */
export const CLUSTER_MIN_SIZE = 2

/** A generic single-pass grouping: each point joins the first existing
 *  group whose centroid is within `radiusDeg`, or starts a new group when
 *  none qualifies; a group's centroid is recomputed as the running average
 *  of its members after every addition, so it stays honestly centred on
 *  what it actually contains rather than anchored to whichever point
 *  happened to start it. Greedy and order-dependent, like any single-pass
 *  clustering — acceptable here because the input (positioned trucks) has
 *  no meaningful order of its own, and the goal is "close things grouped
 *  together", not a globally optimal partition. */
export function groupByProximity<T>(points: T[], at: (point: T) => LatLng, radiusDeg: number): Array<{ lat: number; lng: number; members: T[] }> {
  const groups: Array<{ lat: number; lng: number; members: T[] }> = []
  for (const point of points) {
    const ll = at(point)
    const group = groups.find((g) => Math.hypot(g.lat - ll.lat, g.lng - ll.lng) <= radiusDeg)
    if (group) {
      group.members.push(point)
      // Recentre on the running average of every member's own position —
      // never left pinned to the first point that happened to start the
      // group.
      group.lat = group.members.reduce((sum, m) => sum + at(m).lat, 0) / group.members.length
      group.lng = group.members.reduce((sum, m) => sum + at(m).lng, 0) / group.members.length
    } else {
      groups.push({ lat: ll.lat, lng: ll.lng, members: [point] })
    }
  }
  return groups
}

/** One cluster bubble's worth of trucks. `id` is derived from its members'
 *  sorted driver ids — stable across a `sync()` pass where membership
 *  hasn't changed (so FleetMap moves the bubble in place instead of
 *  tearing it down and rebuilding it, same as every other marker on this
 *  map), and deliberately NOT stable across a membership change: a truck
 *  joining or leaving a cluster as GPS updates arrive gets a fresh bubble
 *  rather than an old one silently relabelled — the same "recreate rather
 *  than misrepresent" choice this codebase already makes when a driver goes
 *  no_gps and loses its marker outright. */
export interface DriverCluster {
  id: string
  position: LatLng
  drivers: DriverActivity[]
}

/** Splits already-positioned truck activity — every entry here MUST have a
 *  defined `position`; callers filter no_gps out before calling this, the
 *  same filter FleetMap's truck loop always applied before this task — into
 *  markers to draw individually vs. bubbles to draw grouped, based on the
 *  map's current zoom.
 *
 *  At/above CLUSTER_ZOOM_THRESHOLD every truck comes back in `singles` and
 *  `clusters` is empty: the exact pre-Task-9 behaviour, byte-for-byte, so a
 *  dispatcher zoomed in to a single lane sees exactly what they always have.
 *  Below it, trucks within CLUSTER_RADIUS_DEG of each other are grouped into
 *  one DriverCluster; a group of exactly one truck stays a single — never a
 *  one-truck bubble — so a small/typical fleet at any zoom renders identical
 *  to before this task (see the discrimination test in mapData.spec.ts).
 *  A no_gps driver never reaches this function at all (never in `positioned`
 *  to begin with), so it can never end up folded into a cluster's count —
 *  the same "absent, not invented" invariant Task 3 established stays true
 *  whether or not clustering is active. */
export function clusterDriverActivity(positioned: DriverActivity[], zoom: number): { singles: DriverActivity[]; clusters: DriverCluster[] } {
  if (zoom > CLUSTER_ZOOM_THRESHOLD) return { singles: positioned, clusters: [] }
  const groups = groupByProximity(positioned, (a) => a.position!, CLUSTER_RADIUS_DEG)
  const singles: DriverActivity[] = []
  const clusters: DriverCluster[] = []
  for (const g of groups) {
    if (g.members.length < CLUSTER_MIN_SIZE) singles.push(...g.members)
    else clusters.push({ id: g.members.map((m) => m.driverId).sort().join('+'), position: { lat: g.lat, lng: g.lng }, drivers: g.members })
  }
  return { singles, clusters }
}

/** VITE_MAPBOX_TOKEN, or undefined when unset/blank. The one place either
 *  view reads the env var, so a typo'd key can't diverge between them.
 *
 *  A `sk.`-prefixed value is a *secret* Mapbox token (can mint tokens, mutate
 *  tilesets) and must never ship in a browser bundle — see .env.example's
 *  own warning. Treat one as misconfiguration, not a usable token: fall back
 *  to `undefined` (the schematic radar) rather than handing it to the map. */
export function mapboxToken(): string | undefined {
  const t = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
  const trimmed = t?.trim()
  if (!trimmed || trimmed.startsWith('sk.')) return undefined
  return trimmed
}

/** T3 Break and Rest Planning, Task 8: one mandatory HOS break point, placed
 *  and ready to hand to a marker/popup. Everything a `BreakPlanEntry`
 *  carries, flattened onto `loadId` and with `at` narrowed to a real
 *  `LatLng` — `breakMarkers` below has already dropped every entry whose
 *  `at` was null, so nothing downstream needs to re-check that. */
export interface BreakMarker {
  loadId: string
  atMs: number
  at: LatLng
  precision: 'routed' | 'estimated'
  hasCoverage: boolean
  options: RestOption[]
}

/** T3 Break and Rest Planning, Task 8 (Ruling 7): the live map's break-point
 *  layer, reading from the cockpit store's `breakPlanByLoadId` (never
 *  `verdict` — see that state field's own doc) rather than fetching or
 *  deriving anything itself. R4/Global Constraint 1: a POI appears only
 *  when the plan implies a need for it, and an absent fact must never
 *  render as a measured one — so THREE separate cases all simply produce no
 *  marker here, by construction, never a placeholder pin:
 *
 *  - a load id with no entry in the map at all (never evaluated this
 *    session — nothing to claim);
 *  - `known: false` (the driver's HOS was never imported; a break point
 *    derived from assumed hours is fiction, not merely low-confidence);
 *  - an individual entry whose `at` is null (the engine could not place it
 *    — e.g. a deadhead leg with no resolved destination).
 *
 *  A plan that needs no break contributes an empty `entries` array, which
 *  simply yields nothing here too — same "no marker" outcome, no separate
 *  check needed. A single load CAN produce more than one marker: a long
 *  enough haul needs more than one mandatory break, and every placeable
 *  entry for a known plan is rendered. */
export function breakMarkers(byLoadId: Record<string, { entries: BreakPlanEntry[]; known: boolean }>): BreakMarker[] {
  const markers: BreakMarker[] = []
  for (const [loadId, plan] of Object.entries(byLoadId)) {
    if (!plan.known) continue
    for (const entry of plan.entries) {
      if (!entry.at) continue
      markers.push({
        loadId,
        atMs: entry.atMs,
        at: entry.at,
        precision: entry.precision,
        hasCoverage: entry.hasCoverage,
        options: entry.options,
      })
    }
  }
  return markers
}
