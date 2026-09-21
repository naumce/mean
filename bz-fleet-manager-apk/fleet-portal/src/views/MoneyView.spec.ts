import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import MoneyView from './MoneyView.vue'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedGet = vi.mocked(api.get)
const mockedPatch = vi.mocked(api.patch)

const costModel = { mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45, allInCentsPerMi: 167 }

const loser = {
  loadId: 'l1', ref: 'REF-loser', broker: 'Landstar', commodity: null, status: 'assigned',
  driverName: 'Jake', plannedStart: '2026-08-21T12:00:00.000Z',
  revenueCents: 10000, loadedMi: 166, deadheadMi: 12, totalMi: 178,
  rpmLoadedCents: 60, rpmAllCents: 56, estCostCents: 29700, marginCents: -19700, marginPct: -1.97,
}
const winner = {
  ...loser, loadId: 'l2', ref: 'REF-winner', driverName: 'Maya', deadheadMi: 0, totalMi: 166,
  revenueCents: 60000, rpmLoadedCents: 361, rpmAllCents: 361, estCostCents: 27700, marginCents: 32300, marginPct: 0.538,
}
const totals = {
  loads: 2, revenueCents: 70000, estCostCents: 57400, marginCents: 12600, marginPct: 0.18,
  loadedMi: 332, deadheadMi: 12, totalMi: 344, deadheadPct: 0.035, rpmLoadedCents: 211,
}

function respond(loads: unknown[] = [loser, winner]) {
  mockedGet.mockImplementation(async (url: string) =>
    url.includes('cost-model') ? { data: costModel } : { data: { loads, totals } },
  )
}

describe('MoneyView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPatch.mockReset()
  })

  it('renders the summary strip and the per-load table in server (worst-first) order', async () => {
    respond()
    const wrapper = mount(MoneyView)
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/economics', { params: {} })
    expect(wrapper.find('[data-testid="money-summary"]').text()).toContain('$700')
    const rows = wrapper.findAll('[data-money-row]')
    expect(rows[0].attributes('data-money-row')).toBe('REF-loser')
    expect(rows[0].text()).toContain('Jake')
    expect(rows[0].text()).toContain('+ 12 mi dh')
  })

  it('colors a money-losing load red and a healthy one green', async () => {
    respond()
    const wrapper = mount(MoneyView)
    await flushPromises()

    const loserRow = wrapper.find('[data-money-row="REF-loser"]')
    expect(loserRow.find('.text-red-600').exists()).toBe(true)
    const winnerRow = wrapper.find('[data-money-row="REF-winner"]')
    expect(winnerRow.find('.text-emerald-600').exists()).toBe(true)
  })

  it('loads the cost model into the editor and saves edits as integer cents', async () => {
    respond()
    mockedPatch.mockResolvedValue({ data: { ...costModel, dieselCentsPerGal: 520, allInCentsPerMi: 185 } })
    const wrapper = mount(MoneyView)
    await flushPromises()

    const diesel = wrapper.find('[data-testid="cost-diesel"]')
    expect((diesel.element as HTMLInputElement).value).toBe('4')
    await diesel.setValue('5.2')
    await wrapper.find('[data-testid="cost-save"]').trigger('click')
    await flushPromises()

    expect(mockedPatch).toHaveBeenCalledWith('/dispatcher/settings/cost-model', {
      mpg: 6.5, dieselCentsPerGal: 520, driverPayCentsPerMi: 60, fixedCentsPerMi: 45,
    })
    expect(wrapper.find('[data-testid="cost-saved"]').text()).toContain('Saved')
  })

  it('applying a date range reloads with an inclusive end day', async () => {
    respond()
    const wrapper = mount(MoneyView)
    await flushPromises()

    await wrapper.find('[data-testid="money-from"]').setValue('2026-08-01')
    await wrapper.find('[data-testid="money-to"]').setValue('2026-08-07')
    await wrapper.find('[data-testid="money-apply"]').trigger('click')
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/economics', {
      params: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' },
    })
  })

  it('shows the empty state when nothing is committed yet', async () => {
    respond([])
    const wrapper = mount(MoneyView)
    await flushPromises()
    expect(wrapper.find('[data-testid="money-empty"]').text()).toContain('No committed loads')
  })
})
