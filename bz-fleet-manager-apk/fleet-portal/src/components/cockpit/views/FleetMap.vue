<script setup lang="ts">
import mapboxgl from 'mapbox-gl'
import type { GeoJSONSource, Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ageLabel, initials } from '../../../lib/cockpit/format'
import { progressShare } from '../../../lib/cockpit/lifecycle'
import { routePath, splitAtProgress, type LngLat } from '../../../lib/cockpit/mapGeometry'
import { buildTripSummary } from '../../../lib/cockpit/tripCard'
import TripCard from '../TripCard.vue'
import RoutePlanCard from '../RoutePlanCard.vue'
import { buildRouteCard, type RouteCard } from '../../../lib/cockpit/routeCard'
import {
  breakMarkers,
  CLUSTER_ZOOM_THRESHOLD,
  carrierColor,
  clusterDriverActivity,
  driverActivity,
  extractRoutes,
  focusPointsForLoad,
  mapboxToken,
  pingsByDriver,
  positionedTrailers,
  STATUS_COLOR,
  TRAILER_COLOR,
  type BreakMarker,
  type DriverActivity,
  type RouteInfo,
  type TrailerActivity,
} from '../../../lib/cockpit/mapData'
import { useCockpitStore } from '../../../stores/cockpit'
import { useFleetStore } from '../../../stores/fleet'
import { useLoadboardStore, type BoardStop, type LoadboardLane } from '../../../stores/loadboard'
import { useTrackingStore } from '../../../stores/tracking'
import MapPopup, { type MapPopupTarget } from '../MapPopup.vue'

// The live map: same data as RadarView's schematic (lib/cockpit/mapData.ts),
// projected by Mapbox instead of a hand-rolled SVG bounding box. Markers are
// created once and moved in place on every reactive change — never torn down
// and rebuilt, which would flicker and re-request tiles on every GPS tick.
//
// T2 "Map as Navigation", Task 9: truck markers cluster at low zoom (see
// mapData.ts's `clusterDriverActivity` and this file's `makeTruckClusterMarker`).
// DESIGN DECISION: Mapbox's native clustering (`cluster: true` on a GeoJSON
// source, rendered by symbol layers) was rejected — it only works on markers
// drawn FROM a source/layer, not the individually-created HTML `Marker`
// elements every pin on this map is (initials, hollow/solid rolling-vs-parked,
// shape-encoded types, printed trailer ages — four tasks' worth of tested
// marker semantics that a GeoJSON-layer rewrite would have to throw away
// wholesale). Instead, this groups the existing HTML markers by proximity in
// JS (a plain lat/lng-radius pass, gated by zoom) and swaps in ONE summary
// bubble per group — the individual markers underneath are untouched and
// reappear exactly as before once zoomed in past the threshold or the group
// no longer holds together. Scoped to TRUCK markers only: that's the layer
// named in the brief ("a dispatch service running ~50 trucks") and the one
// that scales with fleet size; trailer/stop/shop pin code is not touched by
// this task at all, so their own tested invariants (trailer age labels
// included) carry zero risk from this change.
const props = defineProps<{ nowMs: number }>()
const lb = useLoadboardStore()
const tracking = useTrackingStore()
const cockpit = useCockpitStore()
const fleet = useFleetStore()

/** A block/warn ring colour for a truck currently projected to miss its
 *  appointment (stores/loadboard.ts's `risks` feed, already loaded by
 *  CockpitView — no new fetch needed here). */
const RISK_COLOR: Record<'warn' | 'block', string> = { warn: '#f59e0b', block: '#ef4444' }
/** T2 "Map as Navigation", Task 8: literal fill for a service-shop pin —
 *  its own hue, distinct from STATUS_COLOR/RISK_COLOR/TRAILER_COLOR/the
 *  carrier palette (mapData.ts), so it can never be mistaken for a truck's
 *  status colour, a risk ring, or a trailer pin at a glance. */
const SHOP_COLOR = '#34d399'
/** T2 "Map as Navigation", Task 9: literal fill for a truck-cluster bubble
 *  (mapData.ts's `clusterDriverActivity`) — a near-white neutral, distinct
 *  from every other palette on this map (STATUS_COLOR/RISK_COLOR/
 *  TRAILER_COLOR/SHOP_COLOR/the carrier palette all sit in saturated
 *  blue/purple/cyan/slate/yellow/green/orange territory) precisely because
 *  a cluster bubble deliberately does NOT encode any individual truck's
 *  status, risk, or carrier — see `makeTruckClusterMarker`'s own doc for
 *  why pretending otherwise would be dishonest. */
const CLUSTER_COLOR = '#f8fafc'
/** T3 Break and Rest Planning, Task 8: literal fill for a mandatory-break
 *  pin — its own hue, distinct from every other palette on this map
 *  (STATUS_COLOR/RISK_COLOR/TRAILER_COLOR/SHOP_COLOR/CLUSTER_COLOR/the
 *  carrier palette). Shape (the hexagon `clip-path` in `makeBreakMarker`)
 *  is still the PRIMARY differentiator — see that function's own doc — so a
 *  colour that happens to be close to another marker's is not a defect the
 *  way an identical shape would be. */
const BREAK_COLOR = '#fb923c'
const ROUTES_SOURCE_ID = 'fleet-map-routes'
// T2 "Map as Navigation", Task 2: a route is split at the truck's current
// progress (mapGeometry's `splitAtProgress`) into two features per route —
// `part: 'done'`/`part: 'remaining'` — and drawn by two filtered layers off
// the same source, dimmed vs. full-strength, so a dispatcher can see how far
// along a load is at a glance instead of one undifferentiated line.
const ROUTES_DONE_LAYER_ID = 'fleet-map-routes-done'
const ROUTES_REMAINING_LAYER_ID = 'fleet-map-routes-remaining'
/** The dimmed half's opacity — visibly less than the remaining half's 0.85
 *  (unchanged from before this split existed) so "already covered" reads as
 *  background, not as another active route. */
const DONE_LINE_OPACITY = 0.3
const REMAINING_LINE_OPACITY = 0.85
/** The transparent, deliberately FAT layer that catches route clicks. A drawn
 *  line is 3px wide; asking a dispatcher to hit 3px is asking them to conclude
 *  the map is broken. Mapbox hit-tests a layer at opacity 0 as long as it is
 *  visible, so this sits over the drawn routes purely as a target. */
const ROUTES_HIT_LAYER_ID = 'fleet-map-routes-hit'
/** Declared width of that target. The band a click actually lands in measures
 *  NARROWER than this in the browser — 28 declared probed at roughly 14px
 *  against the running map, against a 3px drawn line — so this is set from the measurement, not
 *  from the number that looked reasonable. Wider is not free: two lanes that
 *  overlap start stealing each other's clicks. */
const HIT_LINE_WIDTH = 28
/** Non-focused routes fade to this so the clicked run reads as the subject.
 *  Faded, never hidden: a dispatcher still needs to see that other trucks
 *  exist, and a map that empties itself on a click has lost the plot. */
const DIMMED_LINE_OPACITY = 0.12
const BASE_LINE_WIDTH = 3
const FOCUS_LINE_WIDTH = 5

const mapContainer = ref<HTMLDivElement | null>(null)

let map: MapboxMap | null = null
let loaded = false
let boundsFitted = false

