import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CockpitLane } from '../../lib/cockpit/lanes'
import { useCarriersStore } from '../../stores/carriers'
import type { BoardLoad, BoardTractor, BoardTrailer, LoadboardLane } from '../../stores/loadboard'
import LaneHeadCarrier from './LaneHeadCarrier.vue'
import LaneHeadDriver from './LaneHeadDriver.vue'
import LaneHeadUnit from './LaneHeadUnit.vue'

const TZ = 'America/Chicago'
const NOW = Date.UTC(2026, 7, 28, 19, 32)
const D = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const jake: LoadboardLane = {
  id: 'd1', name: 'Jake Morrow', status: 'active', hosKnown: true, driveRemainingMin: 495, cycleRemainingMin: 2760, minutesSinceBreak: 90,
  hosImportedAt: iso(NOW - 3_600_000), hazmatEndorsed: true, medicalCertExpiresAt: iso(NOW + 400 * D), lastCity: 'Kansas City, MO', lastLocationAt: iso(NOW - 4 * 60_000),
  currentTractorId: 't1', currentTrailerId: 'r1',
}
const t1: BoardTractor = { id: 't1', unit: '1207', make: 'Peterbilt 579', cab: 'Sleeper', status: 'active', inspectionExpiresAt: iso(NOW + 80 * D), registrationExpiresAt: null, nextServiceAt: iso(NOW + 10 * D), currentDriverId: 'd1' }
const r1: BoardTrailer = { id: 'r1', unit: 'DV-4450', type: 'DryVan', length: "53'", status: 'active', features: '{"reeferSetpoint":-10}', inspectionExpiresAt: null, registrationExpiresAt: iso(NOW - 16 * D), nextServiceAt: null, currentDriverId: 'd1' }
const rolling: BoardLoad = { id: 'l1', reference: 'L-1', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 145000, stopCount: 2, origin: 'KC', destination: 'CHI',
  assignment: { id: 'a1', driverId: 'd1', status: 'in_progress', plannedStart: iso(NOW - 3_600_000), plannedEnd: iso(NOW + 8 * 3_600_000), marginCents: 58000, economics: { estCostCents: 87000, marginCents: 58000 }, deadheadMi: 0, loadedMi: 497 } }
const lane: CockpitLane = { id: 'd1', kind: 'driver', name: 'Jake Morrow', sub: 'active', driver: jake, legs: [rolling] }

