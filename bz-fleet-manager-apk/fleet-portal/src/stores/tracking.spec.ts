import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { TOKEN_STORAGE_KEY } from '../lib/constants'
import { useTrackingStore } from './tracking'

// API_BASE_URL must be in the factory: tracking.ts subscribes through the
// shared realtime singleton (lib/realtime.ts), which derives its ws:// URL
// from this value via lib/wsUrl.ts.
vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
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

  describe('realtime', () => {
    // The socket now lives in lib/realtime.ts (plan A4) — this harness drives
    // IT, not the store, and asserts on frames delivered through subscribe().
    class FakeWebSocket {
      static instances: FakeWebSocket[] = []
      url: string
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      closed = false
      constructor(url: string) {
        this.url = url
        FakeWebSocket.instances.push(this)
      }
      close(): void {
        this.closed = true
        this.onclose?.()
      }
    }

    beforeEach(() => {
      FakeWebSocket.instances = []
      vi.stubGlobal('WebSocket', FakeWebSocket)
      localStorage.setItem(TOKEN_STORAGE_KEY, 'tok123')
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      localStorage.clear()
    })

    it('driver_location frames upsert markers: new drivers append, known ones move', () => {
      const store = useTrackingStore()
      store.locations = [sampleLocation]
      store.connectRealtime()
      store.connectRealtime() // no second socket
      expect(FakeWebSocket.instances).toHaveLength(1)

      const push = (payload: Record<string, unknown>) =>
        FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify(payload) })

      push({
        type: 'driver_location', driverId: 'drv-1', driverName: 'Dana Driver',
        latitude: 41.0, longitude: -75.0, at: '2026-08-21T12:00:00.000Z',
      })
      expect(store.locations).toHaveLength(1)
      expect(store.locations[0].latitude).toBe(41.0)

      push({
        type: 'driver_location', driverId: 'drv-2', driverName: 'New Driver',
        latitude: 39.1, longitude: -94.6, at: '2026-08-21T12:01:00.000Z',
      })
      expect(store.locations).toHaveLength(2)
      expect(store.locations[1].driverName).toBe('New Driver')

      // Non-location frames and malformed payloads are ignored.
      push({ type: 'board_update' })
      push({ type: 'driver_location', driverId: 'drv-3' })
      expect(store.locations).toHaveLength(2)

      store.disconnectRealtime()
      expect(FakeWebSocket.instances[0].closed).toBe(true)
    })
  })
})