const routes = computed<RouteInfo[]>(() => extractRoutes(lb.loads))
const pings = computed(() => pingsByDriver(tracking.locations))
// The one classification of rolling/parked/no_gps, shared with RadarView's
// schematic (see mapData.ts's own doc on `driverActivity`) — computed here
// once per reactive tick rather than each view re-deriving it.
const activity = computed<DriverActivity[]>(() => driverActivity(lb.lanes, routes.value, pings.value, props.nowMs))
// --- Trip card -------------------------------------------------------------
// A rider-hailing app always shows the trip you are on; you never have to hunt
// for it. Same idea: the card auto-selects the load that is actually rolling,
// so opening the map answers "what is happening" without a click. Clicking a
// truck or its route selects that trip instead.
const selectedTripLoadId = ref<string | null>(null)

const selectedTrip = computed(() => {
  const rolling = lb.loads.filter((l) => l.assignment)
  if (!rolling.length) return null
  const chosen =
    rolling.find((l) => l.id === selectedTripLoadId.value) ??
    // Prefer a truck that is actually moving over one merely assigned — that
    // is the trip a dispatcher is watching.
    rolling.find((l) => l.assignment!.status === 'in_progress') ??
    rolling[0]
  const lane = lb.lanes.find((x) => x.id === chosen.assignment!.driverId)
  const ping = pings.value.get(chosen.assignment!.driverId)
  const pingMs = ping ? new Date(ping.createdAt).getTime() : null
  return buildTripSummary(chosen, lane, pingMs, props.nowMs)
})

function selectTrip(loadId: string): void {
  selectedTripLoadId.value = loadId
}

// --- Route focus -----------------------------------------------------------
// Clicking the LINE asks a different question than clicking the truck: not
// "how is this driver right now" (TripCard) but "what is this run, end to
// end". The line is also by far the biggest target on the map, and until now
// it was the only thing on it that did nothing — worse than nothing, since the
// background handler dismissed whatever popup you had open.
const focusedRouteLoadId = ref<string | null>(null)

/** Exactly the coordinates and progress share `sync()` DREW, keyed by load.
 *  The card measures these rather than recomputing its own: one definition per
 *  concept, so the mileage in the panel and the line under the cursor can
 *  never disagree. Replaced wholesale each sync rather than mutated. */
const drawnRoutes = ref<Record<string, { path: LngLat[]; onRoad: boolean; t: number }>>({})

const focusedRouteCard = computed<RouteCard | null>(() => {
  const id = focusedRouteLoadId.value
  if (!id) return null
  const drawn = drawnRoutes.value[id]
  const route = routes.value.find((r) => r.load.id === id)
  if (!drawn || !route) return null
  return buildRouteCard({
    load: route.load,
    path: drawn.path,
    onRoad: drawn.onRoad,
    progress: drawn.t,
    // `?? null` on both: a load with no entry has had no plan FETCHED, which
    // routeCard.ts keeps distinct from an engine that ran and could not plan.
    breakPlan: cockpit.breakPlanByLoadId[id] ?? null,
    fuelPlan: cockpit.fuelPlanByLoadId[id] ?? null,
    detention: cockpit.detention.items.filter((d) => d.loadId === id),
  })
})

function focusRoute(loadId: string): void {
  focusedRouteLoadId.value = loadId
  // Selecting the trip too is what pulls this corridor's rest areas and fuel
  // stops (see the `selectedTrip` watch) — so clicking a route turns the map
  // from "every POI at once" into "show me this run".
  selectTrip(loadId)
  // And fetch the run's break/fuel plan. Without this the card is honest and
  // empty: those numbers only reach the store on a plan verdict, so on a
  // freshly opened board every route read "break plan not loaded". Read-only
  // (dryRun, no lock) — see the store action.
  void cockpit.loadPlanFor(loadId)
}

function clearRouteFocus(): void {
  focusedRouteLoadId.value = null
}

/** Fade every route except the focused one, and thicken that one. Written as
 *  Mapbox paint expressions rather than by re-filtering the source: the source
 *  is the truth about what runs exist, and focus is a view state that must
 *  never be able to drop a truck off the map. */
function applyRouteFocus(id: string | null): void {
  const m = map
  if (!m || !loaded) return
  const pairs: Array<[string, number]> = [
    [ROUTES_DONE_LAYER_ID, DONE_LINE_OPACITY],
    [ROUTES_REMAINING_LAYER_ID, REMAINING_LINE_OPACITY],
  ]
  for (const [layer, base] of pairs) {
    if (!m.getLayer(layer)) continue
    m.setPaintProperty(layer, 'line-opacity', id ? ['case', ['==', ['get', 'loadId'], id], base, DIMMED_LINE_OPACITY] : base)
    m.setPaintProperty(layer, 'line-width', id ? ['case', ['==', ['get', 'loadId'], id], FOCUS_LINE_WIDTH, BASE_LINE_WIDTH] : BASE_LINE_WIDTH)
  }
}

watch(focusedRouteLoadId, (id) => applyRouteFocus(id))

// Fetch the corridor for whichever trip is selected. The store de-dupes by
// load id, so re-selecting the same trip costs nothing.
watch(
  () => selectedTrip.value?.loadId ?? null,
  (loadId) => { if (loadId) void cockpit.loadRoutePois(loadId) },
  { immediate: true },
)
function closeTripCard(): void {
  // Re-selecting is the only way back, which is deliberate: an empty card slot
  // is quieter than a card the dispatcher already dismissed reappearing.
  selectedTripLoadId.value = '__none__'
}
function tripShowOnBoard(loadId: string): void {
  cockpit.focusOnBoard(loadId)
}
/** T2 Task 3: drivers with neither a live ping nor a last-known fix. Never
 *  placed on the map (see `sync`'s marker loop) — surfaced here instead so a
 *  dispatcher still sees them, honestly labelled as untracked rather than
 *  invisible. */
const unknownPositionDrivers = computed(() => activity.value.filter((a) => a.state === 'no_gps'))
const riskByDriverId = computed(() => lb.riskByDriverId)
/** T2 Task 7: trailers with a known, timestamped position (mapData.ts's
 *  `positionedTrailers` — a trailer with a position but no `lastSeenAt`, or
 *  no position at all, is excluded here, never rendered as a bare/undated
 *  dot). */
const trailerActivity = computed<TrailerActivity[]>(() => positionedTrailers(lb.trailers))
/** T1 Carrier Layer, Task 9: truck fill colour and popup switch to
 *  carrier-encoding only while the board is actually grouped by carrier —
 *  otherwise the marker keeps encoding leg status, exactly as before this
 *  task (see STATUS_COLOR below). */
const groupingByCarrier = computed(() => cockpit.groupBy === 'carrier')
/** T3 Break and Rest Planning, Task 8 (Ruling 7): reads the cockpit store's
 *  `breakPlanByLoadId` — never `verdict`, which PlanVerdictModal nulls the
 *  moment it closes — through mapData.ts's `breakMarkers`, which already
 *  applies every "no marker" rule (R4 / Global Constraint 1: never
 *  evaluated, HOS unknown, or unplaceable). */
const currentBreakMarkers = computed<BreakMarker[]>(() => breakMarkers(cockpit.breakPlanByLoadId))

interface TruckMarkerEntry {
  marker: MapboxMarker
  el: HTMLDivElement
  loadId: string | undefined
  driverId: string
}
/** T2 "Map as Navigation", Task 9: a summary bubble standing in for two or
 *  more truck markers grouped by mapData.ts's `clusterDriverActivity`.
 *  `positions` is every member truck's own [lng, lat] — refreshed each
 *  `sync()` pass, same as a stop marker's `stop`/`loadId` — so a click
 *  always fits to where the members actually are right now, not wherever
 *  they were when the bubble was first created. No `loadId`/popup wiring:
 *  see `makeTruckClusterMarker`'s own doc for why a click here fits bounds
 *  instead. */
