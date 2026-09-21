import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BreakMarker } from '../../lib/cockpit/mapData'
import { useCockpitStore } from '../../stores/cockpit'
import { useFleetStore, type ServiceShop } from '../../stores/fleet'
import { useLoadboardStore, type BoardLoad, type BoardTractor, type BoardTrailer } from '../../stores/loadboard'
import MapPopup, { type MapPopupTarget } from './MapPopup.vue'

// T2 "Map as Navigation", Task 4. MapPopup resolves everything itself off the
// loadboard store from a thin target (which load / which driver / which
// stop) — these tests populate that store directly, the same way
// FleetMap.spec.ts does, rather than mounting the whole map.

const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

function mountPopup(target: MapPopupTarget | null, nowMs = NOW) {
  const anchorEl = document.createElement('div')
  return mount(MapPopup, { props: { target, anchor: target ? anchorEl : null, nowMs } })
}

const baseLoad: BoardLoad = {
  id: 'l1',
  reference: 'L-1',
  status: 'in_progress',
  requiredEquip: 'DryVan',
  hazmatClass: null,
  revenueCents: 250_000,
  stopCount: 2,
  origin: 'Kansas City, MO',
  destination: 'Chicago, IL',
  stops: [
    { sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: 39.1, lng: -94.58, dwellMin: 60, windowStart: null, windowEnd: null },
    { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: 41.88, lng: -87.63, dwellMin: 30, windowStart: iso(NOW + H), windowEnd: iso(NOW + H + 30 * 60_000) },
  ],
  assignment: {
    id: 'a1',
    driverId: 'd1',
    status: 'in_progress',
    plannedStart: iso(NOW - 2 * H),
    plannedEnd: iso(NOW + 2 * H),
    marginCents: 1,
    economics: { estCostCents: 150_000, marginCents: 45_000 },
  },
}
const D = 86_400_000
const baseTrailer: BoardTrailer = {
  id: 'r1', unit: 'FB-3310', type: 'Flatbed', length: "48'", status: 'active', features: null,
  inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: null,
  lastLat: 39.5, lastLng: -95.0, lastSeenAt: iso(NOW - 3 * D),
}

