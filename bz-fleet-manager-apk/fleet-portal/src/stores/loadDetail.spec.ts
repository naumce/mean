import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useLoadDetailStore } from './loadDetail'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedGet = vi.mocked(api.get)
const mockedPatch = vi.mocked(api.patch)

const detail = { id: 'l1', externalId: 'L-1', status: 'open', requiredEquip: 'DryVan', revenueCents: 30000, fscCents: 0, stops: [], assignment: null, rate: null }

describe('loadDetail store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPatch.mockReset()
  })

  it('open() fetches the load; close() clears it', async () => {
    mockedGet.mockResolvedValue({ data: detail })
    const store = useLoadDetailStore()
    await store.open('l1')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loads/l1')
    expect(store.detail?.externalId).toBe('L-1')
    store.close()
    expect(store.detail).toBeNull()
  })

  it('save() patches and merges the response', async () => {
    mockedGet.mockResolvedValue({ data: detail })
    mockedPatch.mockResolvedValue({ data: { ...detail, revenueCents: 45000 } })
    const store = useLoadDetailStore()
    await store.open('l1')
    const ok = await store.save({ revenueCents: 45000 })
    expect(ok).toBe(true)
    expect(mockedPatch).toHaveBeenCalledWith('/dispatcher/loads/l1', { revenueCents: 45000 })
    expect(store.detail?.revenueCents).toBe(45000)
  })

  it('save() without an open detail is a no-op returning false', async () => {
    const store = useLoadDetailStore()
    expect(await store.save({ revenueCents: 1 })).toBe(false)
    expect(mockedPatch).not.toHaveBeenCalled()
  })
})
