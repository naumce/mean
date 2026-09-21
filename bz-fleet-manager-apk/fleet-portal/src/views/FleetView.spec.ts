import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import FleetView from './FleetView.vue'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const DAY = 24 * 3_600_000
const iso = (deltaDays: number) => new Date(Date.now() + deltaDays * DAY).toISOString()

const fleetPayload = {
  tractors: [
    { id: 't1', unit: '1207', make: 'Cascadia', status: 'active', lastLat: 39.1, lastLng: -94.6, inspectionExpiresAt: iso(-2), registrationExpiresAt: iso(200), nextServiceAt: iso(10) },
  ],
  trailers: [
    { id: 'v1', unit: 'DV-1', type: 'DryVan', status: 'active', lastLat: null, lastLng: null, inspectionExpiresAt: null, registrationExpiresAt: iso(90), nextServiceAt: null },
  ],
  drivers: [{ id: 'd1', name: 'Jake Morrow', medicalCertExpiresAt: iso(5) }],
}
const shops = [
  // Deliberately listed far-shop-first: the picker must re-rank by distance.
  { id: 's2', name: 'Gateway Fleet Service', address: 'St. Louis, MO', lat: 38.627, lng: -90.1994, phone: null },
  { id: 's1', name: 'KC Truck Center', address: 'Kansas City, MO', lat: 39.1, lng: -94.6, phone: null },
]
const records = [{ id: 'r1', kind: 'inspection', notes: 'annual', performedAt: iso(-30), nextDueAt: iso(335), shopName: 'KC Truck Center', unit: 'Tractor #1207' }]

function respond() {
  mockedGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/fleet')) return { data: fleetPayload }
    if (url.includes('services')) return { data: { shops } }
    return { data: { records } }
  })
}

describe('FleetView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
  })

  it('renders compliance chips: expired red, approaching amber, untracked honest', async () => {
    respond()
    const wrapper = mount(FleetView)
    await flushPromises()

    const tractor = wrapper.find('[data-tractor-row="1207"]')
    expect(tractor.find('[data-chip="expired"]').exists()).toBe(true)
    expect(tractor.text()).toContain('10d left') // service approaching
    expect(wrapper.find('[data-trailer-row="DV-1"]').text()).toContain('not tracked')
    expect(wrapper.find('[data-medical-row="Jake Morrow"]').text()).toContain('5d left')
    expect(wrapper.find('[data-testid="records-table"]').text()).toContain('KC Truck Center')
  })

  it('logs a service against the picked shop and refreshes the fleet', async () => {
    respond()
    mockedPost.mockResolvedValue({ data: { id: 'r2' } })
    const wrapper = mount(FleetView)
    await flushPromises()

    await wrapper.find('[data-log-service="1207"]').trigger('click')
    const form = wrapper.find('[data-testid="service-form"]')
    expect(form.text()).toContain('Tractor #1207')
    // Nearest shop first, measured from the unit's last position (KC, 0 mi).
    const options = form.find('[data-testid="service-shop"]').findAll('option')
    expect(options[0].text()).toBe('KC Truck Center (0 mi away)')
    expect(options[1].text()).toContain('Gateway Fleet Service (')
    await form.find('[data-testid="service-kind"]').setValue('inspection')
    const due = new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10)
    await form.find('[data-testid="service-next-due"]').setValue(due)
    await form.find('[data-testid="service-submit"]').trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/fleet/records', expect.objectContaining({
      shopId: 's1', tractorId: 't1', kind: 'inspection', nextDueAt: `${due}T12:00:00.000Z`,
    }))
    expect(wrapper.find('[data-testid="service-saved"]').exists()).toBe(true)
  })

  it('registers a new shop from the inline form', async () => {
    respond()
    mockedPost.mockResolvedValue({ data: { id: 's2' } })
    const wrapper = mount(FleetView)
    await flushPromises()

    await wrapper.find('[data-testid="add-shop-toggle"]').trigger('click')
    await wrapper.find('[data-testid="shop-name"]').setValue('STL Fleet Service')
    await wrapper.find('[data-testid="shop-address"]').setValue('St. Louis, MO')
    await wrapper.find('[data-testid="shop-submit"]').trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/fleet/services', {
      name: 'STL Fleet Service', address: 'St. Louis, MO',
    })
  })
})