interface TruckClusterMarkerEntry {
  marker: MapboxMarker
  el: HTMLDivElement
  positions: [number, number][]
}
/** T2 "Map as Navigation", Task 4: a stop pin needs to hand its exact
 *  resolved BoardStop (address, appointment window) to the popup on click —
 *  kept on the entry and refreshed every `sync()` pass, same as a truck
 *  marker's `loadId`, so a click always reads the latest data rather than
 *  whatever the pin happened to be created with. */
interface StopMarkerEntry {
  marker: MapboxMarker
  el: HTMLDivElement
  loadId: string
  stopKind: 'pickup' | 'delivery'
  stop: BoardStop
}
/** T2 Task 7: a trailer pin. No `loadId`/click wiring — a trailer isn't tied
 *  to a load or a popup target the way a truck/stop marker is; it just
 *  states where it last was and how long ago that was. */
interface TrailerMarkerEntry {
  marker: MapboxMarker
  el: HTMLDivElement
  trailerId: string
}
/** A fuel stop or rest area along the SELECTED trip's route (lib/routePois.ts).
 *  Only ever drawn for the one trip the dispatcher has selected — drawing every
 *  lane's corridor would be a provider bill and a map nobody can read.
 *
 *  Round-cornered pill with a glyph, deliberately unlike the truck (circle),
 *  trailer (square), shop (diamond) and break (hexagon) shapes already on this
 *  map: shape alone still tells the kinds apart, colour-blind included.
 *
 *  The label says FUEL or REST because that is the PROVIDER's classification.
 *  It does not say "truck stop": a `gas_station` here carries no promise of
 *  truck access, diesel lanes or overnight parking, and the provider returns
 *  nothing at all for weigh stations or truck repair.
 *  Same rule as every other marker: position first, then add. */
function makePoiMarker(m: MapboxMap, poi: { id: string; name: string; category: string; distanceAlongMi: number }, at: [number, number]): PoiMarkerEntry {
  const el = document.createElement('div')
  const rest = poi.category === 'rest_area'
  el.dataset.testid = 'poi-marker'
  el.dataset.poiId = poi.id
  el.dataset.category = poi.category
  el.dataset.shape = 'pill'
  el.style.cssText = `display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:${rest ? '#7c3aed' : '#0891b2'};color:#e8f0ff;font:700 9px/1 'JetBrains Mono',ui-monospace,monospace;border:1.5px solid #0b1220;box-shadow:0 0 0 1.5px rgba(0,0,0,.35);cursor:pointer;opacity:.92`
  el.textContent = rest ? 'R' : 'F'
  el.title = `${poi.name} · ${rest ? 'rest area' : 'fuel'} · ${Math.round(poi.distanceAlongMi)} mi in`
  const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m)
  const entry: PoiMarkerEntry = { marker, el, poiId: poi.id }
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    openPopup({ kind: 'poi', poiId: entry.poiId }, el)
  })
  return entry
}

/** T2 "Map as Navigation", Task 8: a service-shop pin (stores/fleet.ts's
 *  ServiceShop — the customer's OWN shop registry, never third-party POI;
 *  see the doc on `SHOP_COLOR` and `makeShopMarker`). No `loadId`/driver
 *  wiring, same reasoning as a trailer pin: a shop isn't tied to a load. */
interface ShopMarkerEntry {
  marker: MapboxMarker
  el: HTMLDivElement
  shopId: string
}
/** T3 Break and Rest Planning, Task 8: a mandatory-break pin. `data` is the
 *  full resolved `BreakMarker` (loadId, precision, coverage, rest options)
 *  — refreshed every `sync()` pass and handed straight to the popup on
 *  click, the same "resolved record handed through" precedent
 *  `StopMarkerEntry.stop` already sets, not a thin pointer MapPopup would
 *  have to re-look-up (a load can have more than one break point, so
 *  "loadId alone" isn't enough to find the right one back in the store). */
interface BreakMarkerEntry {
  marker: MapboxMarker
  el: HTMLDivElement
  data: BreakMarker
}
const truckMarkers = new Map<string, TruckMarkerEntry>()
const truckClusterMarkers = new Map<string, TruckClusterMarkerEntry>()
const stopMarkers = new Map<string, StopMarkerEntry>()
const trailerMarkers = new Map<string, TrailerMarkerEntry>()
const shopMarkers = new Map<string, ShopMarkerEntry>()
interface PoiMarkerEntry { marker: MapboxMarker; el: HTMLDivElement; poiId: string }
const poiMarkers = new Map<string, PoiMarkerEntry>()
// Keyed by `loadId:atMs`, not loadId alone — a long enough haul can need
// more than one mandatory break, and each needs its own marker identity.
const breakPointMarkers = new Map<string, BreakMarkerEntry>()

/** The one popup open at a time, and the marker element it's anchored to.
 *  Click handlers below only ever decide WHAT was clicked (a `MapPopupTarget`
 *  — a load id, a driver id, or a resolved stop) and hand it to MapPopup,
 *  which resolves and renders the rest itself. */
const popupTarget = ref<MapPopupTarget | null>(null)
const popupAnchor = ref<HTMLElement | null>(null)

function closePopup(): void {
  popupTarget.value = null
  popupAnchor.value = null
}
/** Clicking the marker that's already open closes it — the toggle a
 *  dispatcher expects from any map pin. Clicking a different one just swaps
 *  straight to the new target/anchor. */
function openPopup(target: MapPopupTarget, anchor: HTMLElement): void {
  if (popupAnchor.value === anchor && popupTarget.value) {
    closePopup()
    return
  }
  popupTarget.value = target
  popupAnchor.value = anchor
}

/** `filled` is the rolling/parked encoding (T2 Task 3): a rolling driver is
 *  a solid, status/carrier-coloured disc — unchanged from before this task
 *  — while a parked one is hollow (transparent fill, coloured outline), so
 *  "available but not moving" reads at a glance without needing a legend. A
 *  no_gps driver never reaches this function at all: see `sync`'s marker
 *  loop, which skips creating a marker for that state entirely. */
function truckStyle(el: HTMLDivElement, color: string, risk: 'warn' | 'block' | undefined, clickable: boolean, filled: boolean): void {
  const ring = risk ? RISK_COLOR[risk] : filled ? '#ffffff' : color
  el.dataset.risk = risk ?? ''
  // Exposed as data attributes (not just the inline style) so specs can
  // assert the exact colour/fill a marker got without depending on how
  // jsdom normalizes a `background` shorthand back out of `style.cssText`.
  el.dataset.color = color
  el.dataset.filled = filled ? 'true' : 'false'
  const background = filled ? color : 'transparent'
  const textColor = filled ? '#0b1220' : color
  const borderWidth = filled ? 2 : 3
  el.style.cssText = `display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:9999px;background:${background};color:${textColor};font:700 10px/1 'JetBrains Mono',ui-monospace,monospace;border:${borderWidth}px solid ${ring};box-shadow:0 0 0 2px rgba(0,0,0,.35)${risk ? `,0 0 8px 2px ${ring}` : ''};cursor:${clickable ? 'pointer' : 'default'}`
}

/** `at` is required, and positioned BEFORE `addTo`: a Marker added to a map
 *  with no LngLat makes mapbox-gl project `undefined` on the very next frame
 *  and throw "LngLatLike argument must be specified…". The map still draws,
 *  so the only symptom is a console full of errors and missing pins. */
