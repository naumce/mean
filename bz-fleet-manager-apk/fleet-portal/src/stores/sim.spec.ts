import { AxiosError } from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSimState,
  postSimDriverMode,
  postSimReset,
  postSimStart,
  postSimStop,
  postSimTick,
  type SimState,
} from '../lib/api'
import { useSimStore } from './sim'

vi.mock('../lib/api', () => ({
  fetchSimState: vi.fn(),
  postSimTick: vi.fn(),
  postSimStart: vi.fn(),
  postSimStop: vi.fn(),
  postSimReset: vi.fn(),
  postSimDriverMode: vi.fn(),
}))

const mockedFetchState = vi.mocked(fetchSimState)
const mockedTick = vi.mocked(postSimTick)
const mockedStart = vi.mocked(postSimStart)
const mockedStop = vi.mocked(postSimStop)
const mockedReset = vi.mocked(postSimReset)
const mockedDriverMode = vi.mocked(postSimDriverMode)

function sampleState(overrides: Partial<SimState> = {}): SimState {
  return {
    running: false,
    speed: 1,
    simMinutesAdvanced: 0,
    simNowMs: Date.now(),
    lastTickAt: null,
    drivers: [],
    ...overrides,
  }
}

function notFoundError(): AxiosError {
  const err = new AxiosError('Not Found')
  err.response = { status: 404, data: {}, statusText: 'Not Found', headers: {}, config: {} as never }
  return err
}

function serverError(): AxiosError {
  const err = new AxiosError('Server Error')
  err.response = { status: 500, data: {}, statusText: 'Error', headers: {}, config: {} as never }
  return err
}

describe('useSimStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedFetchState.mockReset()
    mockedTick.mockReset()
    mockedStart.mockReset()
    mockedStop.mockReset()
    mockedReset.mockReset()
    mockedDriverMode.mockReset()
  })

  it('starts with unknown availability and no state', () => {
    const store = useSimStore()
    expect(store.available).toBeNull()
    expect(store.state).toBeNull()
    expect(store.busy).toBe(false)
    expect(store.error).toBeNull()
    expect(store.lastTickAt).toBeNull()
  })

  describe('probe', () => {
    it('sets available true and stores the state on success', async () => {
      mockedFetchState.mockResolvedValueOnce(sampleState({ running: true, speed: 5 }))
      const store = useSimStore()
      await store.probe()
      expect(store.available).toBe(true)
      expect(store.state?.running).toBe(true)
      expect(store.state?.speed).toBe(5)
      expect(store.error).toBeNull()
    })

    it('a 404 sets available false, silently (no error)', async () => {
      mockedFetchState.mockRejectedValueOnce(notFoundError())
      const store = useSimStore()
      await store.probe()
      expect(store.available).toBe(false)
      expect(store.state).toBeNull()
      expect(store.error).toBeNull()
    })

    it('a non-404 failure also hides the control but records an error', async () => {
      mockedFetchState.mockRejectedValueOnce(serverError())
      const store = useSimStore()
      await store.probe()
      expect(store.available).toBe(false)
      expect(store.error).toBeTruthy()
    })
  })

  describe('tick', () => {
    it('posts the tick, stamps lastTickAt, and re-probes', async () => {
      mockedTick.mockResolvedValueOnce({ simNowMs: Date.now(), pings: 1, started: 0, completed: 0, skipped: 0 })
      mockedFetchState.mockResolvedValueOnce(sampleState({ simMinutesAdvanced: 15 }))
      const store = useSimStore()

      await store.tick(15)

      expect(mockedTick).toHaveBeenCalledWith(15)
      expect(store.lastTickAt).toEqual(expect.any(Number))
      expect(mockedFetchState).toHaveBeenCalledTimes(1)
      expect(store.state?.simMinutesAdvanced).toBe(15)
      expect(store.busy).toBe(false)
    })

    it('sets an error and clears busy on failure, without touching lastTickAt', async () => {
      mockedTick.mockRejectedValueOnce(serverError())
      const store = useSimStore()
      await store.tick(15)
      expect(store.error).toBeTruthy()
      expect(store.lastTickAt).toBeNull()
      expect(store.busy).toBe(false)
    })
  })

  describe('start / stop', () => {
    it('start posts the speed then re-probes', async () => {
      mockedStart.mockResolvedValueOnce({ running: true, speed: 5 })
      mockedFetchState.mockResolvedValueOnce(sampleState({ running: true, speed: 5 }))
      const store = useSimStore()
      await store.start(5)
      expect(mockedStart).toHaveBeenCalledWith(5)
      expect(store.state?.running).toBe(true)
    })

    it('stop posts then re-probes', async () => {
      mockedStop.mockResolvedValueOnce({ running: false })
      mockedFetchState.mockResolvedValueOnce(sampleState({ running: false }))
      const store = useSimStore()
      await store.stop()
      expect(mockedStop).toHaveBeenCalled()
      expect(store.state?.running).toBe(false)
    })
  })

  describe('reset', () => {
    it('posts the reset then re-probes', async () => {
      mockedReset.mockResolvedValueOnce({ started: true })
      mockedFetchState.mockResolvedValueOnce(sampleState())
      const store = useSimStore()
      await store.reset()
      expect(mockedReset).toHaveBeenCalled()
      expect(mockedFetchState).toHaveBeenCalledTimes(1)
    })

    it('sets an error on failure', async () => {
      mockedReset.mockRejectedValueOnce(serverError())
      const store = useSimStore()
      await store.reset()
      expect(store.error).toBeTruthy()
    })
  })

  describe('setDriverMode', () => {
    it('posts the mode body, re-probes, and returns true', async () => {
      mockedDriverMode.mockResolvedValueOnce({
        driverId: 'd1', mode: 'offroute', modeUntil: null, offsetLat: 0.1, offsetLng: 0, updatedAt: new Date().toISOString(),
      })
      mockedFetchState.mockResolvedValueOnce(sampleState())
      const store = useSimStore()

      const ok = await store.setDriverMode('d1', { mode: 'offroute', offsetMi: 10 })

      expect(ok).toBe(true)
      expect(mockedDriverMode).toHaveBeenCalledWith('d1', { mode: 'offroute', offsetMi: 10 })
      expect(mockedFetchState).toHaveBeenCalledTimes(1)
    })

    it('returns false and sets an error on failure', async () => {
      mockedDriverMode.mockRejectedValueOnce(serverError())
      const store = useSimStore()
      const ok = await store.setDriverMode('d1', { mode: 'idle' })
      expect(ok).toBe(false)
      expect(store.error).toBeTruthy()
    })
  })
})
