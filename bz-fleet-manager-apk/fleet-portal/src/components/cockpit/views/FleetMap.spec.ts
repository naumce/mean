import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// mapbox-gl needs WebGL, which jsdom doesn't have, so it's mocked wholesale.
// The fakes below are just enough of the real API surface (Map/Marker/
// LngLatBounds) to let FleetMap run its normal code path, while recording
// every constructor call and mutation so the tests can assert on exactly
// what FleetMap passed to Mapbox — marker count/coordinates, the fitBounds
// extent, and the click wiring — rather than merely that it mounts.
const mocks = vi.hoisted(() => {
  class FakeGeoJSONSource {
    data: unknown = null
    setData(d: unknown): this {
      this.data = d
      return this
    }
  }
  class FakeMarker {
    el: HTMLElement
    ll: [number, number] | null = null
    onMap = false
    removed = false
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element
      mocks.markers.push(this)
    }
    setLngLat(ll: [number, number]): this {
      // Enforce what the real library enforces. mapbox-gl throws
      // "LngLatLike argument must be specified…" for anything that is not a
      // pair of finite numbers, and a lenient mock here shipped exactly that
      // bug to the browser once already.
      if (!Array.isArray(ll) || ll.length !== 2 || !ll.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error(`LngLatLike argument must be [lng, lat]; got ${JSON.stringify(ll)}`)
      }
      this.ll = ll
      return this
    }
    addTo(): this {
      // The real Marker projects its position on the next frame, so adding one
      // that has never been given a LngLat throws. Reproduce that here: it is
      // the difference between a test that passes and a map that works.
      if (this.ll === null) throw new Error('Marker.addTo() called before setLngLat() — mapbox-gl will throw on the next frame')
      this.onMap = true
      return this
    }
    remove(): this {
      this.removed = true
      this.onMap = false
      return this
    }
    getElement(): HTMLElement {
      return this.el
    }
  }
  class FakeBounds {
    points: [number, number][] = []
    extend(p: [number, number]): this {
      this.points.push(p)
      return this
    }
  }
  class FakeMap {
    opts: Record<string, unknown>
    sources = new Map<string, FakeGeoJSONSource>()
    layers: Record<string, unknown>[] = []
    removed = false
    fitBoundsCall: { bounds: FakeBounds; opts: unknown } | null = null
    // T2 "Map as Navigation", Task 9: the fake map's own zoom state, read by
    // FleetMap's `sync()` via `getZoom()` to decide whether truck markers
    // should cluster. Initialised from the constructor's `zoom` option (the
    // real mapboxgl.Map does the same) and mutable only through
    // `setZoomForTest` — NOT part of the real mapbox-gl API, a test-only
    // hook so a spec can simulate "the dispatcher zoomed out/in" the same
    // way `fire()` simulates any other real map event.
    zoom: number
    // T2 Task 4 (follow-up): every non-'load' registration is kept, keyed by
    // event name, so a test can simulate a real map event (a background
    // click) via `fire()` below — real mapbox-gl only fires `map`'s own
    // 'click' for a genuine canvas click; a Marker's DOM element sits
    // outside the canvas and never bubbles into it, so this never fires for
    // a marker/pin click, matching that real behaviour.
    listeners: Record<string, Array<(arg?: unknown) => void>> = {}
    /** What `queryRenderedFeatures` should return, keyed by layer id. Tests
     *  set this to stage "the pointer is over route X". */
    hits: Record<string, Array<{ properties: Record<string, unknown> }>> = {}
    /** Every setPaintProperty call, keyed layer -> property -> last value, so
     *  a test can assert on the focus dimming FleetMap applied. */
    paint: Record<string, Record<string, unknown>> = {}
    canvas = { style: { cursor: '' } as { cursor: string } }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.zoom = typeof opts.zoom === 'number' ? opts.zoom : 0
      mocks.maps.push(this)
    }
    getZoom(): number {
      return this.zoom
    }
    setZoomForTest(z: number): void {
      this.zoom = z
    }
    getCanvas(): { style: { cursor: string } } {
      return this.canvas
    }
    getLayer(id: string): Record<string, unknown> | undefined {
      return this.layers.find((l) => l.id === id)
    }
    setPaintProperty(layer: string, prop: string, value: unknown): void {
      // Real mapbox-gl throws "There is no layer with this ID" here. A lenient
      // mock would let a typo'd layer id pass every test and do nothing at all
      // in the browser — the exact shape of the bug that left every marker on
      // this map inert for a release.
      if (!this.getLayer(layer)) throw new Error(`setPaintProperty: there is no layer with id "${layer}"`)
      ;(this.paint[layer] ??= {})[prop] = value
    }
    queryRenderedFeatures(_point: unknown, opts?: { layers?: string[] }): Array<{ properties: Record<string, unknown> }> {
      const out: Array<{ properties: Record<string, unknown> }> = []
      for (const l of opts?.layers ?? []) {
        // Querying a layer that was never added returns [] in the real
        // library — silently, forever. Asserting it exists turns "the click
        // handler quietly never matches" into a failing test.
        if (!this.getLayer(l)) throw new Error(`queryRenderedFeatures: there is no layer with id "${l}"`)
        out.push(...(this.hits[l] ?? []))
      }
      return out
    }
    on(evt: string, layerOrCb: string | ((arg?: unknown) => void), maybeCb?: (arg?: unknown) => void): this {
      // mapbox-gl's layer-scoped overload: on(type, layerId, listener).
      if (typeof layerOrCb === 'string') {
        if (!this.getLayer(layerOrCb)) throw new Error(`on("${evt}"): there is no layer with id "${layerOrCb}"`)
        ;(this.listeners[`${evt}:${layerOrCb}`] ??= []).push(maybeCb!)
        return this
      }
      const cb = layerOrCb
      // Real mapbox-gl fires 'load' asynchronously once tiles/style are
      // ready; firing synchronously here just lets the tests skip an
      // arbitrary wait — FleetMap's own code doesn't assume either timing.
      if (evt === 'load') {
        cb()
        return this
      }
      // Captured so a test can prove a MARKER click never reaches the map's
      // own click handler. Real markers are DOM children of the map container,
      // so their clicks bubble to it; the map handler closes the popup, and
      // for one release every marker on this map opened a popup and closed it
      // in the same tick, looking completely inert.
      if (evt === 'click') mocks.mapClickHandlers.push(cb)
      ;(this.listeners[evt] ??= []).push(cb)
      return this
    }
    /** Test helper: simulate mapbox-gl firing `evt` (e.g. a background map
     *  click) by invoking every callback FleetMap registered for it. `arg` is
     *  the event object the real library passes — a click handler that reads
     *  `e.point` gets a real one here rather than undefined. */
    fire(evt: string, arg: unknown = { point: { x: 0, y: 0 }, lngLat: { lng: 0, lat: 0 } }): void {
      for (const cb of this.listeners[evt] ?? []) cb(arg)
    }
    addSource(id: string, src: { data: unknown }): FakeGeoJSONSource {
      const s = new FakeGeoJSONSource()
      s.data = src.data
      this.sources.set(id, s)
      return s
    }
    getSource(id: string): FakeGeoJSONSource | undefined {
      return this.sources.get(id)
    }
    addLayer(l: Record<string, unknown>): void {
      this.layers.push(l)
    }
    fitBounds(bounds: FakeBounds, opts: unknown): void {
      this.fitBoundsCall = { bounds, opts }
    }
    remove(): void {
      this.removed = true
    }
  }
  return {
    FakeMap,
    FakeMarker,
    FakeBounds,
    maps: [] as InstanceType<typeof FakeMap>[],
    mapClickHandlers: [] as (() => void)[],
    markers: [] as InstanceType<typeof FakeMarker>[],
  }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: mocks.FakeMap, Marker: mocks.FakeMarker, LngLatBounds: mocks.FakeBounds },
}))

import { mount, type VueWrapper } from '@vue/test-utils'
import { pathMiles } from '../../../lib/cockpit/routeCard'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { BreakPlanEntry } from '../../../lib/api'
import { NO_CARRIER_COLOR, STATUS_COLOR } from '../../../lib/cockpit/mapData'
import { routePath, splitAtProgress } from '../../../lib/cockpit/mapGeometry'
import { useCarriersStore, type Carrier } from '../../../stores/carriers'
import { useCockpitStore } from '../../../stores/cockpit'
import { useFleetStore, type ServiceShop } from '../../../stores/fleet'
import { useLoadboardStore, type BoardLoad, type BoardTrailer } from '../../../stores/loadboard'
import { useTrackingStore } from '../../../stores/tracking'
import FleetMap from './FleetMap.vue'