// LaneHeadDriver reads useCarriersStore() (T1 Carrier Layer, Task 8) — every
// mount needs an active Pinia even for tests unrelated to carriers.
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('LaneHeadDriver', () => {
  it('renders the composite header from real fields', () => {
    const w = mount(LaneHeadDriver, { props: { lane, tractor: t1, trailer: r1, nowMs: NOW, tz: TZ, plannedDriveMin: 300, lastPing: { driverId: 'd1', latitude: 39, longitude: -94, speed: 58, createdAt: iso(NOW - 4 * 60_000) } } })
    expect(w.find('[data-testid="lane-name"]').text()).toBe('Jake Morrow')
    expect(w.text()).toContain('#1207 Sleeper')
    expect(w.text()).toContain('DV-4450 (53\' DryVan)')
    expect(w.find('[data-testid="lane-telemetry"]').text()).toBe('58 MPH')
    expect(w.text()).toContain('SET -10°F')
    expect(w.find('[data-testid="lane-pill"]').text()).toBe('ROLLING')
    expect(w.find('[data-testid="lane-city"]').text()).toContain('Kansas City, MO')
    expect(w.find('[data-testid="lane-city"]').text()).toContain('(4m)')
    expect(w.find('[data-testid="lane-drv"]').text()).toBe('DRV: 8h 15m')
    expect(w.find('[data-testid="lane-cyc"]').text()).toBe('CYC: 46h 00m')
    expect(w.find('[data-testid="lane-tobreak"]').text()).toContain('6h 30m to break')
    expect(w.find('[data-testid="lane-money"]').text()).toContain('$1,450')
    expect(w.find('[data-testid="lane-money"]').text()).toContain('40% mgn')
    // compliance chips: MED ok (green), DOT ok, REG expired (red), PM soon (amber)
    expect(w.find('[data-testid="chip-MED"]').classes().join(' ')).toContain('emerald')
    expect(w.find('[data-testid="chip-REG"]').text()).toContain('EXPIRED')
    expect(w.find('[data-testid="chip-REG"]').classes().join(' ')).toContain('red')
    expect(w.find('[data-testid="chip-PM"]').classes().join(' ')).toContain('amber')
    expect(w.find('[data-testid="chip-HZ"]').exists()).toBe(true)
    // HOS bar: 300 planned of 495 -> 61%
    expect(w.find('[data-testid="lane-hos-bar"] span').attributes('style')).toContain('width: 61%')
    expect(w.find('[data-testid="lane-hos-stale"]').exists()).toBe(false)
  })

  it('flags stale/unknown HOS, over-planned drive, and no GPS', () => {
    const w = mount(LaneHeadDriver, { props: { lane: { ...lane, driver: { ...jake, hosImportedAt: null } }, nowMs: NOW, tz: TZ, plannedDriveMin: 600 } })
    expect(w.find('[data-testid="lane-hos-stale"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-hos"]').classes()).toContain('text-red-500')
    expect(w.find('[data-testid="lane-telemetry"]').text()).toBe('NO GPS')
  })

  it('shows no margin percentage when no leg on the lane was priced, and reddens a negative one', () => {
    const unpriced = { ...rolling, assignment: { ...rolling.assignment!, marginCents: 0, economics: null } }
    const w = mount(LaneHeadDriver, { props: { lane: { ...lane, legs: [unpriced] }, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
    // Revenue is still real; the margin is not, so it must not read "0% mgn" in green.
    expect(w.find('[data-testid="lane-money"]').text()).toContain('$1,450')
    expect(w.find('[data-testid="lane-money"]').text()).toContain('— mgn')
    expect(w.find('[data-testid="lane-money"]').html()).not.toContain('emerald')

    const loser = { ...rolling, assignment: { ...rolling.assignment!, marginCents: -14500, economics: { estCostCents: 159500, marginCents: -14500 } } }
    const red = mount(LaneHeadDriver, { props: { lane: { ...lane, legs: [loser] }, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
    expect(red.find('[data-testid="lane-money"]').text()).toContain('-10% mgn')
    expect(red.find('[data-testid="lane-money"]').html()).toContain('text-red-500')
  })

  it('clicking the name emits open', async () => {
    const w = mount(LaneHeadDriver, { props: { lane, nowMs: NOW, tz: TZ, plannedDriveMin: 0 } })
    await w.find('[data-testid="lane-name"]').trigger('click')
    expect(w.emitted('open')![0]).toEqual(['d1'])
  })

  it('never paints the HOS bar green when legal hours were never imported', () => {
    // hosKnown: false, driveRemainingMin: null — the bar must read as
    // "unknown", not silently fall through to the ok/green branch just
    // because there's nothing to compare against.
    const unknownDriver = { ...jake, hosKnown: false, driveRemainingMin: null, hosImportedAt: null, minutesSinceBreak: 90 }
    const w = mount(LaneHeadDriver, { props: { lane: { ...lane, driver: unknownDriver }, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
    const fill = w.find('[data-testid="lane-hos-bar"] span')
    expect(fill.classes().join(' ')).not.toContain('emerald')
    expect(fill.classes().join(' ')).not.toContain('red')
    expect(w.find('[data-testid="lane-hos"]').classes()).not.toContain('text-red-500')
    expect(w.find('[data-testid="lane-hos"]').attributes('title')).toContain('not imported')
    expect(w.find('[data-testid="lane-tobreak"]').exists()).toBe(false)
  })

  it('compact mode still surfaces expired compliance, stale HOS, and over-plan — drops everything else', () => {
    const staleOverplanned = { ...jake, hosImportedAt: null }
    const w = mount(LaneHeadDriver, {
      props: {
        lane: { ...lane, driver: staleOverplanned },
        tractor: t1,
        trailer: r1,
        nowMs: NOW,
        tz: TZ,
        plannedDriveMin: 600, // > 495 driveRemainingMin -> over-planned
        compact: true,
      },
    })
    // kept: expired REG chip, stale HOS chip, over-plan warning
    expect(w.find('[data-testid="chip-REG"]').exists()).toBe(true)
    expect(w.find('[data-testid="chip-REG"]').text()).toContain('EXPIRED')
    expect(w.find('[data-testid="lane-hos-stale"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-hos"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-hos"]').text()).toContain('⚠')
    // dropped: ok/soon-level chips, HAZMAT, and the comfortable footer (bar/ratio/break/money)
    expect(w.find('[data-testid="chip-MED"]').exists()).toBe(false)
    expect(w.find('[data-testid="chip-DOT"]').exists()).toBe(false)
    expect(w.find('[data-testid="chip-PM"]').exists()).toBe(false)
    expect(w.find('[data-testid="chip-HZ"]').exists()).toBe(false)
    expect(w.find('[data-testid="lane-hos-bar"]').exists()).toBe(false)
    expect(w.find('[data-testid="lane-tobreak"]').exists()).toBe(false)
    expect(w.find('[data-testid="lane-money"]').exists()).toBe(false)
  })

  // T1 Carrier Layer, Task 8
  describe('carrier tag', () => {
    const carried: LoadboardLane = { ...jake, carrierId: 'c1', carrierName: 'Swift Logistics' }

    it('shows the carrier name when the org has more than one carrier', () => {
      useCarriersStore().list = [
        { id: 'c1', name: 'Swift Logistics', mcNumber: null, dotNumber: null, status: 'active', mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null },
        { id: 'c2', name: 'Other Carrier', mcNumber: null, dotNumber: null, status: 'active', mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null },
      ]
      const w = mount(LaneHeadDriver, { props: { lane: { ...lane, driver: carried }, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
      expect(w.find('[data-testid="lane-carrier"]').exists()).toBe(true)
      expect(w.find('[data-testid="lane-carrier"]').text()).toBe('Swift Logistics')
    })

    it('shows nothing when the org has only one carrier — no clutter for a single-carrier org', () => {
      useCarriersStore().list = [
        { id: 'c1', name: 'Swift Logistics', mcNumber: null, dotNumber: null, status: 'active', mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null },
      ]
      const w = mount(LaneHeadDriver, { props: { lane: { ...lane, driver: carried }, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
      expect(w.find('[data-testid="lane-carrier"]').exists()).toBe(false)
    })

    it('shows nothing for an org not yet using the carrier layer at all (empty roster)', () => {
      const w = mount(LaneHeadDriver, { props: { lane: { ...lane, driver: carried }, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
      expect(w.find('[data-testid="lane-carrier"]').exists()).toBe(false)
    })

    it('shows nothing for a carrier-less driver even in a multi-carrier org', () => {
      useCarriersStore().list = [
        { id: 'c1', name: 'Swift Logistics', mcNumber: null, dotNumber: null, status: 'active', mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null },
        { id: 'c2', name: 'Other Carrier', mcNumber: null, dotNumber: null, status: 'active', mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null },
      ]
      // jake has no carrierId/carrierName set (undefined) — nothing to show.
      const w = mount(LaneHeadDriver, { props: { lane, nowMs: NOW, tz: TZ, plannedDriveMin: 300 } })
      expect(w.find('[data-testid="lane-carrier"]').exists()).toBe(false)
    })
  })
})

describe('LaneHeadUnit', () => {
  it('tractor lane: unit, make, chips, pill, paired driver', () => {
    const w = mount(LaneHeadUnit, { props: { lane: { id: 't1', kind: 'tractor', name: '#1207', sub: 'Peterbilt 579 · Sleeper', tractor: t1, legs: [] }, driverName: 'Jake Morrow', nowMs: NOW } })
    expect(w.text()).toContain('#1207')
    expect(w.text()).toContain('Peterbilt 579 · Sleeper')
    expect(w.text()).toContain('Jake Morrow')
    expect(w.find('[data-testid="lane-pill"]').text()).toBe('ASSIGNED')
    expect(w.find('[data-testid="chip-DOT"]').exists()).toBe(true)
  })
  it('trailer lane: dropped unit shows DROPPED, expired registration wins', () => {
    const dropped = mount(LaneHeadUnit, { props: { lane: { id: 'r9', kind: 'trailer', name: 'FB-3325', sub: "Flatbed · 48'", trailer: { ...r1, id: 'r9', unit: 'FB-3325', type: 'Flatbed', status: 'idle', registrationExpiresAt: null, currentDriverId: null }, legs: [] }, driverName: null, nowMs: NOW } })
    expect(dropped.find('[data-testid="lane-pill"]').text()).toBe('DROPPED')
    const expired = mount(LaneHeadUnit, { props: { lane: { id: 'r1', kind: 'trailer', name: 'DV-4450', sub: "DryVan · 53'", trailer: r1, legs: [] }, driverName: 'Jake Morrow', nowMs: NOW } })
    expect(expired.find('[data-testid="lane-pill"]').text()).toBe('REG EXPIRED')
  })
})

// Plan A3 (spec §8.3): the head for a brokered lane — a carrier's name/MC and
// how many of their loads are on the board. No driver, no unit, no clocks.
describe('LaneHeadCarrier', () => {
  it('shows the carrier, its MC and the load count', () => {
    const lane = { id: 'carrier:c1', kind: 'brokered', name: 'Blue Road LLC', sub: 'MC 1000001', carrier: { id: 'c1', name: 'Blue Road LLC', mc: '1000001' }, legs: [{ id: 'b1' }, { id: 'b2' }] } as never
    const w = mount(LaneHeadCarrier, { props: { lane, nowMs: Date.now() } })
    expect(w.text()).toContain('Blue Road LLC')
    expect(w.text()).toContain('MC 1000001')
    expect(w.text()).toContain('2 loads')
    expect(w.find('[data-testid="lane-pill"]').text()).toBe('BROKERED')
  })
})
