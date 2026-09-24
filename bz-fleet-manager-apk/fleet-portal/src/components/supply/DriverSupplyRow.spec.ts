import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DriverSupplyRow from './DriverSupplyRow.vue'
import type { SupplyDriver } from '../../types/supply'

const now = Date.now()

const onLoadDriver: SupplyDriver = {
  id: 'd1', name: 'Alice', firstName: 'Alice', lastName: 'A', phone: '555-0100',
  cdlClass: 'A', hazmatEndorsed: false, endorsements: ['N'], equipmentTypes: ['DryVan', 'Reefer'],
  languages: ['en'], preferredLanguage: 'en', homeBaseCity: 'Dallas', homeBaseState: 'TX', yearsExperience: 5,
  hos: {
    driveRemainingMin: 495, windowRemainingMin: 600, cycleRemainingMin: 3000, minutesSinceBreak: 0,
    lastResetAt: null, updatedAt: new Date(now).toISOString(), importedAt: null,
  },
  driverId: 'd1', acceptingLoads: false, locationSharingEnabled: true, locationSharingUpdatedAt: null,
  shareToken: 'tok-1', status: 'ON_LOAD', availableAt: now + 3_600_000,
  available: { lat: null, lng: null, city: 'Omaha', state: 'NE' },
  current: { lat: 41.65, lng: -83.53, at: now - 60_000, near: { city: 'Toledo', state: 'OH', distanceMi: 12 } },
  currentAssignment: { loadId: 'L1', loadRef: 'REF-1', deliveryEtaMs: now + 7_200_000, deliveryCity: 'Chicago' },
  source: 'manual',
}

const availableDriver: SupplyDriver = {
  id: 'd2', name: 'Bob', firstName: 'Bob', lastName: 'B', phone: null,
  cdlClass: 'A', hazmatEndorsed: false, endorsements: [], equipmentTypes: [],
  languages: [], preferredLanguage: 'en', homeBaseCity: null, homeBaseState: null, yearsExperience: null,
  hos: null,
  driverId: 'd2', acceptingLoads: true, locationSharingEnabled: false, locationSharingUpdatedAt: null,
  shareToken: null, status: 'AVAILABLE', availableAt: now - 1000,
  available: { lat: null, lng: null, city: null, state: null },
  current: null, currentAssignment: null, source: 'none',
}

function cell(wrapper: ReturnType<typeof mount>, col: string): string {
  return wrapper.find(`[data-col="${col}"]`).text()
}

function mountRow(driver: SupplyDriver) {
  return mount({ components: { DriverSupplyRow }, template: '<table><tbody><DriverSupplyRow :driver="driver" tz="America/Chicago" /></tbody></table>', data: () => ({ driver }) })
}

describe('DriverSupplyRow', () => {
  it('renders all ten columns for an ON_LOAD driver with a current load and a ping', () => {
    const wrapper = mountRow(onLoadDriver)
    expect(cell(wrapper, 'name')).toBe('Alice')
    expect(cell(wrapper, 'status')).toContain('On Load')
    expect(cell(wrapper, 'current')).toContain('near Toledo, OH')
    expect(cell(wrapper, 'current')).toContain('12 mi')
    expect(cell(wrapper, 'current-load')).toBe('REF-1 → Chicago')
    expect(cell(wrapper, 'delivery-eta')).not.toBe('—')
    expect(cell(wrapper, 'projected-availability')).toContain('Omaha, NE')
    expect(cell(wrapper, 'hos')).toContain('8:15')
    expect(wrapper.find('[data-testid="hos-stale-chip"]').exists()).toBe(false)
    expect(cell(wrapper, 'equipment')).toContain('DryVan')
    expect(cell(wrapper, 'equipment')).toContain('Reefer')
    expect(cell(wrapper, 'languages')).toBe('en')
    expect(cell(wrapper, 'home-base')).toBe('Dallas, TX')
  })

  it('renders the empty-state text for an AVAILABLE driver with no ping, no load, and no HOS', () => {
    const wrapper = mountRow(availableDriver)
    expect(cell(wrapper, 'status')).toContain('Available')
    expect(cell(wrapper, 'current')).toBe('no ping')
    expect(cell(wrapper, 'current-load')).toBe('—')
    expect(cell(wrapper, 'delivery-eta')).toBe('—')
    // availableDriver.availableAt is already in the past and available.city/
    // state are both null — exercises PROJECTED AVAILABILITY's "now" branch
    // and its "Unknown location" fallback together.
    expect(cell(wrapper, 'projected-availability')).toBe('Unknown location · now')
    expect(cell(wrapper, 'hos')).toBe('not imported')
    expect(cell(wrapper, 'equipment')).toBe('—')
    expect(cell(wrapper, 'home-base')).toBe('—')
  })

  it('shows a stale chip when hos.updatedAt is older than 8 hours', () => {
    const stale: SupplyDriver = {
      ...onLoadDriver,
      hos: { ...onLoadDriver.hos!, updatedAt: new Date(now - 9 * 3_600_000).toISOString() },
    }
    const wrapper = mountRow(stale)
    expect(wrapper.find('[data-testid="hos-stale-chip"]').exists()).toBe(true)
  })

  it('emits select with the driverId on click', async () => {
    const wrapper = mountRow(availableDriver)
    await wrapper.find('[data-testid="driver-row"]').trigger('click')
    expect(wrapper.findComponent(DriverSupplyRow).emitted('select')).toEqual([['d2']])
  })

  it('is keyboard-reachable: focusable and triggers select on Enter and Space', async () => {
    const wrapper = mountRow(availableDriver)
    const row = wrapper.find('[data-testid="driver-row"]')
    expect(row.attributes('tabindex')).toBe('0')
    expect(row.attributes('role')).toBe('button')

    await row.trigger('keydown.enter')
    await row.trigger('keydown.space')

    expect(wrapper.findComponent(DriverSupplyRow).emitted('select')).toEqual([['d2'], ['d2']])
  })
})
