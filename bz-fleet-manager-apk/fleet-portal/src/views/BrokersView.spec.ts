import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import BrokersView from './BrokersView.vue'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
vi.mock('../lib/download', () => ({ triggerDownload: vi.fn() }))
const mockedGet = vi.mocked(api.get)

// The view calls /analytics/brokers, /analytics/lanes, and /settlements on mount.
const emptySettlements = {
  from: '2026-08-14T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z', driverPayCentsPerMi: 60,
  drivers: [], totals: { loads: 0, loadedMi: 0, deadheadMi: 0, totalMi: 0, revenueCents: 0, marginCents: 0, estPayCents: 0 },
}

function respondWith(brokers: unknown[], lanes: unknown[] = [], settlements: unknown = emptySettlements) {
  mockedGet.mockImplementation(async (url: string) => {
    if (url.includes('settlements')) return { data: settlements }
    if (url.includes('lanes')) return { data: { lanes } }
    return { data: { brokers } }
  })
}

const kcOmaha = {
  lane: '39.1,-94.6>41.3,-95.9', origin: 'Kansas City, MO', destination: 'Omaha, NE',
  runs: 3, revenueCents: 90000, marginCents: 30000, topDriver: 'Jake (2)',
}

const landstar = {
  broker: 'Landstar', loads: 2, revenueCents: 95000, estCostCents: 55000, marginCents: 40000,
  loadedMi: 350, deadheadMi: 20, totalMi: 370, avgMarginPct: 0.421, ratePerLoadedMiCents: 271,
  deadheadPct: 0.054,
}

describe('BrokersView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
  })

  it('loads both rollups on mount and renders broker economics', async () => {
    respondWith([landstar], [kcOmaha])
    const wrapper = mount(BrokersView)
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/analytics/brokers')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/analytics/lanes')
    const row = wrapper.find('[data-broker="Landstar"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('$950')
    expect(row.text()).toContain('$400')
    expect(row.text()).toContain('42%')
    expect(row.text()).toContain('2.71')
  })

  it('renders the recurring-lanes table with runs and top driver', async () => {
    respondWith([landstar], [kcOmaha])
    const wrapper = mount(BrokersView)
    await flushPromises()

    const lane = wrapper.find('[data-lane-row="39.1,-94.6>41.3,-95.9"]')
    expect(lane.exists()).toBe(true)
    expect(lane.text()).toContain('Kansas City, MO → Omaha, NE')
    expect(lane.text()).toContain('Jake (2)')
  })

  it('Export CSV asks the API for the csv rendering of the rollup', async () => {
    respondWith([landstar], [kcOmaha])
    const wrapper = mount(BrokersView)
    await flushPromises()
    mockedGet.mockResolvedValue({ data: 'broker,loads\r\n' })
    await wrapper.find('[data-testid="brokers-export"]').trigger('click')
    await flushPromises()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/analytics/brokers', {
      params: { format: 'csv' },
      responseType: 'text',
    })
  })

  it('renders driver settlements with pay-at-rate and a Total row', async () => {
    // Two drivers on carriers with DIFFERENT pay rates. The old payload carried
    // one top-level driverPayCentsPerMi and the header rendered it; with carriers
    // there is no single rate to show, so the backend dropped it and the rate is
    // now per row. This test pins that: two rates visible at once, which the old
    // header could not express.
    respondWith([], [], {
      from: '2026-08-14T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z',
      drivers: [
        {
          driverId: 'd1', driverName: 'Jake', loads: 2, loadedMi: 280, deadheadMi: 20, totalMi: 300,
          revenueCents: 80000, marginCents: 30000, estPayCents: 21000, rpmLoadedCents: 286,
          driverPayCentsPerMi: 70,
        },
        {
          driverId: 'd2', driverName: 'Mona', loads: 1, loadedMi: 190, deadheadMi: 10, totalMi: 200,
          revenueCents: 50000, marginCents: 12000, estPayCents: 18000, rpmLoadedCents: 263,
          driverPayCentsPerMi: 90,
        },
      ],
      totals: { loads: 3, loadedMi: 470, deadheadMi: 30, totalMi: 500, revenueCents: 130000, marginCents: 42000, estPayCents: 39000 },
    })
    const wrapper = mount(BrokersView)
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/settlements', { params: {} })
    const jake = wrapper.find('[data-settlement-row="Jake"]')
    expect(jake.text()).toContain('300 mi')
    expect(jake.text()).toContain('$210')
    expect(jake.text()).toContain('@ $0.70/mi')

    const mona = wrapper.find('[data-settlement-row="Mona"]')
    expect(mona.text()).toContain('$180')
    expect(mona.text()).toContain('@ $0.90/mi')

    // The header must NOT claim a single rate any more — that was the bug.
    expect(wrapper.find('[data-testid="settlements-card"]').text()).not.toContain('@ $0.70/mi @')
    // Totals now span both drivers: 80000 + 50000 cents of revenue.
    expect(wrapper.find('[data-testid="settlements-total"]').text()).toContain('$1,300')
    // And the total pay is the sum of two DIFFERENT carrier rates ($210 + $180),
    // which is the number the old single-rate header could never have explained.
    expect(wrapper.find('[data-testid="settlements-total"]').text()).toContain('$390')
  })

  it('the scoreboard ranks by profit by default and re-ranks by revenue on toggle', async () => {
    const hauler = { // most revenue, thin margin
      driverId: 'd1', driverName: 'Jake', loads: 3, loadedMi: 900, deadheadMi: 30, totalMi: 930,
      revenueCents: 250000, marginCents: 20000, estPayCents: 55800, rpmLoadedCents: 278,
    }
    const earner = { // less revenue, best profit
      driverId: 'd2', driverName: 'Maria', loads: 2, loadedMi: 500, deadheadMi: 10, totalMi: 510,
      revenueCents: 180000, marginCents: 60000, estPayCents: 30600, rpmLoadedCents: 360,
    }
    respondWith([], [], {
      from: '2026-08-14T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z', driverPayCentsPerMi: 60,
      drivers: [hauler, earner],
      totals: { loads: 5, loadedMi: 1400, deadheadMi: 40, totalMi: 1440, revenueCents: 430000, marginCents: 80000, estPayCents: 86400 },
    })
    const wrapper = mount(BrokersView)
    await flushPromises()

    // Default: by profit — Maria tops the podium despite hauling less.
    let rows = wrapper.findAll('[data-settlement-row]')
    expect(rows[0].attributes('data-settlement-row')).toBe('Maria')
    expect(rows[0].text()).toContain('🥇')

    await wrapper.find('[data-testid="score-by-revenue"]').trigger('click')
    rows = wrapper.findAll('[data-settlement-row]')
    expect(rows[0].attributes('data-settlement-row')).toBe('Jake')
  })

  it('applying a date range reloads settlements with an inclusive end day', async () => {
    respondWith([], [])
    const wrapper = mount(BrokersView)
    await flushPromises()

    await wrapper.find('[data-testid="settle-from"]').setValue('2026-08-01')
    await wrapper.find('[data-testid="settle-to"]').setValue('2026-08-07')
    await wrapper.find('[data-testid="settle-apply"]').trigger('click')
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/settlements', {
      params: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' },
    })
  })

  it('shows the empty state when nothing is committed yet', async () => {
    respondWith([], [])
    const wrapper = mount(BrokersView)
    await flushPromises()
    expect(wrapper.find('[data-testid="brokers-empty"]').text()).toContain('No committed loads')
  })
})
