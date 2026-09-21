import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BreakPlanEntry } from '../api'
import type { BoardLoad, BoardTrailer } from '../../stores/loadboard'
import type { DriverLocation } from '../../types/dispatcher'
import {
  breakMarkers,
  CLUSTER_MIN_SIZE,
  CLUSTER_RADIUS_DEG,
  CLUSTER_ZOOM_THRESHOLD,
  clusterDriverActivity,
  driverActivity,
  driverPositions,
  extractRoutes,
  FRESH_MS,
  groupByProximity,
  isFreshPing,
  mapboxToken,
  pingsByDriver,
  positionedTrailers,
  rollingPosition,
  STATUS_COLOR,
  STATUS_TOKEN,
  type DriverActivity,
} from './mapData'

const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const D = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const stops = (a: [number, number], b: [number, number]): BoardLoad['stops'] => [
  { sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: a[0], lng: a[1], dwellMin: 60, windowStart: null, windowEnd: null },
  { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: b[0], lng: b[1], dwellMin: 60, windowStart: null, windowEnd: null },
]
const load = (over: Partial<BoardLoad>): BoardLoad => ({
  id: 'l1', reference: 'L-1', status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null,
  revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B',
  stops: stops([39.1, -94.58], [41.88, -87.63]),
  assignment: { id: 'a1', driverId: 'd1', status: 'assigned', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 },
  ...over,
})
const ping = (over: Partial<DriverLocation>): DriverLocation => ({
  driverId: 'd1', driverName: 'Driver One', latitude: 40, longitude: -90, createdAt: iso(NOW), ...over,
})
const trailer = (over: Partial<BoardTrailer>): BoardTrailer => ({
  id: 't1', unit: 'FB-3310', type: 'Flatbed', length: "48'", status: 'active', features: null,
  inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: null,
  lastLat: null, lastLng: null, lastSeenAt: null, ...over,
})

describe('extractRoutes', () => {
  it('drops loads with no assignment', () => {
    expect(extractRoutes([load({ assignment: null })])).toHaveLength(0)
  })

  it('drops loads with fewer than two stops', () => {
    expect(extractRoutes([load({ stops: [stops([39, -95], [40, -90])![0]] })])).toHaveLength(0)
  })

  it('drops a load with only one geocoded stop (a === b guard)', () => {
    const s = stops([39, -95], [40, -90])!
    s[1] = { ...s[1], lat: null, lng: null }
    expect(extractRoutes([load({ stops: s })])).toHaveLength(0)
  })

  it('keeps the first and last geocoded stop, and the assignment status', () => {
    const [r] = extractRoutes([load({})])
    expect(r.a.address).toBe('Kansas City, MO')
    expect(r.b.address).toBe('Chicago, IL')
    expect(r.status).toBe('assigned')
    expect(r.load.id).toBe('l1')
  })

  it('falls back to the load status when the assignment carries none', () => {
    const [r] = extractRoutes([
      load({ status: 'tendered', assignment: { id: 'a1', driverId: 'd1', plannedStart: iso(NOW), plannedEnd: iso(NOW + H), marginCents: 1 } }),
    ])
    expect(r.status).toBe('tendered')
  })
})

describe('pingsByDriver / driverPositions', () => {
  it('prefers a ping over the lane last-known fix', () => {
    const pings = pingsByDriver([ping({ driverId: 'd1', latitude: 41, longitude: -91 })])
    const pos = driverPositions([{ id: 'd1', name: 'D', status: 'active', lastLat: 10, lastLng: 10 }], pings)
    expect(pos.get('d1')).toEqual({ lat: 41, lng: -91 })
  })

  it('falls back to lastLat/lastLng when there is no ping', () => {
    const pos = driverPositions([{ id: 'd1', name: 'D', status: 'active', lastLat: 25, lastLng: -85 }], new Map())
    expect(pos.get('d1')).toEqual({ lat: 25, lng: -85 })
  })

  it('never invents a position: no ping and no last fix -> no entry', () => {
    const pos = driverPositions([{ id: 'd1', name: 'D', status: 'active', lastLat: null, lastLng: null }], new Map())
    expect(pos.has('d1')).toBe(false)
  })
})

