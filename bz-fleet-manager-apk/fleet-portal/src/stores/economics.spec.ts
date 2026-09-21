import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useEconomicsStore } from './economics'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
vi.mock('../lib/download', () => ({ triggerDownload: vi.fn() }))
const mockedGet = vi.mocked(api.get)
const mockedPatch = vi.mocked(api.patch)

const row = {
  loadId: 'l1', ref: 'REF-1', broker: 'Landstar', commodity: null, status: 'assigned',
  driverName: 'Jake', plannedStart: '2026-08-21T12:00:00.000Z',
  revenueCents: 34000, loadedMi: 166, deadheadMi: 0, totalMi: 166,
  rpmLoadedCents: 205, rpmAllCents: 205, estCostCents: 27700, marginCents: 6300, marginPct: 0.185,
}
const totals = {
  loads: 1, revenueCents: 34000, estCostCents: 27700, marginCents: 6300, marginPct: 0.185,
  loadedMi: 166, deadheadMi: 0, totalMi: 166, deadheadPct: 0, rpmLoadedCents: 205,
}
const costModel = { mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45, allInCentsPerMi: 167 }

describe('economics store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPatch.mockReset()
  })

  it('loadEconomics stores rows and totals', async () => {
    mockedGet.mockResolvedValue({ data: { loads: [row], totals } })
    const store = useEconomicsStore()
    await store.loadEconomics()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/economics', { params: {} })
    expect(store.rows).toHaveLength(1)
    expect(store.totals?.marginCents).toBe(6300)
    expect(store.error).toBeNull()
  })

  it('a date range rides both the load and the export, so the file matches the screen', async () => {
    const { triggerDownload } = await import('../lib/download')
    mockedGet.mockResolvedValue({ data: { loads: [], totals } })
    const store = useEconomicsStore()
    const range = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' }
    await store.loadEconomics(range)
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/economics', { params: range })

    mockedGet.mockResolvedValue({ data: 'csv' })
    await store.exportCsv()
    expect(mockedGet).toHaveBeenLastCalledWith('/dispatcher/economics', {
      params: { format: 'csv', ...range },
      responseType: 'text',
    })
    expect(vi.mocked(triggerDownload)).toHaveBeenCalled()
  })

  it('saveCostModel PATCHes the update and keeps the server echo', async () => {
    mockedPatch.mockResolvedValue({ data: { ...costModel, dieselCentsPerGal: 500, allInCentsPerMi: 182 } })
    const store = useEconomicsStore()
    await store.saveCostModel({ dieselCentsPerGal: 500 })
    expect(mockedPatch).toHaveBeenCalledWith('/dispatcher/settings/cost-model', { dieselCentsPerGal: 500 })
    expect(store.costModel?.dieselCentsPerGal).toBe(500)
    expect(store.costModel?.allInCentsPerMi).toBe(182)
    expect(store.saved).toBe(true)
    expect(store.saving).toBe(false)
  })

  it('exportCsv fetches the CSV rendering and hands it to the browser download', async () => {
    const { triggerDownload } = await import('../lib/download')
    mockedGet.mockResolvedValue({ data: 'load,broker\r\nREF-1,Landstar\r\n' })
    const store = useEconomicsStore()
    await store.exportCsv()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/economics', {
      params: { format: 'csv' },
      responseType: 'text',
    })
    expect(vi.mocked(triggerDownload)).toHaveBeenCalledWith(
      expect.stringMatching(/^money-per-load-\d{4}-\d{2}-\d{2}\.csv$/),
      'load,broker\r\nREF-1,Landstar\r\n',
    )
  })

  it('surfaces API failures as user-facing errors', async () => {
    mockedGet.mockRejectedValue(new Error('network down'))
    const store = useEconomicsStore()
    await store.loadEconomics()
    expect(store.error).toBeTruthy()
    expect(store.rows).toHaveLength(0)
  })
})