const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const D = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const stops = (a: [number, number], b: [number, number]): BoardLoad['stops'] => [
  { sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: a[0], lng: a[1], dwellMin: 60, windowStart: null, windowEnd: null },
  { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: b[0], lng: b[1], dwellMin: 60, windowStart: null, windowEnd: null },
]
// A bare, non-position trailer record — every test below overrides only the
// three T2 Task 7 GPS fields (lastLat/lastLng/lastSeenAt) it cares about.
const trailer = (over: Partial<BoardTrailer>): BoardTrailer => ({
  id: 't1', unit: 'FB-3310', type: 'Flatbed', length: "48'", status: 'active', features: null,
  inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: null,
  lastLat: null, lastLng: null, lastSeenAt: null, ...over,
})

function truckEls() {
  return mocks.markers.filter((m) => m.el.dataset.testid === 'truck-marker')
}
function truckClusterEls() {
  return mocks.markers.filter((m) => m.el.dataset.testid === 'truck-cluster-marker')
}
function stopEls() {
  return mocks.markers.filter((m) => m.el.dataset.testid === 'stop-marker')
}
function trailerEls() {
  return mocks.markers.filter((m) => m.el.dataset.testid === 'trailer-marker')
}
function shopEls() {
  return mocks.markers.filter((m) => m.el.dataset.testid === 'shop-marker')
}
function breakEls() {
  return mocks.markers.filter((m) => m.el.dataset.testid === 'break-marker')
}
function truckFor(driverId: string) {
  const m = truckEls().find((t) => t.el.dataset.driverId === driverId)
  if (!m) throw new Error(`no truck marker for ${driverId}`)
  return m
}
function trailerFor(trailerId: string) {
  const m = trailerEls().find((t) => t.el.dataset.trailerId === trailerId)
  if (!m) throw new Error(`no trailer marker for ${trailerId}`)
  return m
}
function shopFor(shopId: string) {
  const m = shopEls().find((s) => s.el.dataset.shopId === shopId)
  if (!m) throw new Error(`no shop marker for ${shopId}`)
  return m
}