describe('isFreshPing / FRESH_MS', () => {
  it('is fresh just inside FRESH_MS', () => {
    expect(isFreshPing(ping({ createdAt: iso(NOW - (FRESH_MS - 1000)) }), NOW)).toBe(true)
  })

  it('is stale at/after FRESH_MS', () => {
    expect(isFreshPing(ping({ createdAt: iso(NOW - FRESH_MS) }), NOW)).toBe(false)
  })

  it('is false for a missing ping', () => {
    expect(isFreshPing(undefined, NOW)).toBe(false)
    expect(isFreshPing(null, NOW)).toBe(false)
  })
})

describe('rollingPosition', () => {
  const route = extractRoutes([load({ status: 'in_progress', assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 } })])[0]

  it('uses the fresh ping when one exists, ignoring the interpolated point', () => {
    const p = ping({ createdAt: iso(NOW - 60_000), latitude: 55, longitude: -70 })
    expect(rollingPosition(route, p, NOW)).toEqual({ lat: 55, lng: -70 })
  })

  it('falls back to the time-interpolated point when the ping is stale', () => {
    const p = ping({ createdAt: iso(NOW - FRESH_MS), latitude: 55, longitude: -70 })
    const mid = rollingPosition(route, p, NOW)
    expect(mid.lat).toBeCloseTo((route.a.lat! + route.b.lat!) / 2, 5)
    expect(mid.lng).toBeCloseTo((route.a.lng! + route.b.lng!) / 2, 5)
  })

  it('falls back to the time-interpolated point when there is no ping at all', () => {
    const mid = rollingPosition(route, undefined, NOW)
    expect(mid.lat).toBeCloseTo((route.a.lat! + route.b.lat!) / 2, 5)
    expect(mid.lng).toBeCloseTo((route.a.lng! + route.b.lng!) / 2, 5)
  })
})

describe('driverActivity', () => {
  const inProgressRoutes = () =>
    extractRoutes([
      load({
        status: 'in_progress',
        assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 },
      }),
    ])

  it('classifies a driver on an in_progress leg as rolling, with a known position and the load id', () => {
    const [activity] = driverActivity([{ id: 'd1', name: 'D1', status: 'active' }], inProgressRoutes(), new Map(), NOW)
    expect(activity.state).toBe('rolling')
    expect(activity.position).toBeDefined()
    expect(activity.loadId).toBe('l1')
  })

  it('classifies a driver with a known position but no active leg as parked', () => {
    const [activity] = driverActivity([{ id: 'd2', name: 'D2', status: 'active', lastLat: 25, lastLng: -85 }], [], new Map(), NOW)
    expect(activity.state).toBe('parked')
    expect(activity.position).toEqual({ lat: 25, lng: -85 })
    expect(activity.loadId).toBeUndefined()
  })

  it('classifies a driver with neither a ping nor lastLat/lastLng as no_gps, with no invented position', () => {
    const [activity] = driverActivity([{ id: 'd3', name: 'D3', status: 'active', lastLat: null, lastLng: null }], [], new Map(), NOW)
    expect(activity.state).toBe('no_gps')
    expect(activity.position).toBeUndefined()
    expect(activity.loadId).toBeUndefined()
  })

  it('never invents a position for a no_gps driver even when other drivers have real positions nearby', () => {
    // Guards against a fallback that reuses another driver's, or the org's,
    // coordinate for the untracked one instead of leaving it undefined.
    const lanes = [
      { id: 'd1', name: 'D1', status: 'active' as const },
      { id: 'd9', name: 'D9', status: 'active' as const, lastLat: null, lastLng: null },
    ]
    const [rolling, noGps] = driverActivity(lanes, inProgressRoutes(), new Map(), NOW)
    expect(rolling.state).toBe('rolling')
    expect(noGps.state).toBe('no_gps')
    expect(noGps.position).toBeUndefined()
  })

  it('produces three distinct, discriminable states across a mixed fleet', () => {
    const lanes = [
      { id: 'd1', name: 'D1', status: 'active' as const },
      { id: 'd2', name: 'D2', status: 'active' as const, lastLat: 25, lastLng: -85 },
      { id: 'd3', name: 'D3', status: 'active' as const, lastLat: null, lastLng: null },
    ]
    const activities = driverActivity(lanes, inProgressRoutes(), new Map(), NOW)
    expect(activities.map((a) => a.state)).toEqual(['rolling', 'parked', 'no_gps'])
    expect(new Set(activities.map((a) => a.state)).size).toBe(3)
    // The one invariant that matters: position is set for exactly the two
    // located states, and for no other reason than that.
    for (const a of activities) expect(a.position !== undefined).toBe(a.state !== 'no_gps')
  })
})

