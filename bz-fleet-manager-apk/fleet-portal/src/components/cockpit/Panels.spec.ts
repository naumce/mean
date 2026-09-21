import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCockpitStore } from '../../stores/cockpit'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'
import ActivityPanel from './ActivityPanel.vue'
import BacklogPanel from './BacklogPanel.vue'
import BrickPopover from './BrickPopover.vue'
import MasterDrawer from './MasterDrawer.vue'
import ToastStack from './ToastStack.vue'
import YardChips from './YardChips.vue'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))
const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const load = (over: Partial<BoardLoad>): BoardLoad => ({
  id: 'l', reference: 'L', status: 'open', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 75000, stopCount: 1, origin: 'Chicago', destination: 'Indianapolis', assignment: null, ...over,
})

describe('BacklogPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useLoadboardStore().loads = [
      load({ id: 'l2', reference: 'L-51222', pickupWindowEnd: iso(NOW + 30 * H), brokerName: 'TQL' }),
      load({ id: 'l1', reference: 'L-51220', pickupWindowEnd: iso(NOW + 2 * H), brokerName: 'C.H. Robinson', weightLbs: 42000, commodity: 'Auto parts' }),
      load({ id: 'l3', reference: 'L-51221', hazmatClass: '8', unNumber: 'UN 1789', requiredEquip: 'Tanker' }),
    ]
    useCockpitStore().init('America/Chicago', NOW)
  })

  it('lists uncovered loads tightest-window first with urgency, freight and hazmat chips', async () => {
    const w = mount(BacklogPanel, { props: { nowMs: NOW } })
    const cards = w.findAll('[data-bid]')
    expect(cards.map((c) => c.attributes('data-bid'))).toEqual(['l1', 'l2', 'l3'])
    expect(cards[0].attributes('data-urgency')).toBe('now')
    expect(cards[0].text()).toContain('cover now')
    expect(cards[0].text()).toContain('42,000 lbs Auto parts')
    expect(cards[2].text()).toContain('HAZMAT CLASS 8 (UN 1789)')
    expect(w.text()).toContain('3 Open')
    await cards[1].trigger('click')
    expect(w.emitted('open')![0]).toEqual(['l2'])
  })
})

describe('YardChips', () => {
  it('renders the three yard groups from the loadboard store', () => {
    setActivePinia(createPinia())
    useLoadboardStore().yard = {
      tractors: [{ id: 't8', unit: '1184', make: 'Peterbilt 579', status: 'active' }],
      trailers: [{ id: 'r7', unit: 'DV-4432', type: 'DryVan', length: "53'", status: 'idle' }],
      drivers: [{ id: 'd7', name: 'Chuck Baker', status: 'active', hosKnown: true, driveRemainingMin: 660 }],
    }
    const w = mount(YardChips)
    expect(w.find('[data-res="tractor"][data-rid="t8"]').text()).toContain('#1184')
    expect(w.find('[data-res="trailer"][data-rid="r7"]').text()).toContain('DV-4432')
    expect(w.find('[data-res="driver"][data-rid="d7"]').text()).toContain('Chuck Baker')
    expect(w.find('[data-res="driver"][data-rid="d7"]').text()).toContain('11h 00m')
  })
})

describe('BrickPopover', () => {
  it('shows the load facts next to its anchor', () => {
    setActivePinia(createPinia())
    useLoadboardStore().lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const assignment = { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + 17 * H), marginCents: 58000, economics: { estCostCents: 17000, marginCents: 58000 }, deadheadMi: 12, loadedMi: 497 }
    const l = load({ id: 'l1', reference: 'L-51217', status: 'in_progress', commodity: 'Retail', brokerName: 'CHR', assignment })
    const w = mount(BrickPopover, { props: { load: l, anchor, tz: 'America/Chicago', nowMs: NOW } })
    expect(w.text()).toContain('L-51217')
    expect(w.text()).toContain('Jake Morrow')
    expect(w.text()).toContain('$750')
    expect(w.text()).toContain('$580')
    // est. cost is the snapshot's own figure, not revenue − margin.
    expect(w.find('[data-testid="popover-margin"]').text()).toContain('est. cost $170')
    expect(w.text()).toContain('12 mi deadhead')
    const hidden = mount(BrickPopover, { props: { load: null, anchor: null, tz: 'America/Chicago', nowMs: NOW } })
    expect(hidden.find('[data-testid="popover"]').exists()).toBe(false)
  })

  it('says "not priced" instead of inventing a margin and a cost for an unpriced load', () => {
    setActivePinia(createPinia())
    useLoadboardStore().lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const l = load({ id: 'l9', reference: 'L-9', status: 'assigned', assignment: { id: 'a9', driverId: 'd1', status: 'assigned', plannedStart: iso(NOW), plannedEnd: iso(NOW + 6 * H), marginCents: 0, economics: null, deadheadMi: 12 } })
    const w = mount(BrickPopover, { props: { load: l, anchor, tz: 'America/Chicago', nowMs: NOW } })
    const margin = w.find('[data-testid="popover-margin"]')
    expect(margin.text()).toContain('— not priced')
    expect(margin.text()).not.toContain('$0')
    expect(margin.text()).toContain('12 mi deadhead') // the miles are real and stay
    expect(margin.classes().join(' ')).not.toContain('emerald')
  })
})

