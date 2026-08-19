import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useTripsStore } from './trips'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const sampleTrip = {
  id: 't1',
  identifier: 'TRIP-001',
  status: 'pending',
  driverId: null,
  stops: [{ id: 's1', sequence: 1, address: '123 Main St' }],
  createdAt: '2026-01-01',
}

describe('useTripsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
  })

  it('starts with no trips, no current trip, not loading, no error', () => {
    const store = useTripsStore()

    expect(store.items).toEqual([])
    expect(store.current).toBeNull()
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('list fetches trips from the dispatcher endpoint and populates items', async () => {
    mockedGet.mockResolvedValueOnce({ data: [sampleTrip] })

    const store = useTripsStore()
    await store.list()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/trips')
    expect(store.items).toEqual([sampleTrip])
    expect(store.error).toBeNull()
  })

  it('list passes status/driverId filters as query params', async () => {
    mockedGet.mockResolvedValueOnce({ data: [sampleTrip] })

    const store = useTripsStore()
    await store.list({ status: 'pending', driverId: 'drv-1' })

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/trips', { params: { status: 'pending', driverId: 'drv-1' } })
  })

  it('list sets an error and leaves items empty on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useTripsStore()
    await store.list()

    expect(store.items).toEqual([])
    expect(store.error).toBeTruthy()
    expect(store.loading).toBe(false)
  })

  it('get fetches a single trip and sets current', async () => {
    mockedGet.mockResolvedValueOnce({ data: sampleTrip })

    const store = useTripsStore()
    await store.get('t1')

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/trips/t1')
    expect(store.current).toEqual(sampleTrip)
  })

  it('get sets an error and leaves current null on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404, data: {} } })

    const store = useTripsStore()
    await store.get('missing')

    expect(store.current).toBeNull()
    expect(store.error).toBeTruthy()
  })

  it('create posts the nested stops payload to the dispatcher endpoint and refreshes the list', async () => {
    mockedPost.mockResolvedValueOnce({ data: sampleTrip })
    mockedGet.mockResolvedValueOnce({ data: [sampleTrip] })

    const store = useTripsStore()
    const payload = {
      identifier: 'TRIP-001',
      stops: [{ sequence: 1, address: '123 Main St' }],
      checklistItems: [{ label: 'Check tires', required: true }],
    }
    await store.create(payload)

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/trips', payload)
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/trips')
    expect(store.items).toEqual([sampleTrip])
  })

  it('create surfaces an error and does not refresh the list on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: 'Identifier already used' } },
    })

    const store = useTripsStore()
    await expect(store.create({ identifier: 'TRIP-001', stops: [] })).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('assign posts {driverId} to the assign endpoint and refreshes the list', async () => {
    mockedPost.mockResolvedValueOnce({ data: { ...sampleTrip, driverId: 'drv-1' } })
    mockedGet.mockResolvedValueOnce({ data: [{ ...sampleTrip, driverId: 'drv-1' }] })

    const store = useTripsStore()
    await store.assign('t1', 'drv-1')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/trips/t1/assign', { driverId: 'drv-1' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/trips')
    expect(store.items[0].driverId).toBe('drv-1')
  })

  it('assign surfaces an error and does not refresh the list on failure', async () => {
    mockedPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404, data: { error: 'Driver not found' } },
    })

    const store = useTripsStore()
    await expect(store.assign('t1', 'missing-driver')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })
})