// T2 "Map as Navigation": the live map's trailer-pin filter. A trailer is
// honest to place on the map only when it has a real, timestamped position
// AND is not currently on an active assignment (see positionedTrailers's own
// doc for the "stale shown as current" failure this guards against).
describe('positionedTrailers', () => {
  it('includes a dropped trailer (no driver at all) with a real position and timestamp', () => {
    const [t] = positionedTrailers([trailer({ lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })])
    expect(t.trailerId).toBe('t1')
    expect(t.position).toEqual({ lat: 39.5, lng: -95.0 })
  })

  // THE BUG: `currentDriverId` is set both by an active assignment AND by a
  // driver's mere default pairing (dispatcherLoadboard.ts's
  // `cur?.trailerId ?? d.defaultTrailerId`) — the demo seed pairs every
  // trailer to a driver this way, with no active assignment on any of them.
  // Filtering on `currentDriverId` hid all of them. A trailer that is only
  // someone's default pairing, sitting dropped in the yard, has an honest
  // stored position and MUST render.
  it('includes a trailer that is only a driver\'s default pairing (currentDriverId set, activeDriverId not) — the bug', () => {
    const trailers = [trailer({ lastLat: 41.2565, lastLng: -95.9345, lastSeenAt: iso(NOW - 4 * D), currentDriverId: 'd1', activeDriverId: null })]
    expect(positionedTrailers(trailers)).toHaveLength(1)
  })

  // THE INVARIANT that must survive the fix above: a trailer actually on an
  // active assignment (assigned/tendered/in_progress) is excluded even with
  // a valid position and timestamp — its stored position is a stale
  // last-drop-off point, not where it is now.
  it('excludes a trailer on an active assignment, even with a valid position and timestamp', () => {
    const trailers = [trailer({ lastLat: 41.2565, lastLng: -95.9345, lastSeenAt: iso(NOW - H), currentDriverId: 'd1', activeDriverId: 'd1' })]
    expect(positionedTrailers(trailers)).toHaveLength(0)
  })

  it('excludes a trailer missing lastSeenAt even when positioned and not hooked', () => {
    const trailers = [trailer({ lastLat: 39.5, lastLng: -95.0, lastSeenAt: null })]
    expect(positionedTrailers(trailers)).toHaveLength(0)
  })
})

describe('STATUS_TOKEN / STATUS_COLOR', () => {
  it('define a colour for exactly the same set of statuses', () => {
    expect(Object.keys(STATUS_COLOR).sort()).toEqual(Object.keys(STATUS_TOKEN).sort())
  })

  it('give delivered and completed the same colour, like the schematic', () => {
    expect(STATUS_COLOR.delivered).toBe(STATUS_COLOR.completed)
    expect(STATUS_TOKEN.delivered).toBe(STATUS_TOKEN.completed)
  })
})

describe('mapboxToken', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is undefined when unset', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '')
    expect(mapboxToken()).toBeUndefined()
  })

  it('is undefined for a blank/whitespace value', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '   ')
    expect(mapboxToken()).toBeUndefined()
  })

  it('returns a trimmed public token', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '  pk.abc123  ')
    expect(mapboxToken()).toBe('pk.abc123')
  })

  it('refuses a secret token (sk.*) rather than exposing it to the map', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'sk.thisIsSecret')
    expect(mapboxToken()).toBeUndefined()
  })
})

