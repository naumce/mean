import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLoadboardStore, type BoardLoad } from '../../../stores/loadboard'
import { useTrackingStore } from '../../../stores/tracking'
import RadarView from './RadarView.vue'

vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))
const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const stops = (a: [number, number], b: [number, number]): BoardLoad['stops'] => [
  { sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: a[0], lng: a[1], dwellMin: 60, windowStart: null, windowEnd: null },
  { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: b[0], lng: b[1], dwellMin: 60, windowStart: null, windowEnd: null },
]

// Mirrors RadarView's own bounding-box/projection constants and formulas, so
// geometry assertions below are derived, not hand-typed magic numbers.
const MW = 1000, MH = 520, PAD = 0.6
function projector(points: Array<[number, number]>) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
  const x0 = Math.min(...xs) - PAD, x1 = Math.max(...xs) + PAD
  const y0 = Math.min(...ys) - PAD, y1 = Math.max(...ys) + PAD
  return {
    px: (lng: number) => ((lng - x0) / (x1 - x0)) * MW,
    py: (lat: number) => ((y1 - lat) / (y1 - y0)) * MH,
  }
}
function curvePoint(x1: number, y1: number, x2: number, y2: number, t: number) {
  const mx = (x1 + x2) / 2 + (y2 - y1) * 0.12, my = (y1 + y2) / 2 - (x2 - x1) * 0.12
  return {
    qx: (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * mx + t * t * x2,
    qy: (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * my + t * t * y2,
  }
}

describe('RadarView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const lb = useLoadboardStore()
    lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active', lastLat: 38.95, lastLng: -92.33, lastCity: 'Columbia, MO', lastLocationAt: iso(NOW - 4 * 60_000), hosKnown: true, driveRemainingMin: 495 }, { id: 'd7', name: 'Chuck Baker', status: 'active', lastLat: 43.04, lastLng: -87.91, lastCity: 'Milwaukee, WI' }]
    lb.loads = [
      { id: 'l1', reference: 'L-1', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'Kansas City', destination: 'Chicago', stops: stops([39.1, -94.58], [41.88, -87.63]),
        assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - 2 * H), plannedEnd: iso(NOW + 2 * H), marginCents: 1 } },
      { id: 'l2', reference: 'L-2', status: 'open', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B', stops: stops([33.75, -84.39], [35.23, -80.84]), assignment: null },
    ]
    useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Jake Morrow', latitude: 38.95, longitude: -92.33, speed: 58, createdAt: iso(NOW - 4 * 60_000) }]
  })

  it('draws assigned routes, a rolling pin at the elapsed share, idle driver pins, and the telemetry table', async () => {
    const w = mount(RadarView, { props: { nowMs: NOW } })
    expect(w.findAll('[data-route]')).toHaveLength(1) // open loads are not routes
    expect(w.find('[data-pin="l1"]').exists()).toBe(true)
    expect(w.find('[data-driver="d7"]').exists()).toBe(true) // idle unit pin
    expect(w.find('[data-driver="d1"]').exists()).toBe(false) // rolling driver is drawn as the load pin
    expect(w.text()).toContain('Columbia, MO')
    expect(w.text()).toContain('58 MPH')
    await w.find('[data-pin="l1"]').trigger('click')
    expect(w.emitted('open')![0]).toEqual(['l1'])
  })

  it('never invents a position: no route/pin for ungeocoded loads, no pin for a driver with no last known fix, and an empty board is safe', () => {
    const lb = useLoadboardStore()
    lb.lanes = [{ id: 'd-nogps', name: 'No GPS Driver', status: 'active', lastLat: null, lastLng: null }]
    lb.loads = [
      { id: 'l-nogeo', reference: 'L-NOGEO', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B',
        stops: [
          { sequence: 1, type: 'pickup', address: 'Nowhere, KS', lat: null, lng: null, dwellMin: 60, windowStart: null, windowEnd: null },
          { sequence: 2, type: 'delivery', address: 'Nowhere Else, KS', lat: null, lng: null, dwellMin: 60, windowStart: null, windowEnd: null },
        ],
        assignment: { id: 'a-nogeo', driverId: 'd-nogeo', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 } },
      { id: 'l-onegeo', reference: 'L-ONEGEO', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B',
        stops: [
          { sequence: 1, type: 'pickup', address: 'Somewhere, KS', lat: 39, lng: -95, dwellMin: 60, windowStart: null, windowEnd: null },
          { sequence: 2, type: 'delivery', address: 'Nowhere Else, KS', lat: null, lng: null, dwellMin: 60, windowStart: null, windowEnd: null },
        ],
        assignment: { id: 'a-onegeo', driverId: 'd-onegeo', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 } },
    ]
    useTrackingStore().locations = []
    const w = mount(RadarView, { props: { nowMs: NOW } })
    expect(w.findAll('[data-route]')).toHaveLength(0)
    expect(w.find('[data-pin="l-nogeo"]').exists()).toBe(false) // no geocoded stops at all
    expect(w.find('[data-pin="l-onegeo"]').exists()).toBe(false) // only one geocoded stop -> a === b guard
    expect(w.find('[data-driver="d-nogps"]').exists()).toBe(false) // no lastLat/lastLng -> no invented pin
  })

  it('renders an empty board without throwing and draws nothing', () => {
    const lb = useLoadboardStore()
    lb.lanes = []
    lb.loads = []
    useTrackingStore().locations = []
    expect(() => mount(RadarView, { props: { nowMs: NOW } })).not.toThrow()
    const w = mount(RadarView, { props: { nowMs: NOW } })
    expect(w.findAll('[data-route]')).toHaveLength(0)
    expect(w.findAll('[data-pin]')).toHaveLength(0)
    expect(w.findAll('[data-driver]')).toHaveLength(0)
  })

  it('positions an idle driver pin from the freshest tracking ping, not the stale lane position', () => {
    const lb = useLoadboardStore()
    lb.loads = []
    lb.lanes = [
      { id: 'd-ref', name: 'Reference Driver', status: 'active', lastLat: 25, lastLng: -85 },
      { id: 'd9', name: 'Ping Driver', status: 'active', lastLat: 30, lastLng: -100 }, // stale lane fix
    ]
    useTrackingStore().locations = [{ driverId: 'd9', driverName: 'Ping Driver', latitude: 35, longitude: -90, speed: 40, createdAt: iso(NOW - 60_000) }] // fresh, different fix
    const w = mount(RadarView, { props: { nowMs: NOW } })
    const { px, py } = projector([[-85, 25], [-90, 35]]) // d-ref's lastLat/Lng + d9's fresh ping
    const pin = w.find('[data-driver="d9"]')
    expect(pin.exists()).toBe(true)
    const initialsText = pin.findAll('text')[0]
    expect(Number(initialsText.attributes('x'))).toBeCloseTo(px(-90), 1)
    expect(Number(initialsText.attributes('y'))).toBeCloseTo(py(35) + 3.5, 1)
  })

  it('draws the rolling leg marker at the fresh GPS ping instead of the time-interpolated point on the curve', () => {
    const lb = useLoadboardStore()
    lb.lanes = [{ id: 'd1', name: 'Driver One', status: 'active', lastLat: 55, lastLng: -70 }]
    lb.loads = [{ id: 'l1', reference: 'L-1', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B',
      stops: stops([40, -95], [42, -85]),
      assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 } }]
    useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Driver One', latitude: 55, longitude: -70, speed: 50, createdAt: iso(NOW - 60_000) }] // fresh (1 min old)
    const w = mount(RadarView, { props: { nowMs: NOW } })
    const { px, py } = projector([[-95, 40], [-85, 42], [-70, 55]])
    const marker = w.find('[data-pin="l1"]').findAll('circle')[1] // the solid marker circle, after the pulsing halo
    expect(Number(marker.attributes('cx'))).toBeCloseTo(px(-70), 1)
    expect(Number(marker.attributes('cy'))).toBeCloseTo(py(55), 1)
  })

  it('falls back to the time-interpolated point on the curve when there is no GPS ping', () => {
    const lb = useLoadboardStore()
    lb.lanes = [{ id: 'd1', name: 'Driver One', status: 'active', lastLat: 55, lastLng: -70 }]
    lb.loads = [{ id: 'l1', reference: 'L-1', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B',
      stops: stops([40, -95], [42, -85]),
      assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + H), marginCents: 1 } }]
    useTrackingStore().locations = [] // no ping at all
    const w = mount(RadarView, { props: { nowMs: NOW } })
    const { px, py } = projector([[-95, 40], [-85, 42], [-70, 55]])
    const { qx, qy } = curvePoint(px(-95), py(40), px(-85), py(42), 0.5)
    const marker = w.find('[data-pin="l1"]').findAll('circle')[1]
    expect(Number(marker.attributes('cx'))).toBeCloseTo(qx, 1)
    expect(Number(marker.attributes('cy'))).toBeCloseTo(qy, 1)
  })
})