function makeTruckMarker(m: MapboxMap, driverId: string, name: string, at: [number, number]): TruckMarkerEntry {
  const el = document.createElement('div')
  el.dataset.testid = 'truck-marker'
  el.dataset.driverId = driverId
  // T2 Task 7: 'round' vs. a trailer pin's 'square' (see `makeTrailerMarker`)
  // — the encoded half of "visually distinct from truck markers" a test can
  // assert on without depending on parsing raw CSS out of `style.cssText`.
  el.dataset.shape = 'round'
  el.textContent = initials(name)
  const entry: TruckMarkerEntry = { marker: new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m), el, loadId: undefined, driverId }
  // T2 Task 4: a rolling truck (loadId set) opens the truck popup; a parked
  // one (no active load) opens the driver popup — a no_gps driver never
  // reaches here at all, since it never gets a marker (see `sync` below).
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    // Clicking a truck both opens its popup AND selects it in the trip card —
    // the card is the persistent "what is this" answer, the popup the
    // transient one.
    if (entry.loadId) selectTrip(entry.loadId)
    openPopup(entry.loadId ? { kind: 'truck', loadId: entry.loadId } : { kind: 'driver', driverId: entry.driverId }, el)
  })
  return entry
}

/** T2 "Map as Navigation", Task 9: a bubble standing in for two or more
 *  truck markers that would otherwise overlap at low zoom (see mapData.ts's
 *  `clusterDriverActivity` for the grouping rule itself — this function
 *  only ever draws groups it's handed). Deliberately does NOT attempt to
 *  encode any individual truck's rolling/parked state, risk ring, or
 *  carrier colour: those are per-truck facts that stop being answerable the
 *  moment several trucks share one pin, and colouring the bubble by e.g.
 *  the "worst" truck inside it would invent a precision the data doesn't
 *  support — exactly the class of bug this codebase keeps fixing elsewhere
 *  (see driverActivity's own doc on never inventing a no_gps position). The
 *  bubble states only what's honestly known at this zoom: how many trucks
 *  are here. `dataset.shape = 'cluster'` — its own value, distinct from a
 *  truck's 'round', a trailer's 'square', and a shop's 'diamond' — keeps it
 *  from ever being mistaken for a single marker of any kind.
 *
 *  Clicking it does not open MapPopup — there is no "N trucks" popup kind,
 *  and inventing one is out of scope for this task — it instead fits the
 *  map to exactly this cluster's member coordinates, the standard "zoom in
 *  to split this apart" behaviour a dispatcher already expects from every
 *  other clustered map product. Same rule as every other marker: position
 *  first, then add. */
function makeTruckClusterMarker(m: MapboxMap, at: [number, number], count: number): TruckClusterMarkerEntry {
  const el = document.createElement('div')
  el.dataset.testid = 'truck-cluster-marker'
  el.dataset.shape = 'cluster'
  el.dataset.count = String(count)
  el.textContent = String(count)
  el.style.cssText = `display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;background:${CLUSTER_COLOR};color:#0b1220;font:700 12px/1 'JetBrains Mono',ui-monospace,monospace;border:2px solid #0b1220;box-shadow:0 0 0 2px rgba(0,0,0,.35);cursor:pointer`
  const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m)
  const entry: TruckClusterMarkerEntry = { marker, el, positions: [] }
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    if (!map || entry.positions.length === 0) return
    const bounds = new mapboxgl.LngLatBounds()
    for (const p of entry.positions) bounds.extend(p)
    map.fitBounds(bounds, { padding: 64, maxZoom: CLUSTER_ZOOM_THRESHOLD + 2, duration: 0 })
  })
  return entry
}

/** Same rule as the truck marker: position first, then add. */
function makeStopMarker(m: MapboxMap, stopKind: 'pickup' | 'delivery', color: string, at: [number, number], loadId: string, stop: BoardStop): StopMarkerEntry {
  const el = document.createElement('div')
  el.dataset.testid = 'stop-marker'
  el.dataset.kind = stopKind
  el.style.cssText =
    stopKind === 'pickup'
      ? `width:10px;height:10px;border-radius:9999px;border:2px solid ${color};background:transparent;cursor:pointer`
      : `width:10px;height:10px;border-radius:9999px;background:${color};border:1px solid rgba(255,255,255,.8);cursor:pointer`
  const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m)
  const entry: StopMarkerEntry = { marker, el, loadId, stopKind, stop }
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    openPopup({ kind: 'stop', loadId: entry.loadId, stopKind: entry.stopKind, stop: entry.stop }, el)
  })
  return entry
}

/** T2 Task 7: a trailer pin. Square (`border-radius: 4px`), not the round
 *  9999px a truck marker uses — `dataset.shape` names the same distinction
 *  for tests — and its own literal fill (TRAILER_COLOR), never STATUS_COLOR
 *  or a carrier colour: a trailer's marker doesn't encode a leg's status or
 *  who's hauling it, only "this is a trailer" and its age. `ageText` is
 *  ALWAYS a real age, never '—': callers only ever reach this function for a
 *  trailer `positionedTrailers` already confirmed has a `lastSeenAt` (see
 *  mapData.ts's own doc on that invariant) — the age is not just in the
 *  hover tooltip but printed directly on the pin itself, because a bare dot
 *  with the age hidden behind a hover is exactly the "absent shown as
 *  measured" failure this task exists to avoid.
 *  T2 Task 8: clickable, same as every other marker on this map — opens
 *  MapPopup's trailer variant. Not built alongside the pin in Task 7
 *  because at that point MapPopup had no trailer case to open; see
 *  MapPopup.vue's own doc on `TrailerPopupTarget`.
 *  Same rule as the other markers: position first, then add. */
function makeTrailerMarker(m: MapboxMap, trailerId: string, unit: string, ageText: string, at: [number, number]): TrailerMarkerEntry {
  const el = document.createElement('div')
  el.dataset.testid = 'trailer-marker'
  el.dataset.trailerId = trailerId
  el.dataset.shape = 'square'
  el.style.cssText = `display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:${TRAILER_COLOR};color:#0b1220;font:700 9px/1 'JetBrains Mono',ui-monospace,monospace;border:2px solid #0b1220;box-shadow:0 0 0 2px rgba(0,0,0,.35);cursor:pointer`
  el.textContent = ageText
  el.title = `${unit} · last seen ${ageText}`
  const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m)
  const entry: TrailerMarkerEntry = { marker, el, trailerId }
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    openPopup({ kind: 'trailer', trailerId: entry.trailerId }, el)
  })
  return entry
}

/** T2 "Map as Navigation", Task 8: a service-shop pin (spec R4 — the
 *  customer's OWN shop registry, stores/fleet.ts's ServiceShop, is free to
 *  show unconditionally: it's a small, org-curated list, not a third-party
 *  "show every truck stop" layer that would compete with a POI-scale
 *  product on their own turf. The NEED-driven half of this task — surfacing
 *  the nearest one only for a unit that's actually due — lives in
 *  MapPopup.vue's `nearestShopResult`, computed when a truck/driver/trailer
 *  popup opens, not encoded on the pin itself).
 *  Diamond (`transform: rotate(45deg)`), not the round truck / square
 *  trailer shapes — `dataset.shape = 'diamond'` names the distinction for
 *  tests, same convention as `makeTrailerMarker`'s 'square'. Its own literal
 *  fill (SHOP_COLOR), unrelated to STATUS_COLOR/RISK_COLOR/TRAILER_COLOR.
 *  Same rule as every other marker: position first, then add. */
