import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { TOKEN_STORAGE_KEY } from '../lib/constants'
import { __state } from '../lib/realtime'
import { boardWsUrl, useLoadboardStore } from './loadboard'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedDelete = vi.mocked(api.delete)

const boardPayload = {
  lanes: [{ id: 'd1', name: 'Jake', status: 'offline' }],
  loads: [
    {
      id: 'l1', reference: 'L-1', status: 'open', requiredEquip: 'Reefer', hazmatClass: null,
      revenueCents: 52000, stopCount: 2, origin: 'Kansas City', destination: 'Omaha', assignment: null,
    },
    {
      id: 'l2', reference: 'L-2', status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null,
      revenueCents: 30000, stopCount: 2, origin: 'Memphis', destination: 'Little Rock',
      assignment: { driverId: 'd1', plannedStart: '2026-08-21T09:00:00.000Z', plannedEnd: '2026-08-21T14:00:00.000Z', marginCents: 9900 },
    },
  ],
}

describe('loadboard store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
  })

  // Plan A4, Task 4: the store's own socket is gone — it only tells the
  // singleton (lib/realtime.ts) which frame types it wants. Placed first in
  // this file so it runs against a pristine singleton (no leftover
  // subscriptions from another test, no token in localStorage yet).
  it('opens no socket of its own — realtime is the singleton (plan A4)', async () => {
    const spy = vi.spyOn(globalThis, 'WebSocket' as never)
    const store = useLoadboardStore()
    store.connectRealtime()
    expect(spy).not.toHaveBeenCalled() // the store itself constructs nothing
    expect(__state().types).toContain('board_update')
    expect(__state().types).toContain('driver_status')
    store.disconnectRealtime() // leave the singleton's handler map clean for later tests
  })

  it('load() populates lanes and loads; backlog is the unassigned subset', async () => {
    mockedGet.mockResolvedValue({ data: boardPayload })
    const store = useLoadboardStore()
    await store.load()
    expect(store.lanes).toHaveLength(1)
    expect(store.loads).toHaveLength(2)
    expect(store.backlog.map((l) => l.id)).toEqual(['l1'])
  })

  // Plan A3, H2 (:455): a covered brokered load — no Assignment of ours,
  // because the truck is a carrier's — must not read as backlog just because
  // `!l.assignment` is true. Same rule as LoadboardView's `visibleBacklog`
  // and cockpit.ts's `backlog` getter. This store getter is not read by any
  // view today, but an unused wrong rule is still a trap for whoever wires
  // it up next.
  it('backlog excludes covered brokered loads (assigned/in_progress/delivered, no assignment) but keeps open/tendered', async () => {
    const brokeredPayload = {
      lanes: [],
      loads: [
        { id: 'open1', reference: 'L-OPEN', status: 'open', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1000, stopCount: 2, origin: 'A', destination: 'B', assignment: null },
        { id: 'tendered1', reference: 'L-TENDERED', status: 'tendered', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1000, stopCount: 2, origin: 'A', destination: 'B', assignment: null },
        { id: 'brokered-assigned', reference: 'L-BA', status: 'assigned', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1000, stopCount: 2, origin: 'A', destination: 'B', assignment: null, carrierId: 'c1' },
        { id: 'brokered-progress', reference: 'L-BP', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1000, stopCount: 2, origin: 'A', destination: 'B', assignment: null, carrierId: 'c1' },
        { id: 'brokered-delivered', reference: 'L-BD', status: 'delivered', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1000, stopCount: 2, origin: 'A', destination: 'B', assignment: null, carrierId: 'c1' },
      ],
    }
    mockedGet.mockResolvedValue({ data: brokeredPayload })
    const store = useLoadboardStore()
    await store.load()
    expect(store.backlog.map((l) => l.id).sort()).toEqual(['open1', 'tendered1'])
  })

  it('loadRisk() stores the feed; riskByLoadId keeps the worst severity per load', async () => {
    const risk = (over: Record<string, unknown>) => ({
      assignmentId: 'a1', loadId: 'l2', ref: 'L-2', driverId: 'd1', driverName: 'Jake',
      kind: 'late_start', severity: 'warn', detail: 'tight', deadline: '2026-08-21T14:00:00.000Z',
      projectedArrival: '2026-08-21T13:30:00.000Z', slackMin: 30, ...over,
    })
    mockedGet.mockResolvedValue({ data: { risks: [risk({}), risk({ assignmentId: 'a2', severity: 'block' })] } })
    const store = useLoadboardStore()
    await store.loadRisk()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/risk')
    expect(store.risks).toHaveLength(2)
    expect(store.riskByLoadId).toEqual({ l2: 'block' })
  })

  it('riskByDriverId keeps the worst severity per driver, independent of loadId', async () => {
    const risk = (over: Record<string, unknown>) => ({
      assignmentId: 'a1', loadId: 'l2', ref: 'L-2', driverId: 'd1', driverName: 'Jake',
      kind: 'late_start', severity: 'warn', detail: 'tight', deadline: '2026-08-21T14:00:00.000Z',
      projectedArrival: '2026-08-21T13:30:00.000Z', slackMin: 30, ...over,
    })
    mockedGet.mockResolvedValue({
      data: { risks: [risk({}), risk({ assignmentId: 'a2', loadId: 'l9', severity: 'block' })] },
    })
    const store = useLoadboardStore()
    await store.loadRisk()
    expect(store.riskByDriverId).toEqual({ d1: 'block' })
  })

  it('shiftWindow() moves both edges and reloads with the shifted range', async () => {
    mockedGet.mockResolvedValue({ data: boardPayload })
    const store = useLoadboardStore()
    const fromBefore = store.fromDate.getTime()
    await store.shiftWindow(1)
    expect(store.fromDate.getTime()).toBe(fromBefore + 86400000)
    expect(store.toDate.getTime() - store.fromDate.getTime()).toBe(0) // span preserved (1 day)
    const params = mockedGet.mock.calls[0][1] as { params: { from: string; to: string } }
    expect(params.params.from).toBe(store.fromDate.toISOString())
  })

  it('setSpan(3) widens the window anchored at fromDate; goToToday keeps the span', async () => {
    mockedGet.mockResolvedValue({ data: boardPayload })
    const store = useLoadboardStore()
    await store.setSpan(3)
    expect(store.toDate.getTime() - store.fromDate.getTime()).toBe(2 * 86400000)

    await store.shiftWindow(-3)
    await store.goToToday()
    // back on today's midnight, still a 3-day span
    const now = new Date()
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    expect(store.fromDate.getTime()).toBe(todayUtc)
    expect(store.toDate.getTime() - store.fromDate.getTime()).toBe(2 * 86400000)
  })

  it('suggestFor() stores the ranked result and returns it', async () => {
    const suggest = {
      loadId: 'l1', requiredEquip: 'Reefer', tractorId: 't1', trailerId: 'tr1',
      candidates: [{ driverId: 'd1', driverName: 'Jake', feasible: true, score: 88, deadheadMi: 12, loadedMi: 190, etaMs: 1, marginCents: 9900, marginPct: 0.19, warnings: [] }],
    }
    mockedGet.mockResolvedValue({ data: suggest })
    const store = useLoadboardStore()
    const out = await store.suggestFor('l1')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/suggest', { params: { loadId: 'l1' } })
    expect(out?.candidates).toHaveLength(1)
    expect(store.suggest?.tractorId).toBe('t1')
  })

  it('preview() posts with dryRun:true and returns the verdict', async () => {
    const preview = {
      feasible: false,
      conflicts: [{ kind: 'equipment', severity: 'block', detail: 'wrong trailer' }],
      plan: { proposedStart: 0, proposedEnd: 1, deadheadMi: 10, loadedMi: 100, driveMin: 120, onDutyMin: 240, needsBreak: false },
      economics: { revenueCents: 52000, totalMi: 110, deadheadMi: 10, loadedMi: 100, estCostCents: 40000, marginCents: 12000, marginPct: 0.23, ratePerLoadedMiCents: 520, ratePerTotalMiCents: 470 },
    }
    mockedPost.mockResolvedValue({ data: preview })
    const store = useLoadboardStore()
    const payload = { loadId: 'l1', driverId: 'd1', tractorId: 't1', trailerId: 'tr1' }
    const out = await store.preview(payload)
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/assignments', { ...payload, dryRun: true })
    expect(out?.feasible).toBe(false)
  })

  it('assign() posts the commit and refreshes the board on success', async () => {
    mockedPost.mockResolvedValue({ data: { assignment: { id: 'a1' } } })
    mockedGet.mockResolvedValue({ data: boardPayload })
    const store = useLoadboardStore()
    const ok = await store.assign({ loadId: 'l1', driverId: 'd1', tractorId: 't1', trailerId: 'tr1', force: false })
    expect(ok).toBe(true)
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/assignments', expect.objectContaining({ loadId: 'l1' }))
    expect(mockedGet).toHaveBeenCalled() // board refresh
  })

  it('assign() surfaces the API error and returns false on failure', async () => {
    mockedPost.mockRejectedValue({ response: { data: { error: 'Load is already assigned' } } })
    const store = useLoadboardStore()
    const ok = await store.assign({ loadId: 'l1', driverId: 'd1', tractorId: 't1', trailerId: 'tr1' })
    expect(ok).toBe(false)
    expect(store.error).toBeTruthy()
  })

  it('unassign() deletes the assignment and refreshes board, alerts and kpis', async () => {
    mockedDelete.mockResolvedValue({ data: { ok: true } })
    mockedGet.mockResolvedValue({ data: { lanes: [], loads: [] } })
    const store = useLoadboardStore()
    const ok = await store.unassign('a1')
    expect(ok).toBe(true)
    expect(mockedDelete).toHaveBeenCalledWith('/dispatcher/assignments/a1')
    expect(mockedGet).toHaveBeenCalled()
  })

  it('boardWsUrl converts the API base into a /ws URL with the token', () => {
    expect(boardWsUrl('tok123')).toBe('ws://localhost:3001/ws?token=tok123')
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

    it('connectRealtime subscribes to the shared socket; board_update triggers a refresh', async () => {
      mockedGet.mockResolvedValue({ data: { lanes: [], loads: [] } })
      const store = useLoadboardStore()
      store.connectRealtime()
      store.connectRealtime() // second call must not add a second subscription or socket
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(FakeWebSocket.instances[0].url).toContain('token=tok123')

      const loadSpy = vi.spyOn(store, 'load').mockResolvedValue()
      const alertsSpy = vi.spyOn(store, 'loadAlerts').mockResolvedValue()
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'board_update', loadId: 'l1' }) })
      expect(loadSpy).toHaveBeenCalled()
      expect(alertsSpy).toHaveBeenCalled()

      store.disconnectRealtime()
      expect(FakeWebSocket.instances[0].closed).toBe(true)
      // After a disconnect, subscribing again opens a fresh shared socket.
      store.connectRealtime()
      expect(FakeWebSocket.instances).toHaveLength(2)
      store.disconnectRealtime()
    })

    it('driver_status updates the lane dot in place without a board reload', () => {
      const store = useLoadboardStore()
      store.lanes = [
        { id: 'd1', name: 'Jake', status: 'offline' },
        { id: 'd2', name: 'Maria', status: 'offline' },
      ]
      store.connectRealtime()
      const loadSpy = vi.spyOn(store, 'load').mockResolvedValue()

      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'driver_status', driverId: 'd1', status: 'on_duty' }),
      })

      expect(store.lanes[0].status).toBe('on_duty')
      expect(store.lanes[1].status).toBe('offline')
      expect(loadSpy).not.toHaveBeenCalled()
      store.disconnectRealtime() // leave the singleton's handler map clean for tests outside this describe
    })
  })

  it('load() honours a window override (cockpit tz window) and stores tractors/trailers', async () => {
    mockedGet.mockResolvedValue({ data: { ...boardPayload, tractors: [{ id: 't1', unit: '1207', make: null, cab: 'Sleeper', status: 'active', inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }], trailers: [] } })
    const store = useLoadboardStore()
    store.setWindowOverride({ from: '2026-08-28T05:00:00.000Z', to: '2026-08-31T05:00:00.000Z' })
    await store.load()
    const params = mockedGet.mock.calls[0][1] as { params: { from: string; to: string } }
    expect(params.params).toEqual({ from: '2026-08-28T05:00:00.000Z', to: '2026-08-31T05:00:00.000Z' })
    expect(store.tractors).toHaveLength(1)
    expect(store.trailers).toEqual([])
    store.setWindowOverride(null)
    await store.load()
    const back = mockedGet.mock.calls[1][1] as { params: { from: string } }
    expect(back.params.from).toBe(store.fromDate.toISOString())
  })

})