// T2 "Map as Navigation", Task 9: the generic proximity-grouping pass
// FleetMap.vue's truck-marker clustering is built on. Asserted directly here
// against its actual output (the grouped set — see the file header on why
// FleetMap itself only asserts what it was told, not rendered pixels), kept
// separate from clusterDriverActivity's own tests below because this half
// has no notion of trucks, zoom, or a minimum cluster size at all.
describe('groupByProximity', () => {
  const at = (p: { lat: number; lng: number }) => p
  const pt = (lat: number, lng: number) => ({ lat, lng })

  it('puts two points within the radius into one group', () => {
    const groups = groupByProximity([pt(32, -96), pt(32.01, -96.01)], at, 0.75)
    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(2)
  })

  it('keeps two points farther apart than the radius in separate groups', () => {
    const groups = groupByProximity([pt(32, -96), pt(40, -90)], at, 0.75)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.members.length)).toEqual([1, 1])
  })

  it("recentres a group's lat/lng to the plain average of its members, not the first point that started it", () => {
    const groups = groupByProximity([pt(32, -96), pt(32.02, -96.02), pt(31.98, -95.98)], at, 0.75)
    expect(groups).toHaveLength(1)
    expect(groups[0].lat).toBeCloseTo((32 + 32.02 + 31.98) / 3, 10)
    expect(groups[0].lng).toBeCloseTo((-96 + -96.02 + -95.98) / 3, 10)
  })

  it('returns one singleton group per point when given an empty/zero radius', () => {
    const groups = groupByProximity([pt(32, -96), pt(32.001, -96.001)], at, 0)
    expect(groups).toHaveLength(2)
  })

  it('returns no groups for no points', () => {
    expect(groupByProximity([], at, 0.75)).toHaveLength(0)
  })
})

describe('clusterDriverActivity', () => {
  const driver = (id: string, lat: number, lng: number): DriverActivity => ({ driverId: id, name: id, state: 'parked', position: { lat, lng }, loadId: undefined })

  it('groups drivers within CLUSTER_RADIUS_DEG of each other into one DriverCluster when at/below CLUSTER_ZOOM_THRESHOLD', () => {
    const { singles, clusters } = clusterDriverActivity([driver('a', 32, -96), driver('b', 32.02, -96.02)], CLUSTER_ZOOM_THRESHOLD)
    expect(singles).toHaveLength(0)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].drivers.map((d) => d.driverId).sort()).toEqual(['a', 'b'])
    // The id is a stable function of membership — same two drivers, same id
    // no matter which order they were supplied in.
    expect(clusters[0].id).toBe('a+b')
  })

  // Boundary check against the real, exported radius (not a locally-chosen
  // stand-in) — the discriminating pair for CLUSTER_RADIUS_DEG itself:
  // moving the second driver from just inside it to just outside it flips
  // clustered -> not clustered with nothing else changing.
  it('clusters drivers just inside CLUSTER_RADIUS_DEG apart, but not just outside it', () => {
    const inside = clusterDriverActivity([driver('a', 32, -96), driver('b', 32, -96 + (CLUSTER_RADIUS_DEG - 0.01))], 0)
    expect(inside.clusters).toHaveLength(1)

    const outside = clusterDriverActivity([driver('a', 32, -96), driver('b', 32, -96 + (CLUSTER_RADIUS_DEG + 0.01))], 0)
    expect(outside.clusters).toHaveLength(0)
    expect(outside.singles).toHaveLength(2)
  })

  // The discriminating pair: the exact same two nearby drivers, one zoom
  // step apart, must produce opposite shapes of result. Naming the
  // assertions: `clusters` flips from length 1 to length 0, and `singles`
  // flips from length 0 to length 2, purely from crossing
  // CLUSTER_ZOOM_THRESHOLD — nothing about the drivers themselves changed.
  it('stops clustering the identical pair of drivers once zoom is past CLUSTER_ZOOM_THRESHOLD', () => {
    const drivers = [driver('a', 32, -96), driver('b', 32.02, -96.02)]
    const below = clusterDriverActivity(drivers, CLUSTER_ZOOM_THRESHOLD)
    const above = clusterDriverActivity(drivers, CLUSTER_ZOOM_THRESHOLD + 1)
    expect(below.clusters).toHaveLength(1)
    expect(above.clusters).toHaveLength(0)
    expect(above.singles).toHaveLength(2)
    expect(above.singles).toBe(drivers) // above threshold: the exact input array, untouched
  })

  it('never produces a one-member "cluster" — a lone driver with no nearby neighbour stays a single', () => {
    const { singles, clusters } = clusterDriverActivity([driver('a', 32, -96), driver('b', 50, -70)], 0)
    expect(clusters).toHaveLength(0)
    expect(singles.map((d) => d.driverId).sort()).toEqual(['a', 'b'])
  })

  it('respects CLUSTER_MIN_SIZE as the boundary between staying single and becoming a cluster', () => {
    // Sanity-checks the constant itself hasn't silently changed underneath
    // the tests above, which all assume MIN_SIZE === 2.
    expect(CLUSTER_MIN_SIZE).toBe(2)
  })

  it('groups three or more nearby drivers into one cluster carrying every one of them', () => {
    const { clusters } = clusterDriverActivity([driver('a', 32, -96), driver('b', 32.01, -96.01), driver('c', 31.99, -95.99)], 0)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].drivers).toHaveLength(3)
    expect(clusters[0].id).toBe('a+b+c')
  })

  it('positions a cluster at the plain average of its members, not an arbitrary member', () => {
    const { clusters } = clusterDriverActivity([driver('a', 32, -96), driver('b', 32.02, -96.02)], 0)
    expect(clusters[0].position).toEqual({ lat: (32 + 32.02) / 2, lng: (-96 + -96.02) / 2 })
  })
})