function makeShopMarker(m: MapboxMap, shopId: string, name: string, at: [number, number]): ShopMarkerEntry {
  const el = document.createElement('div')
  el.dataset.testid = 'shop-marker'
  el.dataset.shopId = shopId
  el.dataset.shape = 'diamond'
  el.style.cssText = `width:14px;height:14px;background:${SHOP_COLOR};border:2px solid #0b1220;box-shadow:0 0 0 2px rgba(0,0,0,.35);transform:rotate(45deg);cursor:pointer`
  el.title = name
  const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m)
  const entry: ShopMarkerEntry = { marker, el, shopId }
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    openPopup({ kind: 'shop', shopId: entry.shopId }, el)
  })
  return entry
}

/** T3 Break and Rest Planning, Task 8: a mandatory-break pin — drawn ONLY
 *  for a plan that needs one (R4; see mapData.ts's `breakMarkers`, which
 *  already filtered out everything this function is never called for).
 *  Hexagon (`clip-path` polygon), not the round truck / square trailer /
 *  diamond shop / round-but-smaller stop shapes already in use on this map
 *  — `dataset.shape = 'hexagon'` names it for tests, same convention every
 *  other marker here already follows, so shape alone still distinguishes
 *  every kind at a glance for a colour-blind viewer, independent of
 *  BREAK_COLOR.
 *  Same rule as every other marker: position first, then add. */
function makeBreakMarker(m: MapboxMap, bp: BreakMarker, at: [number, number]): BreakMarkerEntry {
  const el = document.createElement('div')
  el.dataset.testid = 'break-marker'
  el.dataset.loadId = bp.loadId
  el.dataset.shape = 'hexagon'
  el.style.cssText = `width:16px;height:16px;background:${BREAK_COLOR};border:2px solid #0b1220;box-shadow:0 0 0 2px rgba(0,0,0,.35);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);cursor:pointer`
  el.title = 'Mandatory break'
  const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(m)
  const entry: BreakMarkerEntry = { marker, el, data: bp }
  el.addEventListener('click', (ev) => {
    // Stop here. Mapbox marker elements live INSIDE the map container, so a
    // marker click bubbles to the map's own 'click' handler — which calls
    // closePopup(). Without this the popup opened and closed in the same
    // tick and every marker on this map looked inert: click a truck, nothing
    // happens. That is exactly the "no information on click" the map was
    // reported for.
    ev.stopPropagation()
    openPopup({ kind: 'break', marker: entry.data }, el)
  })
  return entry
}

/** Applies every reactive change to the already-created map: route line
 *  data, stop pins, and truck marker positions/styling — in place, keyed by
 *  driver/load id, never by rebuilding the source list from scratch. */