describe('MapPopup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders nothing when there is no target', () => {
    const w = mountPopup(null)
    expect(w.find('[data-testid="map-popup"]').exists()).toBe(false)
  })

  describe('rolling truck', () => {
    beforeEach(() => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active', carrierId: 'c-acme', carrierName: 'Acme Trucking' }]
      lb.loads = [baseLoad]
    })

    it('renders load ref, origin -> destination, next stop + ETA, driver, carrier and margin', () => {
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.get('[data-testid="popup-title"]').text()).toBe('L-1')
      expect(w.get('[data-testid="popup-route"]').text()).toBe('Kansas City, MO ➔ Chicago, IL')
      expect(w.get('[data-testid="popup-next-stop"]').text()).toContain('ETA')
      expect(w.get('[data-testid="popup-next-stop"]').text()).toContain('Chicago, IL')
      expect(w.get('[data-testid="popup-driver"]').text()).toBe('Jake Morrow')
      expect(w.get('[data-testid="popup-carrier"]').text()).toBe('Acme Trucking')
      expect(w.get('[data-testid="popup-margin"]').text()).toBe('$450')
    })

    it('shows the live risk feed\'s own late detail when this load is flagged behind schedule', () => {
      const lb = useLoadboardStore()
      lb.risks = [
        { assignmentId: 'a1', loadId: 'l1', ref: 'L-1', driverId: 'd1', driverName: 'Jake Morrow', kind: 'behind_schedule', severity: 'block', detail: 'Projected 40m late', deadline: iso(NOW + H), projectedArrival: iso(NOW + H + 40 * 60_000), slackMin: -40 },
      ]
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.get('[data-testid="popup-late"]').text()).toContain('Projected 40m late')
    })

    it('omits the late line entirely when the load is not flagged at risk', () => {
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.find('[data-testid="popup-late"]').exists()).toBe(false)
    })

    it('shows the route-approximation note — the arc is an estimate, not a driven route', () => {
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.get('[data-testid="popup-route-note"]').text()).toMatch(/estimate|not a driven road route/i)
    })

    // --- Absent cases: must read as unknown, never as a guessed/zero value ---

    it('ABSENT: a load with no full stop detail loaded renders next-stop ETA as "—", not a guessed time', () => {
      const lb = useLoadboardStore()
      const { stops: _stops, ...withoutStops } = baseLoad
      lb.loads = [withoutStops as BoardLoad]
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.get('[data-testid="popup-next-stop"]').text()).toBe('—')
    })

    it('ABSENT: a never-priced load renders margin as "— not priced", never $0.00', () => {
      const lb = useLoadboardStore()
      lb.loads = [{ ...baseLoad, assignment: { ...baseLoad.assignment!, economics: null } }]
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      const text = w.get('[data-testid="popup-margin"]').text()
      expect(text).toContain('not priced')
      expect(text).not.toContain('$0.00')
      expect(text).not.toContain('$0')
    })

    it('ABSENT: a driver with no carrier reads "No carrier", not blank', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active', carrierId: null, carrierName: null }]
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.get('[data-testid="popup-carrier"]').text()).toBe('No carrier')
    })
  })

  describe('parked driver', () => {
    beforeEach(() => {
      const lb = useLoadboardStore()
      lb.lanes = [
        {
          id: 'd7', name: 'Chuck Baker', status: 'active', hosKnown: true, driveRemainingMin: 495, cycleRemainingMin: 2760,
          lastCity: 'Milwaukee, WI', currentTractorId: 't1', currentTrailerId: 'r1',
        },
      ]
      lb.tractors = [{ id: 't1', unit: '4471', make: 'Freightliner', cab: 'Sleeper', status: 'active', inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd7' }]
      lb.trailers = [{ id: 'r1', unit: 'DV-2201', type: 'DryVan', length: "53'", status: 'active', features: null, inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd7' }]
      lb.loads = [
        { ...baseLoad, id: 'l0', reference: 'L-0', assignment: { ...baseLoad.assignment!, id: 'a0', driverId: 'd7', status: 'completed', plannedStart: iso(NOW - 5 * H), plannedEnd: iso(NOW - 3 * H), completedAt: iso(NOW - 3 * H) } },
      ]
    })

    it('renders idle since, hours available (drive/cycle remaining), current city and paired equipment', () => {
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-title"]').text()).toBe('Chuck Baker')
      expect(w.get('[data-testid="popup-idle-since"]').text()).toBe('3h ago')
      expect(w.get('[data-testid="popup-hos-drive"]').text()).toBe('8h 15m')
      expect(w.get('[data-testid="popup-hos-cycle"]').text()).toBe('46h 00m')
      expect(w.get('[data-testid="popup-city"]').text()).toBe('Milwaukee, WI')
      expect(w.get('[data-testid="popup-equipment"]').text()).toContain('4471')
      expect(w.get('[data-testid="popup-equipment"]').text()).toContain('DV-2201')
    })

    // --- Absent cases ---

    it('ABSENT: HOS never imported reads "not imported" for both clocks, never 0h', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd7', name: 'Chuck Baker', status: 'active', hosKnown: false, driveRemainingMin: null, cycleRemainingMin: null }]
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-hos-drive"]').text()).toBe('not imported')
      expect(w.get('[data-testid="popup-hos-cycle"]').text()).toBe('not imported')
    })

    it('ABSENT: a driver with no completed leg in the loaded window has no honest "idle since" and reads "—"', () => {
      const lb = useLoadboardStore()
      lb.loads = []
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-idle-since"]').text()).toBe('—')
    })

    it('ABSENT: no paired equipment reads as bobtail / none, not blank', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd7', name: 'Chuck Baker', status: 'active' }]
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-equipment"]').text()).toContain('bobtail')
      expect(w.get('[data-testid="popup-equipment"]').text()).toContain('none')
    })

    it('ABSENT: unknown position reads "position unknown"', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd7', name: 'Chuck Baker', status: 'active', lastCity: null }]
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-city"]').text()).toBe('position unknown')
    })

    it('does not show the route-approximation note for a parked driver (no route to mislabel)', () => {
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.find('[data-testid="popup-route-note"]').exists()).toBe(false)
    })
  })

  describe('stop pin', () => {
    beforeEach(() => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
      lb.loads = [baseLoad]
    })

    it('renders pickup/delivery, address and the appointment window', () => {
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'delivery', stop: baseLoad.stops![1] }
      const w = mountPopup(target)
      expect(w.get('[data-testid="popup-title"]').text()).toBe('Delivery')
      expect(w.get('[data-testid="popup-stop-type"]').text()).toBe('Delivery')
      expect(w.get('[data-testid="popup-address"]').text()).toBe('Chicago, IL')
      expect(w.get('[data-testid="popup-window"]').text()).not.toBe('—')
      expect(w.get('[data-testid="popup-window"]').text()).not.toContain('no appointment window')
    })

    it('shows whether the stop is at risk, using the same live risk feed as the board', () => {
      const lb = useLoadboardStore()
      lb.risks = [
        { assignmentId: 'a1', loadId: 'l1', ref: 'L-1', driverId: 'd1', driverName: 'Jake Morrow', kind: 'behind_schedule', severity: 'warn', detail: 'Tight on its delivery window', deadline: iso(NOW + H), projectedArrival: iso(NOW + H + 10 * 60_000), slackMin: -10 },
      ]
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'delivery', stop: baseLoad.stops![1] }
      const w = mountPopup(target)
      expect(w.get('[data-testid="popup-risk"]').text()).toContain('Tight on its delivery window')
    })

    it('reads "No risk flagged" when nothing is at risk — a real state, not an unknown one', () => {
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'pickup', stop: baseLoad.stops![0] }
      const w = mountPopup(target)
      expect(w.get('[data-testid="popup-risk"]').text()).toBe('No risk flagged')
    })

    // --- Absent case ---

    it('ABSENT: a stop with no appointment window reads "— no appointment window", never a fabricated time', () => {
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'pickup', stop: baseLoad.stops![0] }
      const w = mountPopup(target)
      expect(w.get('[data-testid="popup-window"]').text()).toBe('— no appointment window')
    })

    it('shows the route-approximation note on a stop pin too', () => {
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'pickup', stop: baseLoad.stops![0] }
      const w = mountPopup(target)
      expect(w.find('[data-testid="popup-route-note"]').exists()).toBe(true)
    })
  })

  // T2 "Map as Navigation", Task 8: the trailer popup Task 4 deliberately
  // didn't build (nothing had ever written a trailer position back then —
  // see MapPopup.vue's own doc on TrailerPopupTarget). Task 6 added the
  // write, Task 7 added the clickable pin; this is the popup's own content.
  describe('trailer', () => {
    beforeEach(() => {
      const lb = useLoadboardStore()
      lb.trailers = [baseTrailer]
    })

    it('renders unit + type/length as the title, and the dwell time as a headline (not a bare timestamp)', () => {
      const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
      expect(w.get('[data-testid="popup-title"]').text()).toBe("FB-3310 · Flatbed 48'")
      const age = w.get('[data-testid="popup-trailer-age"]').text()
      // The headline fact: "how long", not the raw ISO stamp — a bare
      // timestamp forces every dispatcher to do the subtraction themselves,
      // exactly the "footnote, not headline" failure the brief calls out.
      expect(age).toBe('3d')
      expect(age).not.toContain('T') // not an ISO 8601 string
      expect(age).not.toBe(baseTrailer.lastSeenAt)
    })

    it('shows the position as coordinates when no nearer-city data exists — honest, not blank', () => {
      const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
      expect(w.get('[data-testid="popup-trailer-position"]').text()).toBe('39.5000, -95.0000')
    })

    // T2 Task 8 (follow-up): a trailer pin — and therefore this popup — can
    // now only ever mean "dropped" (mapData.ts's `positionedTrailers`
    // excludes any trailer with a `currentDriverId` entirely; see that
    // function's doc for why a hooked trailer's stored position is stale,
    // not current). A "Hooked/Dropped" status row was removed rather than
    // left showing a value that can only ever be one fixed thing — dead
    // code implying a state the map can no longer produce. This asserts the
    // removal, and stays true even if a hooked record somehow reaches the
    // popup directly (bypassing FleetMap's click gating, as this test
    // does): there is no branch left that renders differently for it.
    it('shows no hooked/dropped status line — a trailer pin already means dropped', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
      lb.trailers = [{ ...baseTrailer, currentDriverId: 'd1' }] // hooked, hypothetically
      const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
      expect(w.find('[data-testid="popup-trailer-status"]').exists()).toBe(false)
    })

    it('does not show the route-approximation note for a trailer (no route to mislabel)', () => {
      const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
      expect(w.find('[data-testid="popup-route-note"]').exists()).toBe(false)
    })

    // --- Absent case ---

    it('ABSENT: a trailer record that has since vanished from the store falls back to its raw id as the title, never blank', () => {
      const lb = useLoadboardStore()
      lb.trailers = []
      const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
      expect(w.get('[data-testid="popup-title"]').text()).toBe('r1')
    })
  })

  // T2 "Map as Navigation", Task 8: the org's own service-shop registry
  // (stores/fleet.ts's ServiceShop) — free to show because it's the
  // customer's own small, curated list, not third-party POI. This popup is
  // the pin's own content; FleetMap.spec.ts covers only the wiring (which
  // target a click on a shop pin produces), the same split every other kind
  // already uses.
  describe('shop', () => {
    const baseShop: ServiceShop = { id: 's1', name: 'Ace Truck Repair', address: '123 Main St', lat: 39.1, lng: -94.6, phone: '(555) 123-4567' }

    beforeEach(() => {
      useFleetStore().shops = [baseShop]
    })

    it('renders the shop name as the title, and the name and phone in the body', () => {
      const w = mountPopup({ kind: 'shop', shopId: 's1' })
      expect(w.get('[data-testid="popup-title"]').text()).toBe('Ace Truck Repair')
      expect(w.get('[data-testid="popup-shop-name"]').text()).toBe('Ace Truck Repair')
      expect(w.get('[data-testid="popup-shop-phone"]').text()).toBe('(555) 123-4567')
    })

    it('omits the "Show on board" button — a shop has no load or lane to jump to', () => {
      const w = mountPopup({ kind: 'shop', shopId: 's1' })
      expect(w.find('[data-testid="popup-show-on-board"]').exists()).toBe(false)
    })

    it('does not show the route-approximation note for a shop (no route to mislabel)', () => {
      const w = mountPopup({ kind: 'shop', shopId: 's1' })
      expect(w.find('[data-testid="popup-route-note"]').exists()).toBe(false)
    })

    // --- Absent cases ---

    it('ABSENT: a shop with no phone on file reads "—", never blank', () => {
      useFleetStore().shops = [{ ...baseShop, phone: null }]
      const w = mountPopup({ kind: 'shop', shopId: 's1' })
      expect(w.get('[data-testid="popup-shop-phone"]').text()).toBe('—')
    })

    it('ABSENT: a shop record that has since vanished from the store falls back to its raw id as the title, never blank', () => {
      useFleetStore().shops = []
      const w = mountPopup({ kind: 'shop', shopId: 's1' })
      expect(w.get('[data-testid="popup-title"]').text()).toBe('s1')
    })
  })

  // T3 Break and Rest Planning, Task 8: the mandatory-break pin's own popup
  // content — `marker` (Task 7's `breakPlan`, routed to the map per Ruling
  // 7) is handed through whole by FleetMap, the same "resolved record, not
  // a thin pointer" precedent the stop popup's `stop` field set (a load can
  // carry more than one break point). FleetMap.spec.ts covers only the
  // wiring (which target a click on a break pin produces); this covers
  // every field the brief calls out — the absent-vs-measured distinction
  // above all, since it's the entire point of this feature.
  describe('break', () => {
    const breakMarker = (over: Partial<BreakMarker> = {}): BreakMarker => ({
      loadId: 'l1', atMs: 1000, at: { lat: 39.0997, lng: -94.5786 }, precision: 'routed', hasCoverage: true, options: [], ...over,
    })

    it('titles the popup "Mandatory break" and shows its coordinates as the location', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker() })
      expect(w.get('[data-testid="popup-title"]').text()).toBe('Mandatory break')
      expect(w.get('[data-testid="popup-break-location"]').text()).toBe('39.0997, -94.5786')
    })

    it('prefixes an estimated break point\'s location with ≈ — a guess must never read like a surveyed one', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker({ precision: 'estimated' }) })
      expect(w.get('[data-testid="popup-break-location"]').text()).toBe('≈39.0997, -94.5786')
    })

    it('does not prefix a routed break point\'s location', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker({ precision: 'routed' }) })
      expect(w.get('[data-testid="popup-break-location"]').text()).not.toContain('≈')
    })

    // DISCRIMINATION CHECK: the absent-vs-measured distinction this whole
    // feature exists to get right, on the exact surface a dispatcher reads
    // it. `hasCoverage: false` means the org told us NOTHING about this
    // corridor — it must never collapse into "no rest options", which
    // claims a survey that never happened (Global Constraint 1). This
    // codebase has made exactly that mistake five times already.
    it('hasCoverage:false reads "rest options unknown", never "no rest options"', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker({ hasCoverage: false, options: [] }) })
      const text = w.get('[data-testid="popup-break-coverage"]').text()
      expect(text).toBe('rest options unknown')
      expect(text).not.toContain('no rest options')
    })

    it('hasCoverage:true with zero options in range reads "no rest option within 35 mi" — a real, checked claim', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker({ hasCoverage: true, options: [] }) })
      expect(w.get('[data-testid="popup-break-coverage"]').text()).toBe('no rest option within 35 mi')
    })

    it('lists every reachable option with its detour distance, and renders unknown capacity as "—", never "0"', () => {
      const w = mountPopup({
        kind: 'break',
        marker: breakMarker({
          hasCoverage: true,
          options: [
            { id: 'r1', name: 'Flying J - Odessa', kind: 'truck_stop', lat: 39.1, lng: -94.6, spaces: 12, detourMi: 2.4, offRouteMi: 1.1 },
            { id: 'r2', name: 'Rest Area 42', kind: 'rest_area', lat: 39.2, lng: -94.7, spaces: null, detourMi: 5.0, offRouteMi: 3.0 },
          ],
        }),
      })
      const rows = w.findAll('[data-testid="popup-break-option"]')
      expect(rows).toHaveLength(2)
      expect(rows[0].text()).toContain('Flying J - Odessa')
      expect(rows[0].text()).toContain('2 mi detour')
      expect(rows[0].text()).toContain('spaces 12')
      expect(rows[1].text()).toContain('Rest Area 42')
      expect(rows[1].text()).toContain('spaces —')
      expect(rows[1].text()).not.toContain('spaces 0')
    })

    it('omits the options list entirely when there are none to show', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker({ hasCoverage: true, options: [] }) })
      expect(w.find('[data-testid="popup-break-option"]').exists()).toBe(false)
    })

    it('does not show the route-approximation note for a break point (no drawn route to mislabel)', () => {
      const w = mountPopup({ kind: 'break', marker: breakMarker() })
      expect(w.find('[data-testid="popup-route-note"]').exists()).toBe(false)
    })

    // A break point is not a "unit" (tractor/trailer) — the need-driven
    // nearest-shop row must never attach to it, same exclusion a stop pin
    // already gets.
    it('never surfaces the "nearest shop due" row — a break point is not a unit', () => {
      useFleetStore().shops = [{ id: 's1', name: 'Ace Truck Repair', address: '123 Main St', lat: 39.1, lng: -94.6, phone: '555-0001' }]
      const w = mountPopup({ kind: 'break', marker: breakMarker() })
      expect(w.find('[data-testid="popup-nearest-shop"]').exists()).toBe(false)
    })
  })

  // T2 "Map as Navigation", Task 8 (spec R4 — need-driven surfacing, never a
  // "show all shops" toggle): a truck/driver/trailer popup surfaces the
  // nearest shop ONLY when that popup's own unit has an overdue or near-due
  // clock. Reuses lib/cockpit/serviceNeed.ts (needsService/nearestShop) —
  // these tests are the integration proof that MapPopup wires it correctly,
  // not a re-test of that module's own logic (see serviceNeed.spec.ts for
  // the exhaustive due/untracked cases).
  describe('service due -> nearest shop (need-driven surfacing)', () => {
    const nearShop: ServiceShop = { id: 'near', name: 'Ace Truck Repair', address: '', lat: 39.2, lng: -94.6, phone: '555-0001' }
    const farShop: ServiceShop = { id: 'far', name: 'Far Away Diesel', address: '', lat: 41.88, lng: -87.63, phone: '555-0002' }
    const baseTractor: BoardTractor = {
      id: 't1', unit: '4471', make: 'Freightliner', cab: 'Sleeper', status: 'active',
      inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd7',
    }

    beforeEach(() => {
      useFleetStore().shops = [farShop, nearShop]
      const lb = useLoadboardStore()
      lb.lanes = [
        { id: 'd7', name: 'Chuck Baker', status: 'active', lastLat: 39.0997, lastLng: -94.5786, currentTractorId: 't1', currentTrailerId: 'r1' },
      ]
      lb.trailers = [baseTrailer]
    })

    it('an overdue tractor clock surfaces the nearest shop by name and distance on the driver popup', () => {
      const lb = useLoadboardStore()
      lb.tractors = [{ ...baseTractor, nextServiceAt: iso(NOW - H) }] // already expired
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      const row = w.get('[data-testid="popup-nearest-shop"]')
      expect(row.text()).toContain('Ace Truck Repair')
      expect(row.text()).toMatch(/\d+ mi/)
    })

    it('a near-due (soon) tractor clock also surfaces the nearest shop, not just an already-expired one', () => {
      const lb = useLoadboardStore()
      lb.tractors = [{ ...baseTractor, inspectionExpiresAt: iso(NOW + 10 * D) }] // inside the 30-day soon window
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-nearest-shop"]').text()).toContain('Ace Truck Repair')
    })

    it('surfaces the same nearest-shop row on the truck (rolling) popup for the same driver', () => {
      const lb = useLoadboardStore()
      // Same lane/position as the outer beforeEach, just re-keyed to 'd1' so
      // it's the ROLLING driver on baseLoad's assignment instead of parked.
      lb.lanes = [{ ...lb.lanes[0], id: 'd1' }]
      lb.tractors = [{ ...baseTractor, currentDriverId: 'd1', nextServiceAt: iso(NOW - H) }]
      lb.loads = [{ ...baseLoad, assignment: { ...baseLoad.assignment!, driverId: 'd1' } }]
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      expect(w.get('[data-testid="popup-nearest-shop"]').text()).toContain('Ace Truck Repair')
    })

    it('an overdue TRAILER clock (tractor fine) also surfaces the nearest shop — either unit counts', () => {
      const lb = useLoadboardStore()
      lb.tractors = [baseTractor] // fine
      lb.trailers = [{ ...baseTrailer, id: 'r1', currentDriverId: 'd7', registrationExpiresAt: iso(NOW - D) }]
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.get('[data-testid="popup-nearest-shop"]').text()).toContain('Ace Truck Repair')
    })

    it('a dropped trailer\'s own overdue clock surfaces the nearest shop on ITS OWN trailer popup, from its own position', () => {
      const lb = useLoadboardStore()
      lb.trailers = [{ ...baseTrailer, id: 'r1', currentDriverId: null, lastLat: 39.0997, lastLng: -94.5786, nextServiceAt: iso(NOW - D) }]
      const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
      expect(w.get('[data-testid="popup-nearest-shop"]').text()).toContain('Ace Truck Repair')
    })

    it('omits the row entirely when every clock is comfortably in the future', () => {
      const lb = useLoadboardStore()
      lb.tractors = [{ ...baseTractor, nextServiceAt: iso(NOW + 90 * D) }]
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.find('[data-testid="popup-nearest-shop"]').exists()).toBe(false)
    })

    it('never surfaces the row on a stop pin, even though the stop\'s load has the same overdue-clock driver', () => {
      const lb = useLoadboardStore()
      lb.tractors = [{ ...baseTractor, currentDriverId: 'd1', nextServiceAt: iso(NOW - H) }]
      lb.lanes = [{ ...lb.lanes[0], id: 'd1' }]
      lb.loads = [{ ...baseLoad, assignment: { ...baseLoad.assignment!, driverId: 'd1' } }]
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'pickup', stop: baseLoad.stops![0] }
      const w = mountPopup(target)
      expect(w.find('[data-testid="popup-nearest-shop"]').exists()).toBe(false)
    })

    // The exact bug compliance.ts's `untracked` level exists to prevent: an
    // unset clock must never be treated as due. This is the discriminating
    // check — see serviceNeed.spec.ts's own DISCRIMINATION CHECK for the
    // pure-function version; this is the same invariant proven through
    // MapPopup's actual wiring.
    it('DISCRIMINATION CHECK: a unit with no service clock set at all (untracked) surfaces nothing, not a false "overdue"', () => {
      const lb = useLoadboardStore()
      lb.tractors = [baseTractor] // all three clocks null — never tracked
      lb.trailers = [{ ...baseTrailer, id: 'r1', currentDriverId: 'd7' }] // also all null
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.find('[data-testid="popup-nearest-shop"]').exists()).toBe(false)
    })

    it('surfaces nothing when the unit needs service but the org has no geocoded shop', () => {
      useFleetStore().shops = [{ ...nearShop, lat: null, lng: null }]
      const lb = useLoadboardStore()
      lb.tractors = [{ ...baseTractor, nextServiceAt: iso(NOW - H) }]
      const w = mountPopup({ kind: 'driver', driverId: 'd7' })
      expect(w.find('[data-testid="popup-nearest-shop"]').exists()).toBe(false)
    })
  })

  describe('"Show on board"', () => {
    beforeEach(() => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }, { id: 'd7', name: 'Chuck Baker', status: 'active' }]
      lb.loads = [baseLoad]
    })

    it('from a truck popup, switches the cockpit to the board view and selects that exact load', async () => {
      const ck = useCockpitStore()
      ck.setView('radar')
      const w = mountPopup({ kind: 'truck', loadId: 'l1' })
      await w.get('[data-testid="popup-show-on-board"]').trigger('click')
      expect(ck.view).toBe('board')
      expect(ck.selectedLoadId).toBe('l1')
    })

    it('from a stop popup, jumps to that stop\'s load', async () => {
      const ck = useCockpitStore()
      const target: MapPopupTarget = { kind: 'stop', loadId: 'l1', stopKind: 'pickup', stop: baseLoad.stops![0] }
      const w = mountPopup(target)
      await w.get('[data-testid="popup-show-on-board"]').trigger('click')
      expect(ck.selectedLoadId).toBe('l1')
    })

    it('from a break popup, jumps to that break point\'s own load', async () => {
      const ck = useCockpitStore()
      const target: MapPopupTarget = { kind: 'break', marker: { loadId: 'l1', atMs: 1000, at: { lat: 39.1, lng: -94.6 }, precision: 'routed', hasCoverage: true, options: [] } }
      const w = mountPopup(target)
      await w.get('[data-testid="popup-show-on-board"]').trigger('click')
      expect(ck.selectedLoadId).toBe('l1')
    })

    // A parked driver has no active load — that's what "parked" means (see
    // mapData.ts's driverActivity). Jumping to "the nearest load in time"
    // (an earlier version of this) sends a dispatcher to a brick that has
    // nothing to do with the driver they clicked, which is worse than no
    // button at all. "Show on board" for a parked driver instead scrolls to
    // that driver's own lane row (GanttBoard.vue's `data-lane`) and selects
    // nothing.
    describe('from a parked driver popup', () => {
      function stubLaneScroll(laneId: string) {
        const laneRow = document.createElement('div')
        laneRow.setAttribute('data-lane', laneId)
        document.body.appendChild(laneRow)
        const scrollIntoView = vi.fn()
        laneRow.scrollIntoView = scrollIntoView
        const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
          cb(0)
          return 0
        })
        return {
          scrollIntoView,
          cleanup: () => {
            rafSpy.mockRestore()
            document.body.removeChild(laneRow)
          },
        }
      }

      it('switches to the board view and scrolls to that driver\'s own lane row', async () => {
        const ck = useCockpitStore()
        ck.setView('radar')
        const { scrollIntoView, cleanup } = stubLaneScroll('d7')
        const w = mountPopup({ kind: 'driver', driverId: 'd7' })
        await w.get('[data-testid="popup-show-on-board"]').trigger('click')
        expect(ck.view).toBe('board')
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'center' })
        cleanup()
      })

      it('selects nothing — never a nearby/upcoming load, even when this driver has one on the board', async () => {
        const lb = useLoadboardStore()
        lb.loads = [{ ...baseLoad, id: 'l9', reference: 'L-9', assignment: { ...baseLoad.assignment!, id: 'a9', driverId: 'd7', status: 'assigned', plannedStart: iso(NOW + H), plannedEnd: iso(NOW + 3 * H) } }]
        const ck = useCockpitStore()
        ck.select('some-other-load') // prove it's cleared, not left pointing at whatever was selected before
        const { cleanup } = stubLaneScroll('d7')
        const w = mountPopup({ kind: 'driver', driverId: 'd7' })
        await w.get('[data-testid="popup-show-on-board"]').trigger('click')
        expect(ck.selectedLoadId).toBeNull()
        cleanup()
      })

      it('is offered even when this driver has nothing on the board at all — it navigates to the lane, not a load', () => {
        const lb = useLoadboardStore()
        lb.loads = []
        const w = mountPopup({ kind: 'driver', driverId: 'd7' })
        expect(w.find('[data-testid="popup-show-on-board"]').exists()).toBe(true)
      })
    })

    // T2 Task 8: a dropped trailer has no lane and no load — the same
    // reasoning that keeps a parked driver's button off a nearby load
    // (above). A hooked trailer's driver DOES have a real lane, though, so
    // the button reappears for exactly that one case, jumping to the
    // driver's lane row the same way a parked driver's own popup does.
    // T2 Task 8 (follow-up): a trailer never has a lane or a load of its
    // own — there is no honest destination, unconditionally, unlike a
    // parked DRIVER (who always has their own lane row). The earlier
    // version of this jumped a HOOKED trailer to its driver's lane, the
    // same way a parked driver's popup does; that branch was removed once
    // hooked trailers stopped getting pins at all (see mapData.ts's
    // `positionedTrailers` and MapPopup.vue's `trailerRecord` doc) — a
    // trailer popup reachable from the map is always dropped now, and even
    // a hypothetically-hooked record (bypassing FleetMap's click gating, as
    // the second test below does) gets no button.
    describe('from a trailer popup', () => {
      it('omits the button entirely for a dropped trailer — no honest destination', () => {
        const lb = useLoadboardStore()
        lb.trailers = [{ ...baseTrailer, currentDriverId: null }]
        const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
        expect(w.find('[data-testid="popup-show-on-board"]').exists()).toBe(false)
      })

      it('omits the button even for a hooked trailer record — no jump exists any more for that state', () => {
        const lb = useLoadboardStore()
        lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
        lb.trailers = [{ ...baseTrailer, currentDriverId: 'd1' }]
        const w = mountPopup({ kind: 'trailer', trailerId: 'r1' })
        expect(w.find('[data-testid="popup-show-on-board"]').exists()).toBe(false)
      })
    })
  })

  it('the close button emits close', async () => {
    const lb = useLoadboardStore()
    lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
    lb.loads = [baseLoad]
    const w = mountPopup({ kind: 'truck', loadId: 'l1' })
    await w.get('[data-testid="popup-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