// T3 Break and Rest Planning, Task 8: the live map's break-point layer.
// Reads from the cockpit store's `breakPlanByLoadId` shape directly (a
// plain Record, not the store itself — same "take already-computed data,
// not a store instance" convention every other function in this file
// follows) rather than fetching or deriving anything of its own.
describe('breakMarkers', () => {
  const routed = (over: Partial<BreakPlanEntry> = {}): BreakPlanEntry => ({
    atMs: 1000, at: { lat: 39.1, lng: -94.58 }, precision: 'routed', options: [], hasCoverage: true, ...over,
  })

  it('returns [] for a plan whose entries array is empty (needs no break)', () => {
    expect(breakMarkers({ l1: { entries: [], known: true } })).toEqual([])
  })

  it('returns [] for a load id with no entry in the map at all — never evaluated this session', () => {
    expect(breakMarkers({})).toEqual([])
  })

  // Global Constraint 1 / Ruling 7: a break point derived from assumed HOS
  // hours is fiction, not merely low-confidence — it must render nothing,
  // the same as if the load had never been evaluated at all.
  it('returns [] when known is false, even though real entries are present', () => {
    expect(breakMarkers({ l1: { entries: [routed()], known: false } })).toEqual([])
  })

  // The engine could not place this break point (e.g. a deadhead leg with
  // no resolved destination) — it cannot be drawn on a map with no coordinate.
  it('a break whose `at` is null produces no marker', () => {
    expect(breakMarkers({ l1: { entries: [routed({ at: null })], known: true } })).toEqual([])
  })

  it('produces one marker for a known plan with one placeable entry, carrying every field through', () => {
    const entry = routed({ atMs: 4242, precision: 'estimated', hasCoverage: false, options: [] })
    const [marker] = breakMarkers({ l1: { entries: [entry], known: true } })
    expect(marker).toEqual({ loadId: 'l1', atMs: 4242, at: { lat: 39.1, lng: -94.58 }, precision: 'estimated', hasCoverage: false, options: [] })
  })

  it('a long enough haul can need more than one break — both entries for the same load are rendered', () => {
    const first = routed({ atMs: 1000 })
    const second = routed({ atMs: 5000, at: { lat: 41.0, lng: -93.0 } })
    const markers = breakMarkers({ l1: { entries: [first, second], known: true } })
    expect(markers.map((m) => m.atMs)).toEqual([1000, 5000])
  })

  it('mixes placeable and unplaceable entries for the same load correctly — only the placeable one renders', () => {
    const markers = breakMarkers({ l1: { entries: [routed({ atMs: 1000, at: null }), routed({ atMs: 2000 })], known: true } })
    expect(markers).toHaveLength(1)
    expect(markers[0].atMs).toBe(2000)
  })

  it('covers every load id present, independently', () => {
    const markers = breakMarkers({
      l1: { entries: [routed({ atMs: 1000 })], known: true },
      l2: { entries: [], known: true }, // needs no break
      l3: { entries: [routed({ atMs: 2000 })], known: false }, // HOS unknown
    })
    expect(markers.map((m) => m.loadId)).toEqual(['l1'])
  })
})