function sync(): void {
  const m = map
  if (!m || !loaded) return
  const currentRoutes = routes.value
  const currentActivity = activity.value
  const risk = riskByDriverId.value
  const currentTrailers = trailerActivity.value

  interface RouteFeature {
    type: 'Feature'
    properties: { status: string; loadId: string; part: 'done' | 'remaining' }
    geometry: { type: 'LineString'; coordinates: LngLat[] }
  }
  const source = m.getSource<GeoJSONSource>(ROUTES_SOURCE_ID)
  const routeFeatures: RouteFeature[] = []
  const drawn: Record<string, { path: LngLat[]; onRoad: boolean; t: number }> = {}
  for (const r of currentRoutes) {
    // Every geocoded stop, bowed leg-to-leg (mapGeometry's `routePath`) — not
    // a straight first-to-last chord. Real road geometry needs a configured
    // router and a schema change (see mapGeometry.ts); this arc is the
    // honest approximation until then, labelled as such in the popup rather
    // than implied to be a driven route.
    // Real road geometry when the provider gave us one, else a curved arc.
    // The arc is an ESTIMATE of the path — it is not the road, and a driver
    // told to follow it would be misled — so the two are never blended: a
    // load either draws its real route or draws an arc, and the legend says
    // which. `routeGeometry` and the plan's mileage come from the same
    // provider answer (lib/routing.ts), so the line and the cost agree.
    const real = r.load.routeGeometry
    const path = real && real.length > 1
      ? real
      : routePath(r.stops.map((s): [number, number] => [s.lng!, s.lat!]))
    // The same elapsed-share `t` RadarView's schematic already uses to place
    // its rolling marker (lifecycle's `progressShare`) — 0 for anything that
    // hasn't started (assigned/tendered), 1 for completed/delivered, the
    // real elapsed fraction for in_progress. An assigned-but-not-started leg
    // is exactly 0: `splitAtProgress` then returns an empty `done`, so no
    // sliver of "already driven" is drawn for a load that hasn't moved.
    const t = progressShare(r.status, Date.parse(r.load.assignment!.plannedStart), Date.parse(r.load.assignment!.plannedEnd), props.nowMs)
    const { done, remaining } = splitAtProgress(path, t)
    drawn[r.load.id] = { path, onRoad: !!(real && real.length > 1), t }
    // A 0- or 1-point LineString isn't a line Mapbox can draw; omit that
    // half's feature entirely rather than hand it an empty/degenerate one.
    if (done.length >= 2) {
      routeFeatures.push({ type: 'Feature', properties: { status: r.status, loadId: r.load.id, part: 'done' }, geometry: { type: 'LineString', coordinates: done } })
    }
    if (remaining.length >= 2) {
      routeFeatures.push({ type: 'Feature', properties: { status: r.status, loadId: r.load.id, part: 'remaining' }, geometry: { type: 'LineString', coordinates: remaining } })
    }
  }
  source?.setData({ type: 'FeatureCollection', features: routeFeatures })
  drawnRoutes.value = drawn

  const liveStopIds = new Set<string>()
  for (const r of currentRoutes) {
    const color = STATUS_COLOR[r.status] ?? STATUS_COLOR.assigned
    const pairs: Array<['a' | 'b', 'pickup' | 'delivery', BoardStop]> = [
      ['a', 'pickup', r.a],
      ['b', 'delivery', r.b],
    ]
    for (const [suffix, stopKind, stop] of pairs) {
      const id = `${r.load.id}:${suffix}`
      liveStopIds.add(id)
      const at: [number, number] = [stop.lng!, stop.lat!]
      let entry = stopMarkers.get(id)
      if (!entry) {
        entry = makeStopMarker(m, stopKind, color, at, r.load.id, stop)
        stopMarkers.set(id, entry)
      } else {
        entry.marker.setLngLat(at)
        // Refresh the content a click would hand to the popup — the address/
        // window can change on reload even though this pin's identity (same
        // load, same end of the route) hasn't.
        entry.loadId = r.load.id
        entry.stopKind = stopKind
        entry.stop = stop
      }
    }
  }
  for (const [id, entry] of stopMarkers) {
    if (!liveStopIds.has(id)) {
      entry.marker.remove()
      stopMarkers.delete(id)
      if (popupAnchor.value === entry.el) closePopup()
    }
  }

  const activityByDriver = new Map(currentActivity.map((a) => [a.driverId, a]))

  // T2 "Map as Navigation", Task 9: gather every driver that would have
  // gotten an individual marker before this task (known position, not
  // no_gps — the exact filter that loop always applied) alongside its lane,
  // then hand just the activity half to `clusterDriverActivity`. Below
  // CLUSTER_ZOOM_THRESHOLD, drivers that are close together come back
  // grouped into `clusters` instead of `singles`; at/above it every driver
  // comes back in `singles` and `clusters` is empty — see that function's
  // own doc for why that makes this task a no-op at any zoom a dispatcher
  // already relies on today.
  const positionedLanes: Array<{ lane: LoadboardLane; activity: DriverActivity }> = []
  for (const lane of lb.lanes) {
    const a = activityByDriver.get(lane.id)
    // T2 Task 3's product invariant: a driver with neither a live ping nor a
    // last-known fix (`state === 'no_gps'`, `position === undefined`) gets
    // NO marker — never a fallback/default coordinate. They're surfaced
    // instead in `unknownPositionDrivers`, rendered in the template below.
    // This filter runs BEFORE clustering, so a no_gps driver can never be
    // folded into a cluster's count either.
    if (!a || a.state === 'no_gps' || !a.position) continue
    positionedLanes.push({ lane, activity: a })
  }
  const laneByDriverId = new Map(positionedLanes.map((p) => [p.lane.id, p.lane]))
  const { singles, clusters } = clusterDriverActivity(
    positionedLanes.map((p) => p.activity),
    m.getZoom(),
  )

  const liveDriverIds = new Set<string>()
  for (const a of singles) {
    const lane = laneByDriverId.get(a.driverId)!
    liveDriverIds.add(lane.id)
    const loadId = a.loadId
    // Carrier-grouped: colour (and the tooltip below) encode which carrier
    // this driver belongs to instead of the leg's status — see
    // `groupingByCarrier` above. `carrierColor` hashes the id itself, so the
    // same carrier keeps the same colour across a refetch no matter how
    // useCarriersStore's `list` gets reordered.
    const color = groupingByCarrier.value
      ? carrierColor(lane.carrierId)
      : (STATUS_COLOR[a.state === 'rolling' ? 'in_progress' : 'assigned'] ?? STATUS_COLOR.assigned)
    const driverRisk = risk[lane.id]
    const at: [number, number] = [a.position!.lng, a.position!.lat]
    let entry = truckMarkers.get(lane.id)
    if (!entry) {
      entry = makeTruckMarker(m, lane.id, lane.name, at)
      truckMarkers.set(lane.id, entry)
    } else {
      entry.marker.setLngLat(at)
    }
    entry.loadId = loadId
    const riskDetail = driverRisk ? (lb.risks.find((rr) => rr.driverId === lane.id)?.detail ?? 'Behind schedule') : ''
    const carrierLine = groupingByCarrier.value ? (lane.carrierName ?? 'No carrier') : ''
    entry.el.title = [riskDetail, carrierLine].filter(Boolean).join(' · ')
    // Rolling = solid (filled); parked = hollow outline — the at-a-glance
    // "is this truck actually moving" cue T2 Task 3 exists to add. Untouched
    // by clustering: a truck that stays a `single` at this zoom gets exactly
    // this styling, exactly as it did before this task existed.
    truckStyle(entry.el, color, driverRisk, !!loadId, a.state === 'rolling')
  }
  for (const [id, entry] of truckMarkers) {
    // Removed both when a driver drops out entirely (left the loadboard,
    // went no_gps) AND when it's still live but now folded into a cluster
    // bubble instead — either way, this specific marker doesn't belong on
    // the map right now.
    if (!liveDriverIds.has(id)) {
      entry.marker.remove()
      truckMarkers.delete(id)
      if (popupAnchor.value === entry.el) closePopup()
    }
  }

  const liveClusterIds = new Set<string>()
  for (const c of clusters) {
    liveClusterIds.add(c.id)
    const at: [number, number] = [c.position.lng, c.position.lat]
    let entry = truckClusterMarkers.get(c.id)
    if (!entry) {
      entry = makeTruckClusterMarker(m, at, c.drivers.length)
      truckClusterMarkers.set(c.id, entry)
    } else {
      entry.marker.setLngLat(at)
      entry.el.textContent = String(c.drivers.length)
      entry.el.dataset.count = String(c.drivers.length)
    }
    entry.positions = c.drivers.map((d): [number, number] => [d.position!.lng, d.position!.lat])
  }
  for (const [id, entry] of truckClusterMarkers) {
    if (!liveClusterIds.has(id)) {
      entry.marker.remove()
      truckClusterMarkers.delete(id)
    }
  }

  // T2 Task 7: trailer pins. `currentTrailers` already excludes anything
  // without BOTH a position AND a `lastSeenAt` (mapData.ts's
  // `positionedTrailers`) — every entry reaching this loop gets a marker,
  // no further filtering needed here. `ageLabel` is recomputed every sync
  // (not just at creation) so an already-placed pin's printed age keeps
  // advancing on CockpitView's clock tick, same as everything else keyed
  // off `props.nowMs`.
  //
  // T2 Task 8 (follow-up): `positionedTrailers` ALSO excludes any trailer
  // that's currently hooked to a driver — its stored position is its last
  // drop-off point, not where it is now (see that function's own doc). A
  // trailer can therefore go from having a marker to not having one purely
  // because it just got hooked, same as a driver going no_gps can lose
  // theirs — the cleanup loop below closes an open popup for exactly that
  // reason, mirroring the truck/stop cleanup just above.
  const liveTrailerIds = new Set<string>()
  for (const t of currentTrailers) {
    liveTrailerIds.add(t.trailerId)
    const at: [number, number] = [t.position.lng, t.position.lat]
    const ageText = ageLabel(t.lastSeenAt, props.nowMs)
    let entry = trailerMarkers.get(t.trailerId)
    if (!entry) {
      entry = makeTrailerMarker(m, t.trailerId, t.unit, ageText, at)
      trailerMarkers.set(t.trailerId, entry)
    } else {
      entry.marker.setLngLat(at)
      entry.el.textContent = ageText
      entry.el.title = `${t.unit} · last seen ${ageText}`
    }
  }
  for (const [id, entry] of trailerMarkers) {
    if (!liveTrailerIds.has(id)) {
      entry.marker.remove()
      trailerMarkers.delete(id)
      if (popupAnchor.value === entry.el) closePopup()
    }
  }

  // T2 "Map as Navigation", Task 8: service-shop pins. Shown unconditionally
  // for every geocoded shop in the org's OWN registry (spec R4 — free to
  // show; see `makeShopMarker`'s own doc for why this differs from a
  // "show all truck stops" layer) — a shop with no lat/lng (not every
  // registered shop has been geocoded) is skipped rather than placed at a
  // guessed coordinate, the same rule every other pin on this map follows.
  const liveShopIds = new Set<string>()
  for (const shop of fleet.shops) {
    if (shop.lat == null || shop.lng == null) continue
    liveShopIds.add(shop.id)
    const at: [number, number] = [shop.lng, shop.lat]
    let entry = shopMarkers.get(shop.id)
    if (!entry) {
      entry = makeShopMarker(m, shop.id, shop.name, at)
      shopMarkers.set(shop.id, entry)
    } else {
      entry.marker.setLngLat(at)
      entry.el.title = shop.name
    }
  }
  for (const [id, entry] of shopMarkers) {
    if (!liveShopIds.has(id)) {
      entry.marker.remove()
      shopMarkers.delete(id)
      if (popupAnchor.value === entry.el) closePopup()
    }
  }

  // Route POIs for the SELECTED trip only. `cockpit.routePois` is loaded by a
  // watcher on the selection; an empty list with a `reason` means the corridor
  // could not be measured, which the trip card states rather than the map
  // silently drawing nothing.
  const livePoiIds = new Set<string>()
  for (const poi of cockpit.routePois.items) {
    livePoiIds.add(poi.id)
    const at: [number, number] = [poi.lng, poi.lat]
    let entry = poiMarkers.get(poi.id)
    if (!entry) {
      entry = makePoiMarker(m, poi, at)
      poiMarkers.set(poi.id, entry)
    } else {
      entry.marker.setLngLat(at)
    }
  }
  for (const [id, entry] of poiMarkers) {
    if (!livePoiIds.has(id)) {
      entry.marker.remove()
      poiMarkers.delete(id)
      if (popupAnchor.value === entry.el) closePopup()
    }
  }

  // T3 Break and Rest Planning, Task 8 (Ruling 7): mandatory-break pins.
  // `currentBreakMarkers` (mapData.ts's `breakMarkers`, reading the cockpit
  // store's `breakPlanByLoadId`) has already applied every "no marker" rule
  // — a load never evaluated this session, `known: false`, or an entry the
  // engine could not place all simply produce no entry here, no further
  // filtering needed in this loop.
  const liveBreakIds = new Set<string>()
  for (const bp of currentBreakMarkers.value) {
    const id = `${bp.loadId}:${bp.atMs}`
    liveBreakIds.add(id)
    const at: [number, number] = [bp.at.lng, bp.at.lat]
    let entry = breakPointMarkers.get(id)
    if (!entry) {
      entry = makeBreakMarker(m, bp, at)
      breakPointMarkers.set(id, entry)
    } else {
      entry.marker.setLngLat(at)
      entry.data = bp
    }
  }
  for (const [id, entry] of breakPointMarkers) {
    if (!liveBreakIds.has(id)) {
      entry.marker.remove()
      breakPointMarkers.delete(id)
      if (popupAnchor.value === entry.el) closePopup()
    }
  }

  // T2 "Map as Navigation", Task 5: a pending "Show on map" request (the
  // cockpit store's `mapFocusLoadId`) pre-empts the ordinary aggregate fit
  // below — a dispatcher who explicitly jumped here for ONE load must land
  // centred on that load, not on the bounding box of every route/driver
  // currently in view. `focusOnRequestedLoad` also sets `boundsFitted` when
  // it acts, so `fitBoundsOnce` never runs a second, competing fit right
  // after — exactly one of the two ever calls `m.fitBounds`.
  if (!focusOnRequestedLoad()) fitBoundsOnce(currentRoutes, currentActivity)
}