describe('FleetMap', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.testtoken')
    mocks.maps.length = 0
    mocks.markers.length = 0
    const lb = useLoadboardStore()
    lb.lanes = [
      { id: 'd1', name: 'Jake Morrow', status: 'active', lastLat: 38.95, lastLng: -92.33 },
      { id: 'd7', name: 'Chuck Baker', status: 'active', lastLat: 43.04, lastLng: -87.91 },
    ]
    lb.loads = [
      {
        id: 'l1', reference: 'L-1', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null,
        revenueCents: 1, stopCount: 2, origin: 'Kansas City', destination: 'Chicago', stops: stops([39.1, -94.58], [41.88, -87.63]),
        assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - 2 * H), plannedEnd: iso(NOW + 2 * H), marginCents: 1 },
      },
    ]
    useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Jake Morrow', latitude: 40.5, longitude: -91, speed: 58, createdAt: iso(NOW - 60_000) }]
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.unstubAllEnvs()
  })

  it('creates the map once, with the dark style and the configured (public) token', () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    expect(mocks.maps).toHaveLength(1)
    expect(mocks.maps[0].opts.style).toBe('mapbox://styles/mapbox/dark-v11')
    expect(mocks.maps[0].opts.accessToken).toBe('pk.testtoken')
  })

  // Regression: every marker on this map was inert.
  //
  // Mapbox marker elements are DOM children of the map container, so a click on
  // one BUBBLES to the container — where FleetMap registers `m.on('click', () =>
  // closePopup())` to dismiss the popup when you click empty map. Opening a popup
  // and closing it therefore happened in the same tick: click a truck, a trailer,
  // a stop, a shop, a break pin or a route POI and nothing at all appeared. It
  // shipped that way and was reported as "no information on click".
  //
  // This mounts the REAL component and clicks a marker it actually created — an
  // earlier version of this test built its own element and asserted that
  // stopPropagation stops propagation, which is a tautology that would pass
  // while FleetMap stayed broken.
  it('a truck marker click does not run the handler that closes the popup', () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })

    const marker = truckEls()[0]
    expect(marker, 'expected the shared fixtures to produce a truck marker').toBeTruthy()
    expect(
      mocks.mapClickHandlers.length,
      'FleetMap should register a map-level click handler (the one that closes the popup)',
    ).toBeGreaterThan(0)

    // Reproduce the real DOM relationship: a mapbox marker element is a CHILD
    // of the map container, and the container is what the map's own click
    // handler is bound to.
    let mapHandlerRan = false
    const container = document.createElement('div')
    container.addEventListener('click', () => { mapHandlerRan = true })
    container.appendChild(marker.el)
    document.body.appendChild(container)

    marker.el.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(
      mapHandlerRan,
      'a marker click reached the map handler — the popup will close in the same tick it opens',
    ).toBe(false)
    document.body.removeChild(container)
  })

  it('never constructs a map when no token is configured', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '')
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    expect(mocks.maps).toHaveLength(0)
  })

  it('draws the route as a bowed arc through every stop, not a straight first-to-last chord, coloured by status, split at the truck’s progress', () => {
    // This used to assert a bare two-point LineString ([pickup, delivery]) —
    // that assertion was describing the T2 "map as navigation" bug itself
    // (a Kansas City -> Memphis load drawing as a chord straight across the
    // country). The route now comes from mapGeometry's `routePath`, the same
    // curve RadarView's schematic draws; asserting against that shared
    // function keeps this test from re-encoding the old straight-line bug.
    //
    // T2 Task 2: the arc is now split into two features — `part: 'done'`/
    // `part: 'remaining'` — at the load's elapsed share (plannedStart
    // NOW-2H, plannedEnd NOW+2H -> halfway, t=0.5).
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const source = mocks.maps[0].sources.get('fleet-map-routes')
    const data = source!.data as { features: Array<{ properties: { status: string; loadId: string; part: string }; geometry: { coordinates: number[][] } }> }
    const fullPath = routePath([
      [-94.58, 39.1],
      [-87.63, 41.88],
    ])
    const { done, remaining } = splitAtProgress(fullPath, 0.5)
    expect(data.features).toHaveLength(2)
    const doneFeature = data.features.find((f) => f.properties.part === 'done')!
    const remainingFeature = data.features.find((f) => f.properties.part === 'remaining')!
    expect(doneFeature.properties).toEqual({ status: 'in_progress', loadId: 'l1', part: 'done' })
    expect(remainingFeature.properties).toEqual({ status: 'in_progress', loadId: 'l1', part: 'remaining' })
    expect(doneFeature.geometry.coordinates).toEqual(done)
    expect(remainingFeature.geometry.coordinates).toEqual(remaining)
    // No gap at the split: the two halves share their boundary point exactly
    // — a mismatch here is what renders as a visible break in the line right
    // at the truck.
    expect(doneFeature.geometry.coordinates[doneFeature.geometry.coordinates.length - 1]).toEqual(remainingFeature.geometry.coordinates[0])
    // Still starts and ends exactly on the pickup/delivery coordinates.
    expect(doneFeature.geometry.coordinates[0]).toEqual([-94.58, 39.1])
    expect(remainingFeature.geometry.coordinates[remainingFeature.geometry.coordinates.length - 1]).toEqual([-87.63, 41.88])
    expect(fullPath.length).toBeGreaterThan(2) // it's an arc, not a chord
  })

  it('an assigned-but-not-started leg draws no completed portion at all — not a sliver', () => {
    const lb = useLoadboardStore()
    lb.loads = [
      {
        id: 'l2', reference: 'L-2', status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null,
        revenueCents: 1, stopCount: 2, origin: 'Kansas City', destination: 'Chicago', stops: stops([39.1, -94.58], [41.88, -87.63]),
        assignment: { id: 'a2', driverId: 'd1', status: 'assigned', plannedStart: iso(NOW + H), plannedEnd: iso(NOW + 3 * H), marginCents: 1 },
      },
    ]
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const source = mocks.maps[0].sources.get('fleet-map-routes')
    const data = source!.data as { features: Array<{ properties: { status: string; loadId: string; part: string } }> }
    // No "done" feature at all — a leg that hasn't started must never draw
    // even a few percent as already-driven.
    expect(data.features.some((f) => f.properties.part === 'done')).toBe(false)
    expect(data.features).toHaveLength(1)
    expect(data.features[0].properties).toEqual({ status: 'assigned', loadId: 'l2', part: 'remaining' })
  })

  it('a completed leg draws entirely as the dimmed "done" half — nothing left remaining', () => {
    const lb = useLoadboardStore()
    lb.loads = [
      {
        id: 'l3', reference: 'L-3', status: 'completed', requiredEquip: 'DryVan', hazmatClass: null,
        revenueCents: 1, stopCount: 2, origin: 'Kansas City', destination: 'Chicago', stops: stops([39.1, -94.58], [41.88, -87.63]),
        assignment: { id: 'a3', driverId: 'd1', status: 'completed', plannedStart: iso(NOW - 3 * H), plannedEnd: iso(NOW - H), marginCents: 1 },
      },
    ]
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const source = mocks.maps[0].sources.get('fleet-map-routes')
    const data = source!.data as { features: Array<{ properties: { status: string; loadId: string; part: string } }> }
    expect(data.features).toHaveLength(1)
    expect(data.features[0].properties).toEqual({ status: 'completed', loadId: 'l3', part: 'done' })
  })

  it("adds the route layers' colour expression using the same STATUS_COLOR palette the schematic keys off, done dimmed and remaining at full strength", () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const layers = mocks.maps[0].layers as Array<{ id: string; filter: unknown[]; paint: { 'line-color': unknown[]; 'line-opacity': number } }>
    const doneLayer = layers.find((l) => l.id === 'fleet-map-routes-done')!
    const remainingLayer = layers.find((l) => l.id === 'fleet-map-routes-remaining')!
    expect(doneLayer).toBeTruthy()
    expect(remainingLayer).toBeTruthy()
    for (const layer of [doneLayer, remainingLayer]) {
      expect(layer.paint['line-color']).toContain(STATUS_COLOR.in_progress)
      expect(layer.paint['line-color']).toContain(STATUS_COLOR.assigned)
    }
    expect(doneLayer.filter).toEqual(['==', ['get', 'part'], 'done'])
    expect(remainingLayer.filter).toEqual(['==', ['get', 'part'], 'remaining'])
    // The whole point: completed reads as background, remaining reads as active.
    expect(doneLayer.paint['line-opacity']).toBeLessThan(remainingLayer.paint['line-opacity'])
  })

  it('adds a pickup and a delivery pin for each route, at the exact stop coordinates', () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const found = stopEls()
    expect(found).toHaveLength(2)
    expect(found.find((s) => s.el.dataset.kind === 'pickup')?.ll).toEqual([-94.58, 39.1])
    expect(found.find((s) => s.el.dataset.kind === 'delivery')?.ll).toEqual([-87.63, 41.88])
  })

  it('renders one truck marker per driver, labelled with initials, positioned ping-preferred / lane-fallback', () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const trucks = truckEls()
    expect(trucks).toHaveLength(2)
    const d1 = truckFor('d1')
    expect(d1.el.textContent).toBe('JM')
    expect(d1.ll).toEqual([-91, 40.5]) // fresh ping, not the interpolated in-progress point
    const d7 = truckFor('d7')
    expect(d7.el.textContent).toBe('CB')
    expect(d7.ll).toEqual([-87.91, 43.04]) // no ping -> lane lastLat/lastLng
  })

  it('interpolates a rolling leg along the route by elapsed time when there is no fresh ping', () => {
    useTrackingStore().locations = []
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const d1 = truckFor('d1')
    // plannedStart NOW-2H, plannedEnd NOW+2H -> halfway elapsed -> midpoint of pickup/delivery
    expect(d1.ll![0]).toBeCloseTo((-94.58 + -87.63) / 2, 5)
    expect(d1.ll![1]).toBeCloseTo((39.1 + 41.88) / 2, 5)
  })

  it('fits the map to every route endpoint and driver position exactly once, with padding', () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const call = mocks.maps[0].fitBoundsCall
    expect(call).toBeTruthy()
    expect((call!.opts as { padding: number }).padding).toBe(48)
    expect(call!.bounds.points).toEqual(
      expect.arrayContaining([
        [-94.58, 39.1],
        [-87.63, 41.88],
        [-87.91, 43.04],
      ]),
    )
  })

  // T2 "Map as Navigation", Task 5: the reverse jump — the board's "Show on
  // map" sets `cockpit.mapFocusLoadId` before FleetMap mounts (switching
  // `view` to 'radar' unmounts GanttBoard and mounts FleetMap fresh — see
  // CockpitView.vue's v-if/v-else-if), so FleetMap picks it up on its very
  // first `sync()` and must centre on THAT load's own points instead of the
  // ordinary aggregate fit over every route/driver in view.
  describe('T2 Task 5: "Show on map" centring', () => {
    it('centres on the requested load\'s own geocoded stops, not the aggregate of every route/driver in view', () => {
      const ck = useCockpitStore()
      ck.mapFocusLoadId = 'l1'
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const call = mocks.maps[0].fitBoundsCall
      expect(call).toBeTruthy()
      // Exactly l1's pickup then delivery — NOT d7's parked position
      // ([-87.91, 43.04]), which the ordinary aggregate fit (asserted a few
      // tests above) does include.
      expect(call!.bounds.points).toEqual([
        [-94.58, 39.1],
        [-87.63, 41.88],
      ])
    })

    it('consumes the pending request (clears mapFocusLoadId) so a later sync does not re-centre on it', async () => {
      const ck = useCockpitStore()
      ck.mapFocusLoadId = 'l1'
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(ck.mapFocusLoadId).toBeNull()
      const firstCall = mocks.maps[0].fitBoundsCall

      // A later reactive sync (a ping update) must not fit again — the
      // request was one-shot, and boundsFitted is now true either way.
      useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Jake Morrow', latitude: 41, longitude: -90, speed: 60, createdAt: iso(NOW - 10_000) }]
      await nextTick()
      expect(mocks.maps[0].fitBoundsCall).toBe(firstCall)
    })

    // The invariant this whole task exists to protect: a load with nothing
    // honest to centre on (no geocoded stops, no known driver position — the
    // same case MasterDrawer's "Show on map" button is disabled for) must
    // never produce a jump to a default/invented coordinate. Falling back to
    // the ordinary aggregate fit is the honest behaviour — the same view a
    // dispatcher would have landed on arriving at the map with no focus
    // request at all.
    it('falls back to the ordinary aggregate fit for a load with no geocoded stops and no known driver position', () => {
      const lb = useLoadboardStore()
      lb.loads = [...lb.loads, { id: 'l2', reference: 'L-2', status: 'open', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 0, origin: 'Denver', destination: 'Reno', assignment: null }]
      const ck = useCockpitStore()
      ck.mapFocusLoadId = 'l2'
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(ck.mapFocusLoadId).toBeNull()
      const call = mocks.maps[0].fitBoundsCall
      expect(call).toBeTruthy()
      expect(call!.bounds.points).toEqual(
        expect.arrayContaining([
          [-94.58, 39.1],
          [-87.63, 41.88],
          [-87.91, 43.04],
        ]),
      )
    })

    it('falls back to the ordinary aggregate fit for a stale/unknown focus load id rather than throwing', () => {
      const ck = useCockpitStore()
      ck.mapFocusLoadId = 'does-not-exist'
      expect(() => {
        wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      }).not.toThrow()
      expect(ck.mapFocusLoadId).toBeNull()
      expect(mocks.maps[0].fitBoundsCall).toBeTruthy()
    })
  })

  // The ordinary case (no pending focus request) — Task 5 must not have
  // disturbed this. The "fits... exactly once" test above already covers the
  // first fit; this is the discriminating half: a SECOND reactive sync must
  // not fit again. Naming the assertion this proves: `fitBoundsCall` stays
  // the SAME object reference — a `boundsFitted` guard that regressed to
  // "always fit" would replace it with a new object here and fail this.
  it('ordinary case: does not re-fit bounds on a later reactive sync once already fitted once', async () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const firstCall = mocks.maps[0].fitBoundsCall
    expect(firstCall).toBeTruthy()
    useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Jake Morrow', latitude: 41, longitude: -90, speed: 60, createdAt: iso(NOW - 10_000) }]
    await nextTick()
    expect(mocks.maps[0].fitBoundsCall).toBe(firstCall)
  })

  // T2 "Map as Navigation", Task 4: clicking a marker used to jump straight to
  // the board (emit('open', loadId)). It now opens MapPopup instead — the
  // jump only happens once a dispatcher reads what's there and clicks "Show
  // on board" inside it. See the "map popup" describe block below for the
  // popup's own content; these two just cover which target FleetMap hands it.
  it('clicking a truck marker tied to an active load opens the truck popup for that load', async () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    truckFor('d1').el.click()
    await nextTick()
    const popup = wrapper.get('[data-testid="map-popup"]')
    expect(popup.attributes('data-kind')).toBe('truck')
    expect(popup.get('[data-testid="popup-title"]').text()).toBe('L-1')
  })

  it('clicking an idle (parked) truck marker opens the driver popup, not the truck popup', async () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    truckFor('d7').el.click()
    await nextTick()
    const popup = wrapper.get('[data-testid="map-popup"]')
    expect(popup.attributes('data-kind')).toBe('driver')
    expect(popup.get('[data-testid="popup-title"]').text()).toBe('Chuck Baker')
  })

  it('badges a truck behind schedule with the risk severity and a tooltip, and leaves a clean truck unmarked', () => {
    const lb = useLoadboardStore()
    lb.risks = [
      { assignmentId: 'a1', loadId: 'l1', ref: 'L-1', driverId: 'd1', driverName: 'Jake Morrow', kind: 'behind_schedule', severity: 'block', detail: 'Projected 40m late', deadline: iso(NOW + H), projectedArrival: iso(NOW + H + 40 * 60_000), slackMin: -40 },
    ]
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const d1 = truckFor('d1')
    expect(d1.el.dataset.risk).toBe('block')
    expect(d1.el.title).toBe('Projected 40m late')
    const d7 = truckFor('d7')
    expect(d7.el.dataset.risk).toBe('')
    expect(d7.el.title).toBe('')
  })

  it('moves a truck marker in place on a ping update instead of recreating it', async () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const before = truckFor('d1')
    expect(truckEls()).toHaveLength(2)

    useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Jake Morrow', latitude: 41, longitude: -90, speed: 60, createdAt: iso(NOW - 10_000) }]
    await nextTick()

    expect(truckEls()).toHaveLength(2) // still exactly one marker per driver — no rebuild
    const after = truckFor('d1')
    expect(after).toBe(before) // the same marker instance, just moved
    expect(after.ll).toEqual([-90, 41])
  })

  it('removes the map instance on unmount, releasing the WebGL context', () => {
    wrapper = mount(FleetMap, { props: { nowMs: NOW } })
    const m = mocks.maps[0]
    wrapper.unmount()
    wrapper = null
    expect(m.removed).toBe(true)
  })

  // T2 "Map as Navigation", Task 3: rolling/parked/no_gps must be
  // distinguishable at a glance, and a no_gps driver is the product
  // invariant this task exists to enforce — never drawn at a
  // fallback/default/last-org coordinate, only listed as "position unknown"
  // alongside the map.
  describe('rolling / parked / no_gps states', () => {
    it('draws a rolling driver (in_progress leg) filled, and a parked driver (known position, no active leg) hollow — visually distinct', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const rolling = truckFor('d1') // on l1, in_progress
      const parked = truckFor('d7') // no assigned load, lastLat/lastLng only
      expect(rolling.el.dataset.filled).toBe('true')
      expect(parked.el.dataset.filled).toBe('false')
      expect(rolling.el.dataset.filled).not.toBe(parked.el.dataset.filled)
    })

    it('creates no marker at all for a driver with neither a live ping nor a lastLat/lastLng, and lists them as position unknown', () => {
      const lb = useLoadboardStore()
      lb.lanes = [...lb.lanes, { id: 'd9', name: 'Nia Okoye', status: 'active' }]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckEls().find((t) => t.el.dataset.driverId === 'd9')).toBeUndefined()
      expect(truckEls()).toHaveLength(2) // only d1 (rolling) and d7 (parked) — d9 gets no marker
      const list = wrapper.get('[data-testid="position-unknown-list"]')
      const item = list.get('[data-driver-id="d9"]')
      expect(item.text()).toContain('Nia Okoye')
    })

    it('does not render a position-unknown list when every driver has a known position', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(wrapper.find('[data-testid="position-unknown-list"]').exists()).toBe(false)
    })

    it('never includes a no_gps driver in the map bounds fit', () => {
      const lb = useLoadboardStore()
      lb.lanes = [...lb.lanes, { id: 'd9', name: 'Nia Okoye', status: 'active' }]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const call = mocks.maps[0].fitBoundsCall
      // Every point in the fit is one of the two known route endpoints or
      // the two located drivers' positions — nothing invented for d9.
      expect(call!.bounds.points).toHaveLength(4)
      for (const [lng, lat] of call!.bounds.points) {
        expect(Number.isFinite(lng)).toBe(true)
        expect(Number.isFinite(lat)).toBe(true)
      }
    })

    // The discriminating check for this whole task: prove driverActivity's
    // no_gps rule actually does something by breaking it the way a real bug
    // would — falling back to a default/org coordinate instead of leaving
    // the position undefined — and watching this exact test fail. See
    // mapData.ts's `driverActivity`; this is intentionally redundant with
    // the "creates no marker at all…" test above, kept separate so it names
    // the one assertion that must never start passing again by accident.
    it('DISCRIMINATION CHECK: a no_gps driver must never receive a marker, even at a plausible fallback coordinate', () => {
      const lb = useLoadboardStore()
      lb.lanes = [...lb.lanes, { id: 'd9', name: 'Nia Okoye', status: 'active' }]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckEls().some((t) => t.el.dataset.driverId === 'd9')).toBe(false)
    })
  })

  // T2 "Map as Navigation", Task 9: fifty overlapping truck markers at
  // country zoom read as an unreadable blob — the first screen a dispatch
  // service (the actual buyer, running dozens of trucks) sees. Below
  // mapData.ts's CLUSTER_ZOOM_THRESHOLD, trucks within CLUSTER_RADIUS_DEG of
  // each other collapse into one summary bubble instead of drawing
  // individually. Deliberately scoped to truck markers only — trailer/stop/
  // shop pin code is untouched by this task, so those suites' invariants
  // (trailer age labels, stop/shop shapes, etc.) carry zero risk here; see
  // FleetMap.vue's own top-of-file doc for the full design rationale.
  describe('truck marker clustering (Task 9)', () => {
    const clusterLane = (id: string, lastLat: number, lastLng: number) => ({ id, name: id, status: 'active', lastLat, lastLng })

    it('groups several nearby trucks into one summary bubble instead of drawing them individually', () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [
        clusterLane('c1', 32.0, -96.0),
        clusterLane('c2', 32.03, -96.02),
        clusterLane('c3', 31.98, -95.97),
        clusterLane('c4', 32.05, -96.04),
        clusterLane('c5', 31.96, -95.95),
        clusterLane('c6', 32.02, -96.06),
      ]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      // No individual truck markers for any of the six — every one of them
      // is inside the bubble instead.
      expect(truckEls()).toHaveLength(0)
      expect(truckClusterEls()).toHaveLength(1)
      const bubble = truckClusterEls()[0]
      expect(bubble.el.textContent).toBe('6')
      expect(bubble.el.dataset.count).toBe('6')
      // Its own shape value — distinct from a truck's 'round', a trailer's
      // 'square', and a shop's 'diamond' — so it can never be mistaken for a
      // single marker of any kind.
      expect(bubble.el.dataset.shape).toBe('cluster')
    })

    // The discriminating half of the test above, and the assertion this
    // whole feature exists to protect: the demo fixture's two drivers
    // (d1/d7, set up in the outer beforeEach) are roughly 300 miles apart.
    // Widening CLUSTER_RADIUS_DEG far enough to merge them — or removing
    // the radius check entirely — would fail these two `expect`s. Verified
    // by hand while building this task: temporarily setting
    // CLUSTER_RADIUS_DEG to a very large value in mapData.ts makes this
    // exact test fail (truckClusterEls() becomes length 1, truckEls()
    // becomes length 0), and reverting the constant makes it pass again.
    it('does not cluster geographically distant trucks even at the default country zoom', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckClusterEls()).toHaveLength(0)
      expect(truckEls()).toHaveLength(2)
    })

    // The other discriminating half: the SAME nearby drivers, but zoomed in
    // past CLUSTER_ZOOM_THRESHOLD, must fall back to one marker per truck —
    // proving the bubble is a low-zoom summary, not a permanent replacement.
    // Verified by hand: forcing `clusterDriverActivity` to always cluster
    // (ignoring the zoom guard) makes `truckEls()` stay empty here instead
    // of reaching 3, failing this test.
    it('splits a cluster back into individual markers once zoomed in past the threshold', async () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.03, -96.02), clusterLane('c3', 31.98, -95.97)]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckClusterEls()).toHaveLength(1)
      const bubble = truckClusterEls()[0]

      mocks.maps[0].setZoomForTest(10)
      mocks.maps[0].fire('zoomend')
      await nextTick()

      expect(bubble.removed).toBe(true)
      expect(truckClusterEls().filter((c) => !c.removed)).toHaveLength(0)
      expect(truckEls()).toHaveLength(3)
      expect(truckFor('c1')).toBeTruthy()
      expect(truckFor('c2')).toBeTruthy()
      expect(truckFor('c3')).toBeTruthy()
    })

    it("dissolves a cluster back into an ordinary single marker once membership drops below two, with that marker's normal styling", async () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.02, -96.01)]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckClusterEls()).toHaveLength(1)

      lb.lanes = [clusterLane('c1', 32.0, -96.0)]
      await nextTick()

      expect(truckClusterEls().filter((c) => !c.removed)).toHaveLength(0)
      const solo = truckFor('c1')
      expect(solo.el.dataset.testid).toBe('truck-marker')
      expect(solo.el.dataset.shape).toBe('round')
    })

    it("creates a new bubble (and removes the old one) when a cluster's membership changes, rather than silently relabelling it", async () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.02, -96.01), clusterLane('c3', 31.98, -95.99)]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckClusterEls()).toHaveLength(1)
      const original = truckClusterEls()[0]
      expect(original.el.dataset.count).toBe('3')

      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.02, -96.01)]
      await nextTick()

      expect(original.removed).toBe(true)
      const live = truckClusterEls().filter((c) => !c.removed)
      expect(live).toHaveLength(1)
      expect(live[0].el.dataset.count).toBe('2')
    })

    it("moves a cluster bubble in place (same marker instance), recentring on its members' new positions, when membership doesn't change", async () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.02, -96.01), clusterLane('c3', 31.98, -95.99)]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const before = truckClusterEls()[0]

      lb.lanes = [clusterLane('c1', 32.01, -96.01), clusterLane('c2', 32.02, -96.01), clusterLane('c3', 31.98, -95.99)]
      await nextTick()

      const live = truckClusterEls().filter((c) => !c.removed)
      expect(live).toHaveLength(1)
      expect(live[0]).toBe(before) // moved, not rebuilt
      // Recentred to the plain average of its (new) members' positions.
      expect(live[0].ll![1]).toBeCloseTo((32.01 + 32.02 + 31.98) / 3, 5)
      expect(live[0].ll![0]).toBeCloseTo((-96.01 + -96.01 + -95.99) / 3, 5)
    })

    it("clicking a cluster bubble fits the map to its members' exact positions instead of opening a popup", async () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.02, -96.01), clusterLane('c3', 31.98, -95.99)]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const bubble = truckClusterEls()[0]

      bubble.el.click()
      await nextTick()

      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(false)
      const call = mocks.maps[0].fitBoundsCall
      expect(call).toBeTruthy()
      expect(call!.bounds.points).toEqual(
        expect.arrayContaining([
          [-96.0, 32.0],
          [-96.01, 32.02],
          [-95.99, 31.98],
        ]),
      )
    })

    // T2 Task 3's invariant still holds once clustering exists: a driver
    // with no known position is never folded into a cluster's count — it's
    // excluded from clustering the same way it was excluded from getting an
    // individual marker before this task (see `sync`'s filter, run BEFORE
    // clusterDriverActivity is ever called).
    it('never folds a no_gps driver into a nearby cluster\'s count', () => {
      const lb = useLoadboardStore()
      lb.loads = []
      lb.lanes = [clusterLane('c1', 32.0, -96.0), clusterLane('c2', 32.02, -96.01), { id: 'c9', name: 'No GPS Driver', status: 'active' }]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckClusterEls()).toHaveLength(1)
      expect(truckClusterEls()[0].el.dataset.count).toBe('2')
      const list = wrapper.get('[data-testid="position-unknown-list"]')
      const item = list.get('[data-driver-id="c9"]')
      expect(item.text()).toContain('No GPS Driver')
    })
  })

  // T2 "Map as Navigation", Task 7: trailers on the map, with their age.
  // "Where is trailer FB-3310?" is a question small fleets genuinely cannot
  // answer today; a dropped trailer with no age shown reads as current no
  // matter how stale it actually is, and a dispatcher will route to it. The
  // rule this whole task exists to enforce: a trailer pin ALWAYS states its
  // age, and a trailer with a position but no `lastSeenAt` is not rendered
  // at all — the same "absent shown as measured" bug already fixed four
  // times elsewhere in this codebase (see mapData.ts's `positionedTrailers`).
  describe('trailer pins (Task 7)', () => {
    it('renders a positioned trailer as a pin whose label/tooltip states its age', () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', unit: 'FB-3310', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - 3 * D) })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const pin = trailerFor('t1')
      expect(pin.ll).toEqual([-95.0, 39.5])
      // The age is not hidden behind a hover-only tooltip — it's printed on
      // the pin's own label (see FleetMap.vue's `makeTrailerMarker`) AND
      // repeated in the title, so both surfaces are checked.
      expect(pin.el.textContent).toContain('3d')
      expect(pin.el.title).toContain('FB-3310')
      expect(pin.el.title).toContain('3d')
    })

    // The rule's second half, and the more important one commercially: a
    // trailer's lastLat/lastLng/lastSeenAt are written together server-side
    // (see BoardTrailer's own doc) — this is the defensive check for if that
    // invariant is ever violated. Rendering this trailer at all, with no
    // date attached, is indistinguishable from a trailer positioned a
    // minute ago — exactly the failure the brief calls out by name.
    it('renders NO marker for a trailer with a position but no lastSeenAt', () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: null })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(trailerEls()).toHaveLength(0)
      expect(trailerEls().some((t) => t.el.dataset.trailerId === 't1')).toBe(false)
    })

    it('renders no marker for a never-positioned trailer (all three fields null)', () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1' })] // lastLat/lastLng/lastSeenAt all null, per the factory default
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(trailerEls()).toHaveLength(0)
    })

    it('renders only the positioned-and-timestamped trailer when trailers are mixed', () => {
      const lb = useLoadboardStore()
      lb.trailers = [
        trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) }), // positioned + aged: shown
        trailer({ id: 't2', lastLat: 40, lastLng: -96, lastSeenAt: null }), // position, no age: hidden
        trailer({ id: 't3' }), // never positioned: hidden
      ]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(trailerEls()).toHaveLength(1)
      expect(trailerEls()[0].el.dataset.trailerId).toBe('t1')
    })

    // T2 Task 8 (follow-up): a hooked trailer's stored lastLat/lastLng/
    // lastSeenAt are its last DROP-OFF point, not where it is now — Task 6
    // only stamps position on leg completion, never on pickup, so a hooked
    // trailer may be hours down the highway on a truck that's since driven
    // away. Rendering that as a pin was "stale shown as current": the same
    // "absent shown as measured" lie this codebase keeps fixing, just with
    // a timestamp attached to make it look trustworthy. A dispatcher scans
    // pins, not popups — the truck already has its own marker at the real
    // position, so a trailer gets one only when it's actually sitting
    // somewhere with no tractor.
    //
    // "Hooked" means an ACTIVE assignment (`activeDriverId`), never a
    // driver's mere default pairing (`currentDriverId`) — see the next test
    // for the case this discriminates against. t1 sets both fields, matching
    // what the real read model does when a trailer is actually on an active
    // leg (dispatcherLoadboard.ts's `cur` populates both currentDriverId and
    // activeDriverId together).
    it('renders NO marker for a trailer on an active assignment, even with a valid position and timestamp — a dropped one still renders', () => {
      const lb = useLoadboardStore()
      lb.trailers = [
        trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H), currentDriverId: 'd1', activeDriverId: 'd1' }), // hooked (active assignment): hidden
        trailer({ id: 't2', lastLat: 40, lastLng: -96, lastSeenAt: iso(NOW - H), currentDriverId: null, activeDriverId: null }), // dropped: shown
      ]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(trailerEls()).toHaveLength(1)
      expect(trailerEls()[0].el.dataset.trailerId).toBe('t2')
      expect(trailerEls().some((t) => t.el.dataset.trailerId === 't1')).toBe(false)
    })

    // THE BUG this codebase's own demo data exposed: `currentDriverId` is
    // ALSO set when a trailer is merely a driver's DEFAULT pairing
    // (dispatcherLoadboard.ts's `cur?.trailerId ?? d.defaultTrailerId`), with
    // no active assignment at all. Filtering the map on `currentDriverId`
    // (rather than the narrower `activeDriverId`) hid every trailer that
    // happened to also be someone's usual trailer — in the demo seed, all
    // three. A trailer that is merely paired-by-default, sitting dropped in
    // the yard, has an honest stored position and MUST render.
    it('renders a pin for a trailer that is only a driver\'s default pairing, not on an active assignment', () => {
      const lb = useLoadboardStore()
      lb.trailers = [
        trailer({ id: 't3', lastLat: 41.25, lastLng: -95.93, lastSeenAt: iso(NOW - 4 * D), currentDriverId: 'd1', activeDriverId: null }),
      ]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(trailerEls()).toHaveLength(1)
      expect(trailerEls()[0].el.dataset.trailerId).toBe('t3')
    })

    // Distinguishability: a trailer pin must never be mistaken for a truck
    // marker at a glance. `dataset.shape` is the attribute FleetMap.vue uses
    // to encode it (square trailer pin vs. round truck marker — see
    // `makeTrailerMarker`/`makeTruckMarker`), so that's what's asserted,
    // rather than a testid string that exists only for test selection.
    it('is visually distinguishable from a truck pin (shape encoding)', () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const trailerShape = trailerFor('t1').el.dataset.shape
      const truckShape = truckFor('d1').el.dataset.shape
      expect(trailerShape).toBeTruthy()
      expect(truckShape).toBeTruthy()
      expect(trailerShape).not.toBe(truckShape)
    })

    it('moves a trailer marker in place on a reload instead of recreating it', async () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const before = trailerFor('t1')

      lb.trailers = [trailer({ id: 't1', lastLat: 40, lastLng: -96, lastSeenAt: iso(NOW - H) })]
      await nextTick()

      expect(trailerEls()).toHaveLength(1) // no rebuild
      const after = trailerFor('t1')
      expect(after).toBe(before)
      expect(after.ll).toEqual([-96, 40])
    })

    // The age is computed off `props.nowMs`, CockpitView's shared clock tick
    // — the same reason `driverActivity`'s rolling interpolation re-derives
    // on every tick (see the top-level `watch` in FleetMap.vue). A trailer
    // pin that printed its age once at creation and never again would drift
    // from the truth the longer the map stayed open.
    it('recomputes the printed age as the clock advances, without recreating the marker', async () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const before = trailerFor('t1')
      expect(before.el.textContent).toContain('1h')

      await wrapper.setProps({ nowMs: NOW + 2 * D })

      expect(trailerEls()).toHaveLength(1) // no rebuild
      const after = trailerFor('t1')
      expect(after).toBe(before)
      expect(after.el.textContent).toContain('2d')
    })

    it('removes a trailer marker once it drops out of the loadboard response', async () => {
      // mocks.markers is an append-only log of every marker ever constructed
      // (see the outer beforeEach's reset) — a since-removed marker is still
      // findable in it, just flagged `.removed`. That flag, not a shrinking
      // trailerEls() count, is the correct thing to assert here (same
      // pattern the "removes the map instance on unmount" test above uses).
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const marker = trailerFor('t1')
      expect(marker.removed).toBe(false)

      lb.trailers = []
      await nextTick()
      expect(marker.removed).toBe(true)
    })

    // T2 "Map as Navigation", Task 8: trailer pins are clickable, same as
    // every other marker on this map — MapPopup's own content for the
    // trailer kind is unit-tested in MapPopup.spec.ts; this covers only
    // FleetMap's side of the wiring (which target a click produces), the
    // same division the truck/stop click tests below already use.
    it('clicking a trailer pin opens the trailer popup for that trailer', async () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', unit: 'FB-3310', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - 3 * D) })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      trailerFor('t1').el.click()
      await nextTick()
      const popup = wrapper.get('[data-testid="map-popup"]')
      expect(popup.attributes('data-kind')).toBe('trailer')
      expect(popup.get('[data-testid="popup-title"]').text()).toContain('FB-3310')
      expect(popup.get('[data-testid="popup-trailer-age"]').text()).toBe('3d')
    })
  })

  // T2 "Map as Navigation", Task 8: service-shop pins. The org's OWN shop
  // registry (stores/fleet.ts's ServiceShop) — free to show unconditionally
  // per spec R4 (it's a small, curated list, never a third-party "show all
  // truck stops" layer). MapPopup's own content for the shop kind (name,
  // phone) and the need-driven "nearest shop" surfacing are unit-tested in
  // MapPopup.spec.ts; this covers only FleetMap's side of the wiring — pin
  // placement, the shape encoding, and which target a click produces — the
  // same split every other pin kind on this map already uses.
  describe('shop pins (Task 8)', () => {
    const shop = (over: Partial<ServiceShop>): ServiceShop => ({ id: 's1', name: 'Ace Truck Repair', address: '123 Main St', lat: 39.5, lng: -95.0, phone: '555-0001', ...over })

    it('renders a pin for every geocoded shop, at its exact coordinates', () => {
      const fleet = useFleetStore()
      fleet.shops = [shop({ id: 's1', lat: 39.5, lng: -95.0 }), shop({ id: 's2', name: 'Diesel Doctors', lat: 41.0, lng: -93.0 })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(shopEls()).toHaveLength(2)
      expect(shopFor('s1').ll).toEqual([-95.0, 39.5])
      expect(shopFor('s2').ll).toEqual([-93.0, 41.0])
    })

    // Same rule as every other pin on this map: never a guessed coordinate.
    it('skips a shop with no lat/lng rather than placing it at a guessed coordinate', () => {
      const fleet = useFleetStore()
      fleet.shops = [shop({ id: 's1', lat: null, lng: null }), shop({ id: 's2', lat: 41.0, lng: -93.0 })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(shopEls()).toHaveLength(1)
      expect(shopEls()[0].el.dataset.shopId).toBe('s2')
    })

    // Distinguishability (required test 4): a shop pin must never be
    // mistaken for a truck or trailer pin at a glance. `dataset.shape` is
    // the attribute every pin on this map already encodes it with (see
    // makeTruckMarker's 'round' / makeTrailerMarker's 'square') — shop pins
    // get their own third value, asserted against both existing ones here.
    it('is visually distinguishable from truck and trailer pins (shape encoding)', () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })]
      const fleet = useFleetStore()
      fleet.shops = [shop({ id: 's1' })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const shopShape = shopFor('s1').el.dataset.shape
      const truckShape = truckFor('d1').el.dataset.shape
      const trailerShape = trailerFor('t1').el.dataset.shape
      expect(shopShape).toBeTruthy()
      expect(shopShape).not.toBe(truckShape)
      expect(shopShape).not.toBe(trailerShape)
    })

    it('clicking a shop pin opens the shop popup for that shop', async () => {
      const fleet = useFleetStore()
      fleet.shops = [shop({ id: 's1', name: 'Ace Truck Repair', phone: '555-0001' })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      shopFor('s1').el.click()
      await nextTick()
      const popup = wrapper.get('[data-testid="map-popup"]')
      expect(popup.attributes('data-kind')).toBe('shop')
      expect(popup.get('[data-testid="popup-title"]').text()).toBe('Ace Truck Repair')
      expect(popup.get('[data-testid="popup-shop-phone"]').text()).toBe('555-0001')
    })

    it('moves a shop pin in place on a reload instead of recreating it', async () => {
      const fleet = useFleetStore()
      fleet.shops = [shop({ id: 's1', lat: 39.5, lng: -95.0 })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const before = shopFor('s1')

      fleet.shops = [shop({ id: 's1', lat: 40, lng: -96 })]
      await nextTick()

      expect(shopEls()).toHaveLength(1) // no rebuild
      const after = shopFor('s1')
      expect(after).toBe(before)
      expect(after.ll).toEqual([-96, 40])
    })

    it('removes a shop pin once it drops out of the org\'s registry', async () => {
      const fleet = useFleetStore()
      fleet.shops = [shop({ id: 's1' })]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const marker = shopFor('s1')
      expect(marker.removed).toBe(false)

      fleet.shops = []
      await nextTick()
      expect(marker.removed).toBe(true)
    })

    // The gap this task actually closes: shop data never reached the
    // cockpit's live-map surface before this — `fleet.loadShops()` was only
    // ever called from FleetView (the /fleet route). FleetMap now triggers
    // it itself on mount (see FleetMap.vue's own doc on why here, not
    // CockpitView) — this is the proof that wiring fires, independent of
    // whatever the store's own `shops` state happens to already hold.
    it('loads the org\'s shop registry itself once the map mounts, rather than relying on another view to have fetched it first', () => {
      const fleet = useFleetStore()
      const spy = vi.spyOn(fleet, 'loadShops').mockResolvedValue()
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('never fetches shops when no Mapbox token is configured — the map never renders either', () => {
      vi.stubEnv('VITE_MAPBOX_TOKEN', '')
      const fleet = useFleetStore()
      const spy = vi.spyOn(fleet, 'loadShops').mockResolvedValue()
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(spy).not.toHaveBeenCalled()
    })
  })

  // T1 Carrier Layer, Task 9: truck markers switch from status-coloured to
  // carrier-coloured while the board is grouped by carrier. Colour comes
  // from mapData's `carrierColor`, which hashes the carrier *id* — never
  // useCarriersStore's `list` index, which reorders on every refetch (a
  // re-sort, a page, a carrier added/removed) with nothing about the
  // carriers themselves having changed.
  describe('carrier colouring (grouped by carrier)', () => {
    const carrierFor = (id: string, name: string): Carrier => ({
      id,
      name,
      mcNumber: null,
      dotNumber: null,
      status: 'active',
      mpg: null,
      dieselCentsPerGal: null,
      driverPayCentsPerMi: null,
      fixedCentsPerMi: null,
    })

    beforeEach(() => {
      const lb = useLoadboardStore()
      lb.lanes = [
        { id: 'd1', name: 'Jake Morrow', status: 'active', lastLat: 38.95, lastLng: -92.33, carrierId: 'c-acme', carrierName: 'Acme Trucking' },
        { id: 'd7', name: 'Chuck Baker', status: 'active', lastLat: 43.04, lastLng: -87.91, carrierId: 'c-globex', carrierName: 'Globex Freight' },
      ]
      useCockpitStore().setGroupBy('carrier')
    })

    it('gives two different carriers two different marker colours', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const c1 = truckFor('d1').el.dataset.color
      const c7 = truckFor('d7').el.dataset.color
      expect(c1).toBeTruthy()
      expect(c7).toBeTruthy()
      expect(c1).not.toBe(c7)
    })

    // The discriminating assertion: colouring by the carrier's position in
    // useCarriersStore's `list` (a plausible-looking first draft) would
    // repaint both trucks here, because the list — not the drivers, not
    // their carrier ids — is the only thing that changes between the two
    // mounts.
    it('keeps the same carrier the same colour across a refetch where the carriers list order changed', () => {
      const carriers = useCarriersStore()
      carriers.list = [carrierFor('c-acme', 'Acme Trucking'), carrierFor('c-globex', 'Globex Freight')]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const before1 = truckFor('d1').el.dataset.color
      const before7 = truckFor('d7').el.dataset.color
      wrapper.unmount()
      wrapper = null
      // The old (removed) marker instances are still sitting in mocks.markers
      // — truckFor()'s .find() would otherwise return mount #1's stale
      // element instead of mount #2's, making this assertion pass no matter
      // what the colour source is. Clear them, same as the outer beforeEach
      // does between tests.
      mocks.markers.length = 0

      carriers.list = [carrierFor('c-globex', 'Globex Freight'), carrierFor('c-acme', 'Acme Trucking')]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckFor('d1').el.dataset.color).toBe(before1)
      expect(truckFor('d7').el.dataset.color).toBe(before7)
    })

    it('renders a driver with no carrier in a distinct neutral colour, not one that reads as a real carrier', () => {
      const lb = useLoadboardStore()
      lb.lanes = [...lb.lanes, { id: 'd9', name: 'Nia Okoye', status: 'active', lastLat: 41.5, lastLng: -88, carrierId: null, carrierName: null }]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const none = truckFor('d9').el.dataset.color
      expect(none).toBe(NO_CARRIER_COLOR)
      expect(none).not.toBe(truckFor('d1').el.dataset.color)
      expect(none).not.toBe(truckFor('d7').el.dataset.color)
    })

    it('names the carrier in the marker tooltip', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckFor('d1').el.title).toBe('Acme Trucking')
      expect(truckFor('d7').el.title).toBe('Globex Freight')
    })

    it('says plainly there is no carrier for an unassigned driver', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd9', name: 'Nia Okoye', status: 'active', lastLat: 41.5, lastLng: -88, carrierId: null, carrierName: null }]
      lb.loads = []
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(truckFor('d9').el.title).toBe('No carrier')
    })

    it('leaves status-based colouring and the risk tooltip untouched when not grouped by carrier', () => {
      useCockpitStore().setGroupBy('driver')
      const lb = useLoadboardStore()
      lb.risks = [
        { assignmentId: 'a1', loadId: 'l1', ref: 'L-1', driverId: 'd1', driverName: 'Jake Morrow', kind: 'behind_schedule', severity: 'block', detail: 'Projected 40m late', deadline: iso(NOW + H), projectedArrival: iso(NOW + H + 40 * 60_000), slackMin: -40 },
      ]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const d1 = truckFor('d1')
      expect(d1.el.dataset.color).toBe(STATUS_COLOR.in_progress)
      expect(d1.el.title).toBe('Projected 40m late')
    })
  })

  // T2 "Map as Navigation", Task 4: MapPopup itself is unit-tested in its own
  // spec (every field, every absent case, "Show on board"). These cover only
  // FleetMap's side of the wiring — which target a click produces, and the
  // open/close/switch toggle across markers. A raw `.click()` on a marker
  // element (not VTU's `.trigger()`) fires the DOM listener synchronously but
  // Vue's own render flush is still async, so every assertion on rendered
  // popup content below awaits a `nextTick()` first.
  describe('map popup', () => {
    function pickupPin() {
      const m = stopEls().find((s) => s.el.dataset.kind === 'pickup')
      if (!m) throw new Error('no pickup marker')
      return m
    }

    it('clicking a stop pin opens the stop popup for that end of the route', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      pickupPin().el.click()
      await nextTick()
      const popup = wrapper.get('[data-testid="map-popup"]')
      expect(popup.attributes('data-kind')).toBe('stop')
      expect(popup.get('[data-testid="popup-stop-type"]').text()).toBe('Pickup')
      expect(popup.get('[data-testid="popup-address"]').text()).toBe('Kansas City, MO')
    })

    it('clicking the same open marker again closes the popup (toggle)', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      truckFor('d1').el.click()
      await nextTick()
      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(true)
      truckFor('d1').el.click()
      await nextTick()
      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(false)
    })

    it('clicking a different marker while one popup is open switches straight to the new one', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      truckFor('d1').el.click()
      await nextTick()
      expect(wrapper.get('[data-testid="map-popup"]').attributes('data-kind')).toBe('truck')
      truckFor('d7').el.click()
      await nextTick()
      const popup = wrapper.get('[data-testid="map-popup"]')
      expect(popup.attributes('data-kind')).toBe('driver')
      expect(popup.get('[data-testid="popup-title"]').text()).toBe('Chuck Baker')
    })

    it('the popup close button dismisses it', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      truckFor('d1').el.click()
      await nextTick()
      await wrapper.get('[data-testid="popup-close"]').trigger('click')
      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(false)
    })

    it('"Show on board" from a marker popup switches the cockpit to the board view and selects that load', async () => {
      const ck = useCockpitStore()
      ck.setView('radar')
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      truckFor('d1').el.click()
      await nextTick()
      await wrapper.get('[data-testid="popup-show-on-board"]').trigger('click')
      expect(ck.view).toBe('board')
      expect(ck.selectedLoadId).toBe('l1')
    })

    // Every map product dismisses an open popup on a background click — its
    // absence reads as broken. mapbox-gl's own map 'click' event is the
    // right hook: it only fires for a genuine canvas click, never for a
    // click on a Marker's DOM element (which lives outside the canvas), so
    // this never fights the marker-click handling covered above.
    it('clicking the map background dismisses an open popup', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      truckFor('d1').el.click()
      await nextTick()
      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(true)
      mocks.maps[0].fire('click')
      await nextTick()
      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(false)
    })

    it('a background click is a no-op when no popup is open', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(() => mocks.maps[0].fire('click')).not.toThrow()
      expect(wrapper.find('[data-testid="map-popup"]').exists()).toBe(false)
    })
  })

  // T3 Break and Rest Planning, Task 8 (Ruling 7): the map's break-point
  // layer, reading the cockpit store's `breakPlanByLoadId` directly (the
  // store is populated by the gesture pipeline — see cockpit.spec.ts's own
  // coverage of that wiring; these tests only cover what FleetMap does once
  // that state exists). MapPopup's own content for the 'break' kind is
  // unit-tested in MapPopup.spec.ts; this covers pin placement, the R4/
  // Global-Constraint-1 "no marker" cases, the shape encoding, and which
  // target a click produces — the same split every other pin kind on this
  // map already uses.
  describe('break-point pins (Task 8, Ruling 7)', () => {
    const breakEntry = (over: Partial<BreakPlanEntry> = {}): BreakPlanEntry => ({
      atMs: 1000, at: { lat: 39.5, lng: -95.0 }, precision: 'routed', options: [], hasCoverage: true, ...over,
    })

    it('renders a pin for a known plan with a placeable break entry, at its exact coordinates', () => {
      useCockpitStore().breakPlanByLoadId = { l1: { entries: [breakEntry()], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(breakEls()).toHaveLength(1)
      expect(breakEls()[0].ll).toEqual([-95.0, 39.5])
    })

    it('renders nothing for a load id with no entry in the map at all — never evaluated this session', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } }) // breakPlanByLoadId left at its default {}
      expect(breakEls()).toHaveLength(0)
    })

    it('renders nothing when the plan needs no break (empty entries array)', () => {
      useCockpitStore().breakPlanByLoadId = { l1: { entries: [], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(breakEls()).toHaveLength(0)
    })

    // Global Constraint 1 / Ruling 7: a break point derived from assumed HOS
    // hours is fiction, not merely low-confidence — the driver's HOS was
    // never imported, so nothing is drawn, even though a real entry exists.
    it('renders nothing when known is false, even with a real entry present', () => {
      useCockpitStore().breakPlanByLoadId = { l1: { entries: [breakEntry()], known: false } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(breakEls()).toHaveLength(0)
    })

    it('renders nothing for an entry whose `at` is null — it cannot be placed', () => {
      useCockpitStore().breakPlanByLoadId = { l1: { entries: [breakEntry({ at: null })], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(breakEls()).toHaveLength(0)
    })

    // Distinguishability: a break pin must never be mistaken for any other
    // marker kind at a glance, colour-blind viewers included — shape (not
    // colour) is the thing every other kind on this map already encodes
    // this with (`dataset.shape`: 'round' truck, 'square' trailer, 'diamond'
    // shop). A break pin gets its own fourth value.
    it('is visually distinguishable from truck, trailer and shop pins (shape encoding)', () => {
      const lb = useLoadboardStore()
      lb.trailers = [trailer({ id: 't1', lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - H) })]
      useFleetStore().shops = [{ id: 's1', name: 'Ace Truck Repair', address: '123 Main St', lat: 39.5, lng: -95.0, phone: '555-0001' }]
      useCockpitStore().breakPlanByLoadId = { l1: { entries: [breakEntry()], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const breakShape = breakEls()[0].el.dataset.shape
      expect(breakShape).toBe('hexagon')
      expect(breakShape).not.toBe(truckFor('d1').el.dataset.shape)
      expect(breakShape).not.toBe(trailerFor('t1').el.dataset.shape)
      expect(breakShape).not.toBe(shopFor('s1').el.dataset.shape)
    })

    it('clicking a break pin opens the break popup carrying the resolved marker data', async () => {
      useCockpitStore().breakPlanByLoadId = { l1: { entries: [breakEntry({ precision: 'estimated', hasCoverage: false })], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      breakEls()[0].el.click()
      await nextTick()
      const popup = wrapper.get('[data-testid="map-popup"]')
      expect(popup.attributes('data-kind')).toBe('break')
      expect(popup.get('[data-testid="popup-break-location"]').text()).toContain('≈')
      expect(popup.get('[data-testid="popup-break-coverage"]').text()).toBe('rest options unknown')
    })

    it('moves a break pin in place on reload instead of recreating it', async () => {
      const ck = useCockpitStore()
      ck.breakPlanByLoadId = { l1: { entries: [breakEntry({ at: { lat: 39.5, lng: -95.0 } })], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const before = breakEls()[0]

      ck.breakPlanByLoadId = { l1: { entries: [breakEntry({ at: { lat: 40, lng: -96 } })], known: true } }
      await nextTick()

      expect(breakEls()).toHaveLength(1) // no rebuild
      const after = breakEls()[0]
      expect(after).toBe(before)
      expect(after.ll).toEqual([-96, 40])
    })

    it('removes a break pin once its entry drops out of breakPlanByLoadId', async () => {
      const ck = useCockpitStore()
      ck.breakPlanByLoadId = { l1: { entries: [breakEntry()], known: true } }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const marker = breakEls()[0]
      expect(marker.removed).toBe(false)

      ck.breakPlanByLoadId = {}
      await nextTick()
      expect(marker.removed).toBe(true)
    })

    // A long enough haul needs more than one mandatory break — both entries
    // for the same load must render as independent pins (keyed by loadId +
    // atMs, not loadId alone).
    it('renders one pin per break point when a single load needs more than one', () => {
      useCockpitStore().breakPlanByLoadId = {
        l1: { entries: [breakEntry({ atMs: 1000, at: { lat: 39.5, lng: -95.0 } }), breakEntry({ atMs: 5000, at: { lat: 41.0, lng: -93.0 } })], known: true },
      }
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(breakEls()).toHaveLength(2)
      expect(breakEls().map((m) => m.ll)).toEqual(expect.arrayContaining([[-95.0, 39.5], [-93.0, 41.0]]))
    })
  })

  // Clicking the ROUTE, as opposed to the truck.
  //
  // The failure this guards already shipped once on this map: a feature that
  // passes its unit tests and is inert in the hand. A drawn route is 3px wide,
  // so the click is queried against a fat transparent layer — and if that layer
  // is missing or misnamed, `queryRenderedFeatures` silently matches nothing,
  // forever, with every test still green. The fake map now THROWS on a query
  // against a layer that was never added, which turns that into a red test.
  describe('clicking a route', () => {
    const HIT = 'fleet-map-routes-hit'
    const stageHit = (loadId: string): void => {
      mocks.maps[0].hits[HIT] = [{ properties: { loadId } }]
    }
    const clickMap = async (): Promise<void> => {
      mocks.maps[0].fire('click')
      await nextTick()
    }

    it('lays a fat transparent hit target over the 3px drawn line', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      const layers = mocks.maps[0].layers as Array<{ id: string; paint: Record<string, unknown> }>
      const hit = layers.find((l) => l.id === HIT)
      expect(hit).toBeDefined()
      // Invisible: it must change nothing on screen.
      expect(hit!.paint['line-opacity']).toBe(0)
      // And much wider than the line it stands in for, or the click is a coin
      // flip and the map reads as broken. NOTE this asserts the DECLARED
      // width; the band a click actually lands in is narrower (probed at ~14px
      // for 28 declared against the running map). No unit test can measure
      // that — only clicking the real thing can.
      expect(hit!.paint['line-width'] as number).toBeGreaterThanOrEqual(16)
      // Added last, because queryRenderedFeatures returns topmost-first.
      expect(layers[layers.length - 1].id).toBe(HIT)
    })

    it('opens that run plan, replacing the trip card rather than stacking on it', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(wrapper.find('[data-testid="route-plan-card"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="trip-card"]').exists()).toBe(true)
      stageHit('l1')
      await clickMap()
      expect(wrapper.find('[data-testid="route-plan-card"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Kansas City')
      // Two cards over one map is clutter; the question just asked was the
      // route's, so the route's answer takes the slot.
      expect(wrapper.find('[data-testid="trip-card"]').exists()).toBe(false)
    })

    it('clicking empty map clears the focus and gives the trip card back', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      expect(wrapper.find('[data-testid="route-plan-card"]').exists()).toBe(true)
      // No feature under the pointer this time.
      mocks.maps[0].hits[HIT] = []
      await clickMap()
      expect(wrapper.find('[data-testid="route-plan-card"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="trip-card"]').exists()).toBe(true)
    })

    it('closing the plan restores the trip card', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      await wrapper.find('[data-testid="route-close"]').trigger('click')
      expect(wrapper.find('[data-testid="route-plan-card"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="trip-card"]').exists()).toBe(true)
    })

    it('fades the other runs and thickens the clicked one — without dropping any', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      const paint = mocks.maps[0].paint['fleet-map-routes-remaining']
      expect(paint).toBeDefined()
      // A `case` expression keyed on loadId — every route still drawn, the
      // others merely faded. Filtering the source instead would take trucks
      // off the map, which is never acceptable on a dispatch screen.
      expect(JSON.stringify(paint['line-opacity'])).toContain('l1')
      expect(JSON.stringify(paint['line-opacity'])).toContain('case')
      expect(JSON.stringify(paint['line-width'])).toContain('case')
    })

    it('restores full opacity to every route when focus is dropped', async () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      mocks.maps[0].hits[HIT] = []
      await clickMap()
      const paint = mocks.maps[0].paint['fleet-map-routes-remaining']
      // A plain number, not a case expression: nothing is singled out.
      expect(typeof paint['line-opacity']).toBe('number')
    })

    it('shows a pointer cursor over a route, so it reads as clickable at all', () => {
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      expect(mocks.maps[0].canvas.style.cursor).toBe('')
      mocks.maps[0].fire('mouseenter:' + HIT)
      expect(mocks.maps[0].canvas.style.cursor).toBe('pointer')
      mocks.maps[0].fire('mouseleave:' + HIT)
      expect(mocks.maps[0].canvas.style.cursor).toBe('')
    })

    it('measures the card from the SAME geometry the map drew', async () => {
      // The number in the panel and the line under the cursor have to describe
      // the same run. Summed here off the map source itself — an independent
      // route to the figure — rather than by re-running the component's maths.
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      const data = mocks.maps[0].sources.get('fleet-map-routes')!.data as {
        features: Array<{ properties: { loadId: string }; geometry: { coordinates: [number, number][] } }>
      }
      const drawnMi = data.features
        .filter((f) => f.properties.loadId === 'l1')
        .reduce((a, f) => a + (pathMiles(f.geometry.coordinates) ?? 0), 0)
      const text = wrapper.find('[data-testid="route-progress"]').text().replace(/,/g, '')
      const shown = Number(/of\s+(\d+)\s*mi/.exec(text)![1])
      expect(Math.abs(shown - drawnMi)).toBeLessThan(2)
    })

    it('does NOT claim a truck-legal road over a drawn arc', async () => {
      // The strongest claim the product makes. This load has no provider
      // geometry, so the map drew an estimate and the card must say so.
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      expect(wrapper.find('[data-testid="route-onroad"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="route-arc"]').exists()).toBe(true)
    })

    it('claims a truck-legal road when provider geometry WAS drawn', async () => {
      const lb = useLoadboardStore()
      lb.loads = [{ ...lb.loads[0], routeGeometry: [[-94.58, 39.1], [-92.0, 40.5], [-87.63, 41.88]] }]
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      expect(wrapper.find('[data-testid="route-onroad"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="route-arc"]').exists()).toBe(false)
    })

    it('fetches that run plan on the click, read-only', async () => {
      // Without this the card is honest and empty: break/fuel numbers only
      // reach the store on a plan verdict, so on a freshly opened board every
      // route read "break plan not loaded" — which is exactly what the live
      // check found.
      const ck = useCockpitStore()
      const spy = vi.spyOn(ck, 'loadPlanFor').mockResolvedValue()
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      expect(spy).toHaveBeenCalledWith('l1')
    })

    it('says the break plan is NOT LOADED rather than showing no breaks', async () => {
      // "None required" for a run whose plan simply has not been fetched sends
      // a driver past their eighth hour. The two must never look alike.
      wrapper = mount(FleetMap, { props: { nowMs: NOW } })
      stageHit('l1')
      await clickMap()
      expect(wrapper.find('[data-testid="route-breaks-absent"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="route-breaks-none"]').exists()).toBe(false)
    })
  })
})