describe('ActivityPanel + ToastStack', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('lists activity newest first, marks read, and jumps', async () => {
    const ck = useCockpitStore()
    ck.pushActivity('plan', 'L-1 dispatched', 'you', 'l1', NOW)
    ck.pushActivity('conflict', 'L-2 conflict', 'overlap', 'l2', NOW + 1)
    const w = mount(ActivityPanel, { props: { open: true } })
    const items = w.findAll('[data-testid="activity-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('L-2 conflict')
    await items[0].trigger('click')
    expect(w.emitted('jump')![0]).toEqual(['l2'])
    await w.find('[data-testid="mark-read"]').trigger('click')
    expect(ck.unreadActivity).toBe(0)
    expect(mount(ActivityPanel, { props: { open: false } }).find('[data-testid="activity-item"]').exists()).toBe(false)
  })

  it('toasts auto-dismiss after 5s and jump on click', async () => {
    const ck = useCockpitStore()
    const w = mount(ToastStack)
    ck.pushActivity('plan', 'L-1 dispatched', 'you', 'l1', NOW)
    await w.vm.$nextTick()
    expect(w.findAll('[data-testid="toast"]')).toHaveLength(1)
    await w.find('[data-testid="toast"]').trigger('click')
    expect(w.emitted('jump')![0]).toEqual(['l1'])
    ck.pushActivity('feed', 'ping', 'x', null, NOW)
    await w.vm.$nextTick()
    vi.advanceTimersByTime(5_100)
    await w.vm.$nextTick()
    expect(ck.toasts).toHaveLength(0)
  })
})

describe('MasterDrawer', () => {
  const TZ = 'America/Chicago'
  // Three stops on one meridian so the weighting is hand-checkable:
  //   1° of latitude = 69.09321 mi, planning speed 50 mph, dwell 60 min each.
  //   hop 1 (0.2°) =  13.8186 mi ->  16.582 min;  hop 2 (4°) = 276.373 mi -> 331.647 min
  //   c1 = 60 + 16.582 = 76.582 ; c2 = c1 + 60 + 331.647 = 468.230 -> share 0.16356
  //   over a 1000-minute window: 163.56 min after 19:32Z = 22:15Z = 17:15 CDT.
  //   Even spacing (the old behaviour) would have said 03:52Z = 22:52 CDT.
  const stops = [
    { sequence: 1, type: 'pickup', address: 'Topeka, KS', lat: 39, lng: -94.5, dwellMin: 60, windowStart: null, windowEnd: null },
    { sequence: 2, type: 'stop', address: 'Atchison, KS', lat: 39.2, lng: -94.5, dwellMin: 60, windowStart: null, windowEnd: null },
    { sequence: 3, type: 'delivery', address: 'Sioux Falls, SD', lat: 43.2, lng: -94.5, dwellMin: 60, windowStart: null, windowEnd: null },
  ]
  const assignment = { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW), plannedEnd: iso(NOW + 1000 * 60_000), marginCents: 24800, economics: { estCostCents: 39200, marginCents: 24800 }, deadheadMi: 45, loadedMi: 190 }
  const priced = load({ id: 'l1', reference: 'L-77080', status: 'in_progress', revenueCents: 64000, stopCount: 3, stops, assignment })

  beforeEach(() => {
    setActivePinia(createPinia())
    useCockpitStore().init(TZ, NOW)
  })

  it('spaces stop ETAs by real distance and dwell, and hedges them', () => {
    const w = mount(MasterDrawer, { props: { load: priced, nowMs: NOW, tz: TZ } })
    const text = w.text()
    expect(text).toContain('ETA ~') // interpolation, never presented as an exact arrival
    expect(text).toContain('Aug 28 @ 17:15') // weighted middle stop
    expect(text).not.toContain('Aug 28 @ 22:52') // what even spacing would have claimed
  })

  it('reads cost and profit from the committed snapshot', () => {
    const w = mount(MasterDrawer, { props: { load: priced, nowMs: NOW, tz: TZ } })
    expect(w.find('[data-testid="drawer-cost"]').text()).toContain('-$392')
    expect(w.find('[data-testid="drawer-profit"]').text()).toContain('+$248')
    expect(w.find('[data-testid="drawer-profit"]').text()).toContain('39%')
  })

  it('shows dashes, not a derived cost and a $0 profit, when the load was never priced', () => {
    // revenue − margin used to render "Est. cost: -$640" and "+$0 (0%)" under a
    // heading that claims to be a committed snapshot.
    const unpriced = load({ ...priced, assignment: { ...assignment, marginCents: 0, economics: null } })
    const w = mount(MasterDrawer, { props: { load: unpriced, nowMs: NOW, tz: TZ } })
    expect(w.find('[data-testid="drawer-cost"]').text()).toContain('—')
    expect(w.find('[data-testid="drawer-cost"]').text()).not.toContain('$640')
    const profit = w.find('[data-testid="drawer-profit"]')
    expect(profit.text()).toContain('— not priced')
    expect(profit.text()).not.toContain('$0')
    expect(profit.html()).not.toContain('emerald')
    expect(w.text()).toContain('$640') // the gross linehaul is real and still shown
  })
})

// Plan A3 (spec §8.3): the backlog rule is unchanged; a carrier lined up on an
// open load is a chip, not a lane — the boss can tell "no carrier" from
// "carrier not yet confirmed".
describe('BacklogPanel — the carrier chip', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useLoadboardStore().loads = [
      load({ id: 'p1', reference: '0563265', carrierId: 'c1', carrierName: 'Blue Road LLC' }),
      load({ id: 'p2', reference: '0563272', carrierId: null }),
    ]
    useCockpitStore().init('America/Chicago', NOW)
  })

  it('a backlog load with a carrier lined up shows the carrier chip; one without shows none', () => {
    const w = mount(BacklogPanel, { props: { nowMs: NOW } })
    const chips = w.findAll('[data-carrier-chip]')
    expect(chips).toHaveLength(1)
    expect(chips[0].text()).toBe('Blue Road LLC · pending')
    expect(w.find('[data-bid="p2"] [data-carrier-chip]').exists()).toBe(false)
  })
})