/** Consumes `cockpit.mapFocusLoadId` if one is pending (always clearing it,
 *  so it is a genuinely one-shot request no matter what it resolves to) and,
 *  when there's something honest to centre on, fits the map to exactly that
 *  load's own points (`mapData.ts`'s `focusPointsForLoad` — every geocoded
 *  stop, or the assigned driver's position when the load has none) and marks
 *  `boundsFitted` so the ordinary once-only aggregate fit never fires
 *  afterward.
 *
 *  Returns true only when it actually performed that fit. It returns false
 *  — telling `sync()` to fall back to the ordinary `fitBoundsOnce` — for all
 *  three "nothing to centre on" cases: no request pending, a stale/unknown
 *  load id, or a load with no geocoded stops AND no known driver position
 *  (MasterDrawer's "Show on map" is disabled for exactly that last case; see
 *  mapData.ts's own doc on `focusPointsForLoad`). Falling back to the
 *  ordinary aggregate view rather than doing nothing — and never jumping to
 *  a default/invented coordinate — is the same invariant Task 3 enforces for
 *  a no_gps driver marker. */
function focusOnRequestedLoad(): boolean {
  const m = map
  const loadId = cockpit.mapFocusLoadId
  if (!m || !loadId) return false
  const load = lb.loads.find((l) => l.id === loadId)
  cockpit.clearMapFocus()
  if (!load) return false
  const points = focusPointsForLoad(load, lb.lanes, pings.value)
  if (!points.length) return false
  const bounds = new mapboxgl.LngLatBounds()
  for (const p of points) bounds.extend([p.lng, p.lat])
  boundsFitted = true
  m.fitBounds(bounds, { padding: 96, maxZoom: 13, duration: 0 })
  return true
}

function fitBoundsOnce(currentRoutes: RouteInfo[], currentActivity: DriverActivity[]): void {
  const m = map
  if (boundsFitted || !m) return
  const bounds = new mapboxgl.LngLatBounds()
  let any = false
  for (const r of currentRoutes) {
    bounds.extend([r.a.lng!, r.a.lat!])
    bounds.extend([r.b.lng!, r.b.lat!])
    any = true
  }
  for (const a of currentActivity) {
    if (!a.position) continue
    bounds.extend([a.position.lng, a.position.lat])
    any = true
  }
  if (!any) return
  boundsFitted = true
  m.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 })
}

