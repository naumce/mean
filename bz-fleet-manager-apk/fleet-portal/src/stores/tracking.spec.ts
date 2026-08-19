import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useTrackingStore } from './tracking'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)

const sampleLocation = {
  driverId: 'drv-1',
  driverName: 'Dana Driver',
  latitude: 40.7128,
  longitude: -74.006,
  speed: 32,
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('useTrackingStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts empty, not loading, no error', () => {
    const store = useTrackingStore()

    expect(store.locations).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('listLocations fetches the latest per-driver locations and populates locations', async () => {
    mockedGet.mockResolvedValueOnce({ data: [sampleLocation] })

    const store = useTrackingStore()
    await store.listLocations()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/locations')
    expect(store.locations).toEqual([sampleLocation])
    expect(store.error).toBeNull()
  })

  it('listLocations sets an error on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useTrackingStore()
    await store.listLocations()

    expect(store.locations).toEqual([])
    expect(store.error).toBeTruthy()
  })

  it('startPolling fetches immediately then repeatedly on the interval; stopPolling halts it', async () => {
    vi.useFakeTimers()
    mockedGet.mockResolvedValue({ data: [sampleLocation] })

    const store = useTrackingStore()
    store.startPolling(8000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockedGet).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(8000)
    expect(mockedGet).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(8000)
    expect(mockedGet).toHaveBeenCalledTimes(3)

    store.stopPolling()
    await vi.advanceTimersByTimeAsync(24000)
    expect(mockedGet).toHaveBeenCalledTimes(3)
  })

  it('startPolling clears any previous timer before starting a new one', async () => {
    vi.useFakeTimers()
    mockedGet.mockResolvedValue({ data: [sampleLocation] })

    const store = useTrackingStore()
    store.startPolling(8000)
    await vi.advanceTimersByTimeAsync(0)
    store.startPolling(8000)
    await vi.advanceTimersByTimeAsync(0)

    mockedGet.mockClear()
    await vi.advanceTimersByTimeAsync(8000)
    // Only one interval should be ticking, not two stacked ones.
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })
})