function onLoad(): void {
  loaded = true
  const m = map
  if (!m) return
  // T2 Task 4 (follow-up): clicking the map background dismisses whatever
  // popup is open — the behaviour every map product has and its absence
  // reads as broken. mapbox-gl's own `click` event is the right hook for
  // this specifically because it's canvas-only: a Marker's DOM element sits
  // outside the canvas and never bubbles into it, so this never fires for a
  // click on a truck/stop pin (which already has its own open/toggle/switch
  // handling — see makeTruckMarker/makeStopMarker) or for a click on
  // FleetMap's own chrome (header, legend, position-unknown list), which
  // isn't part of the map at all. BrickPopover.vue, the board's equivalent
  // popover, has no comparable click-based dismissal to mirror — it opens
  // and closes on hover, not on click — so this is the natural analogue for
  // a click-opened popup rather than a second competing pattern.
  m.on('click', (e) => {
    // A route hit takes priority over dismissal. Queried against the fat
    // transparent hit layer, not the 3px drawn line — see ROUTES_HIT_LAYER_ID.
    // Mapbox returns hits topmost-first, so where lanes overlap (Omaha-KC has
    // several stacked) the one drawn on top is the one you get, which is the
    // one the cursor appears to be over.
    const hits = m.queryRenderedFeatures(e.point, { layers: [ROUTES_HIT_LAYER_ID] })
    const loadId = hits.length ? ((hits[0] as { properties?: Record<string, unknown> | null }).properties?.loadId as string | undefined) : undefined
    if (loadId) {
      closePopup()
      focusRoute(loadId)
      return
    }
    closePopup()
    clearRouteFocus()
  })
  // T2 "Map as Navigation", Task 9: re-run `sync()` once a zoom gesture
  // settles, so clustering picks up. Zoom is Mapbox's own state, not a Vue
  // reactive — the `watch` below only fires on OUR reactive data changing —
  // so without this listener, zooming past CLUSTER_ZOOM_THRESHOLD with
  // nothing else about the board changing would leave a cluster bubble
  // sitting there stale instead of splitting back into individual markers.
  // 'zoomend' (fires once per gesture) rather than 'zoom' (fires on every
  // intermediate frame of one): the same "re-sync when it's actually needed,
  // not on every possible frame" restraint the click listener above already
  // applies.
  m.on('zoomend', () => sync())
  m.addSource(ROUTES_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  // Two layers off the one source, each filtered to its own half of the
  // split (see `sync`'s `part: 'done' | 'remaining'` on every feature) —
  // "done" dimmed, "remaining" at the same full strength the single route
  // layer always drew at. The colour expression is written out at each call
  // site rather than hoisted to a shared variable: mapbox-gl's paint types
  // only accept it as a tuple-shaped `ExpressionSpecification` via the
  // contextual typing an inline literal gets here, not the wider array type
  // a `const` would infer.
  m.addLayer({
    id: ROUTES_DONE_LAYER_ID,
    type: 'line',
    source: ROUTES_SOURCE_ID,
    filter: ['==', ['get', 'part'], 'done'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-width': 3,
      'line-opacity': DONE_LINE_OPACITY,
      'line-color': ['match', ['get', 'status'], ...Object.entries(STATUS_COLOR).flatMap(([k, v]) => [k, v]), STATUS_COLOR.assigned],
    },
  })
  m.addLayer({
    id: ROUTES_REMAINING_LAYER_ID,
    type: 'line',
    source: ROUTES_SOURCE_ID,
    filter: ['==', ['get', 'part'], 'remaining'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-width': 3,
      'line-opacity': REMAINING_LINE_OPACITY,
      'line-color': ['match', ['get', 'status'], ...Object.entries(STATUS_COLOR).flatMap(([k, v]) => [k, v]), STATUS_COLOR.assigned],
    },
  })
  // The click target. Added AFTER the drawn layers so it is topmost for
  // `queryRenderedFeatures`, and fully transparent so it changes nothing on
  // screen. Without it the feature works in tests and feels broken in the
  // hand: a 3px line is a target you miss four times out of five.
  m.addLayer({
    id: ROUTES_HIT_LAYER_ID,
    type: 'line',
    source: ROUTES_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-width': HIT_LINE_WIDTH, 'line-opacity': 0, 'line-color': '#000000' },
  })
  // A cursor that changes is how a user learns something is clickable at all.
  m.on('mouseenter', ROUTES_HIT_LAYER_ID, () => { m.getCanvas().style.cursor = 'pointer' })
  m.on('mouseleave', ROUTES_HIT_LAYER_ID, () => { m.getCanvas().style.cursor = '' })
  sync()
}

onMounted(() => {
  const token = mapboxToken()
  if (!mapContainer.value || !token) return
  // T2 "Map as Navigation", Task 8: the org's shop registry doesn't reach
  // any cockpit surface today — stores/fleet.ts's `loadShops()` was only
  // ever called from FleetView (the /fleet route). Triggered here, from the
  // one component that actually renders shop pins, rather than from
  // CockpitView's onMounted: FleetMap is itself lazy-loaded only once a
  // Mapbox token is configured and the radar view is opened (see
  // RadarView.vue's `defineAsyncComponent`), so fetching from here avoids
  // paying for shop data on every cockpit session that never opens the map.
  // Fire-and-forget, same as `fleet.loadDigest()` elsewhere — `loadShops()`
  // already catches its own errors (see stores/fleet.ts) and must never
  // block the map from rendering.
  void fleet.loadShops()
  map = new mapboxgl.Map({
    container: mapContainer.value,
    style: 'mapbox://styles/mapbox/dark-v11',
    accessToken: token,
    center: [-96, 38],
    zoom: 3,
  })
  map.on('load', onLoad)
})

onBeforeUnmount(() => {
  for (const entry of truckMarkers.values()) entry.marker.remove()
  truckMarkers.clear()
  for (const entry of truckClusterMarkers.values()) entry.marker.remove()
  truckClusterMarkers.clear()
  for (const entry of stopMarkers.values()) entry.marker.remove()
  stopMarkers.clear()
  for (const entry of trailerMarkers.values()) entry.marker.remove()
  trailerMarkers.clear()
  for (const entry of shopMarkers.values()) entry.marker.remove()
  shopMarkers.clear()
  for (const entry of poiMarkers.values()) entry.marker.remove()
  poiMarkers.clear()
  for (const entry of breakPointMarkers.values()) entry.marker.remove()
  breakPointMarkers.clear()
  map?.remove()
  map = null
})

// nowMs is in the dependency list too: a rolling leg with no fresh ping is
// positioned by elapsed-time interpolation (mapData's `rollingPosition`),
// which must keep creeping forward on CockpitView's clock tick even when
// nothing else about the board has changed — same as the schematic, whose
// template reads `nowMs` directly on every render.
// T2 Task 5: `mapFocusLoadId` is included so a focus request that arrives
// while FleetMap is ALREADY mounted (not just at the fresh mount a "Show on
// map" click normally causes, since switching `view` unmounts/remounts this
// component via CockpitView's v-if/v-else-if) still triggers a re-sync and
// gets acted on by `focusOnRequestedLoad` above.
// T2 Task 8: `fleet.shops` is included so the async `loadShops()` fetch
// above (which resolves well after this component's first `sync()` call)
// still triggers a re-sync once shop pins actually arrive.
// T3 Break and Rest Planning, Task 8: `currentBreakMarkers` is included so a
// break plan that arrives from a gesture's verdict (populating the cockpit
// store's `breakPlanByLoadId` well after this component's first `sync()`
// call) triggers a re-sync and actually gets drawn.
watch([routes, activity, riskByDriverId, groupingByCarrier, trailerActivity, currentBreakMarkers, () => fleet.shops, () => props.nowMs, () => cockpit.mapFocusLoadId, () => cockpit.routePois.items], () => sync())
</script>

<template>
  <div class="rounded-xl border border-line bg-surface p-3 shadow-2xl">
    <div class="flex items-center justify-between border-b border-line pb-2 text-xs">
      <div class="font-bold text-ink">
        🗺️ GPS Telemetry Map
        <span class="font-mono text-[10px] font-normal text-ink-3">{{ routes.length }} legs in view · live tiles</span>
      </div>
      <div class="flex gap-3 font-mono text-[10px] text-ink-3">
        <span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-assigned" />Assigned</span>
        <span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-tendered" />Tendered</span>
        <span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-progress" />Rolling</span>
        <span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-completed" />Delivered</span>
        <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded-full border-2 border-ink-3" />Parked</span>
        <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded-full border-2 border-conflict" />Behind schedule</span>
      </div>
    </div>
    <div class="relative mt-2">
      <div ref="mapContainer" data-testid="fleet-map-canvas" class="h-[520px] w-full rounded-lg bg-surface-3" />
      <!-- Overlaid, not beside: the trip you are watching stays on the map the
           way a rider-hailing app keeps the trip sheet over the route. -->
      <div class="pointer-events-none absolute left-3 top-3 z-10">
        <!-- Clicking a route swaps the trip sheet for the run's plan: two
             cards stacked over the same map is clutter, and the question a
             dispatcher just asked by clicking is the route's. Closing it
             returns to the trip card. -->
        <RoutePlanCard
          v-if="focusedRouteCard"
          :card="focusedRouteCard"
          @close="clearRouteFocus"
          @show-on-board="tripShowOnBoard"
        />
        <TripCard v-else :trip="selectedTrip" :now-ms="props.nowMs" :tz="cockpit.tz" @show-on-board="tripShowOnBoard" @close="closeTripCard" />
      </div>
    </div>
    <!-- T2 Task 3: a driver with no live ping AND no last-known fix is never
         drawn at a guessed/default coordinate (see `sync`'s marker loop and
         mapData.ts's `driverActivity` doc) — they're listed here instead,
         honestly labelled as untracked rather than silently dropped. -->
    <div v-if="unknownPositionDrivers.length" data-testid="position-unknown-list" class="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
      <span class="font-bold uppercase tracking-wide text-[10px] text-ink-3">Position unknown</span>
      <span class="ml-2 font-mono text-ink-2">
        <span v-for="(d, i) in unknownPositionDrivers" :key="d.driverId" data-testid="position-unknown-item" :data-driver-id="d.driverId">{{ d.name }}<span v-if="i < unknownPositionDrivers.length - 1">, </span></span>
      </span>
    </div>
    <!-- T2 Task 4: clicking a truck, a parked driver, or a stop pin opens
         this instead of jumping straight to the board — "what is this and
         what do I do about it" gets an answer before a dispatcher commits to
         navigating away. "Show on board" inside it is the old jump. -->
    <MapPopup :target="popupTarget" :anchor="popupAnchor" :now-ms="nowMs" @close="closePopup" />
  </div>
</template>
