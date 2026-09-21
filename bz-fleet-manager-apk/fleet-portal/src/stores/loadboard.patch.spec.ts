import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useLoadboardStore, type BoardLoad } from './loadboard'

// Plan A4, Task 6: the store's own coalescing subscriber (connectRealtime's
// `load_changed`/`$open` handlers) is exercised through the shared socket,
// mocked the same way loadLocks.spec.ts / cockpit.spec.ts mock it — a map of
// frame type -> the one handler each type gets, since this store never
// subscribes to the same type twice.
const handlers = new Map<string, (f: { type: string } & Record<string, unknown>) => void>()
vi.mock('../lib/realtime', () => ({
  subscribe: vi.fn((type: string, h: (f: { type: string } & Record<string, unknown>) => void) => {
    handlers.set(type, h)
    return () => handlers.delete(type)
  }),
  OPEN: '$open',
}))

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedGet = vi.mocked(api.get)

// Mirrors loadboard.ts's own (unexported) COALESCE_MS — the coalescing
// window a burst of `load_changed` frames is collapsed into one request
// across.
const COALESCE_MS = 50

const emit = (frame: { type: string } & Record<string, unknown>): void => {
  handlers.get(frame.type)?.(frame)
}
/** Advance exactly past the coalescing window and let its `patchLoads` call
 *  (and anything it immediately awaits) settle. */
const flushCoalesce = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(COALESCE_MS)
}

const loadA: BoardLoad = {
  id: 'a', reference: 'L-A', status: 'open', requiredEquip: 'DryVan', hazmatClass: null,
  revenueCents: 1000, stopCount: 1, origin: 'Kansas City', destination: 'Omaha', assignment: null, version: 3,
}
const loadB: BoardLoad = {
  id: 'b', reference: 'L-B', status: 'open', requiredEquip: 'Reefer', hazmatClass: null,
  revenueCents: 2000, stopCount: 1, origin: 'Memphis', destination: 'Tulsa', assignment: null, version: 1,
}

describe('loadboard store: patch path (Plan A4, Task 6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handlers.clear()
    mockedGet.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-reads only the changed load, and only once for a burst', async () => {
    const store = useLoadboardStore()
    store.loads = [loadA, loadB]
    store.connectRealtime()
    mockedGet.mockResolvedValue({ data: { loads: [] } })

    emit({ type: 'load_changed', loadId: 'a', version: 4, fields: ['status'] })
    emit({ type: 'load_changed', loadId: 'a', version: 5, fields: ['rate'] })
    emit({ type: 'load_changed', loadId: 'c', version: 1, fields: ['created'] })
    await flushCoalesce()

    const calls = mockedGet.mock.calls.filter(([url]) => url === '/dispatcher/loadboard')
    expect(calls).toHaveLength(1) // one request for the whole burst
    expect((calls[0][1] as { params: { ids: string } }).params.ids).toBe('a,c') // both ids, each once
    expect(mockedGet).not.toHaveBeenCalledWith('/dispatcher/alerts', expect.anything())

    store.disconnectRealtime()
  })

  it('merges a newly created load into the board, leaving the existing one untouched', async () => {
    const store = useLoadboardStore()
    store.loads = [loadA]
    store.connectRealtime()
    const created: BoardLoad = {
      id: 'c', reference: 'L-C', status: 'open', requiredEquip: 'DryVan', hazmatClass: null,
      revenueCents: 500, stopCount: 1, origin: 'Dallas', destination: 'Austin', assignment: null, version: 1,
    }
    mockedGet.mockResolvedValue({ data: { loads: [created] } })

    emit({ type: 'load_changed', loadId: 'c', version: 1, fields: ['created'] })
    await flushCoalesce()

    expect(store.loads.map((l) => l.id).sort()).toEqual(['a', 'c'])
    expect(store.loads.find((l) => l.id === 'a')).toEqual(loadA) // untouched
    expect(store.loads.find((l) => l.id === 'c')).toEqual(created) // added

    store.disconnectRealtime()
  })

  // L10: dispatcherLoadboard.ts orders its GET by `createdAt asc`, but that
  // field never reaches the wire, so a brand new row has nothing to sort by
  // on its own. When the same coalesced burst also touches an id already on
  // the board, that id anchors the new row's position — the patch response
  // itself is still `createdAt`-ordered for exactly the ids it was asked
  // for, so "right after this known neighbor" is real information, not a
  // guess. Without the fix, `c` would land after `d` at the very end.
  it('inserts a newly created load next to the known neighbor its own patch response places it by, not last', async () => {
    const store = useLoadboardStore()
    const loadD: BoardLoad = { ...loadB, id: 'd', reference: 'L-D' }
    store.loads = [loadA, loadB, loadD]
    store.connectRealtime()
    const created: BoardLoad = {
      id: 'c', reference: 'L-C', status: 'open', requiredEquip: 'DryVan', hazmatClass: null,
      revenueCents: 500, stopCount: 1, origin: 'Dallas', destination: 'Austin', assignment: null, version: 1,
    }
    // The server's true (createdAt) order for this burst: b, then c — c was
    // created right after b, well before d, which isn't part of this patch.
    mockedGet.mockResolvedValueOnce({ data: { loads: [{ ...loadB, version: 2 }, created] } })

    emit({ type: 'load_changed', loadId: 'b', version: 2, fields: ['status'] })
    emit({ type: 'load_changed', loadId: 'c', version: 1, fields: ['created'] })
    await flushCoalesce()

    expect(store.loads.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']) // c landed next to its anchor b, not after d

    store.disconnectRealtime()
  })

  it('drops a load the server no longer returns', async () => {
    const store = useLoadboardStore()
    store.loads = [loadA, loadB]
    mockedGet.mockResolvedValueOnce({ data: { loads: [] } })

    await store.patchLoads(['a'])

    expect(store.loads.map((l) => l.id)).toEqual(['b']) // absence means removal
  })

  it('falls back to a full reload when the patch request fails, and surfaces the error', async () => {
    const store = useLoadboardStore()
    store.loads = [loadA, loadB]
    const loadSpy = vi.spyOn(store, 'load').mockResolvedValue()
    mockedGet.mockRejectedValueOnce({ response: { data: { error: 'Network blip' } } })

    await store.patchLoads(['a'])

    expect(loadSpy).toHaveBeenCalled() // the fallback this path replaced
    expect(store.error).toBeTruthy() // surfaced the same way every other action here does
  })

  it('ignores a frame for a version it has already rendered, but not a genuinely newer one', async () => {
    const store = useLoadboardStore()
    store.loads = [{ ...loadA, version: 7 }]
    store.connectRealtime()

    // The echo: our own write already rendered version 7, so this frame is
    // stale information and must not cost a request.
    emit({ type: 'load_changed', loadId: 'a', version: 7, fields: ['rate'] })
    await flushCoalesce()
    expect(mockedGet).not.toHaveBeenCalled() // our own echo

    // Proves the guard above is actually discriminating on version, not that
    // `load_changed` silently has no subscriber at all: a REAL change (a
    // higher version) on the same load must still fire a request.
    mockedGet.mockResolvedValue({ data: { loads: [] } })
    emit({ type: 'load_changed', loadId: 'a', version: 8, fields: ['rate'] })
    await flushCoalesce()
    const calls = mockedGet.mock.calls.filter(([url]) => url === '/dispatcher/loadboard')
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as { params: { ids: string } }).params.ids).toBe('a')

    store.disconnectRealtime()
  })

  // C1 (CRITICAL): the delete route emits `load_changed` with the load's
  // PRE-delete version — exactly what an up-to-date client already has, since
  // a deleted row has no newer version to send. A fixture whose known version
  // is BELOW the frame's version never reaches the echo guard's `>=` branch,
  // which is exactly the shape that let this bug through nine reviews on the
  // brokerBoard.ts sibling — so this fixture's version matches the frame's,
  // the real server shape, on purpose. Without the fix the echo guard treats
  // this as an already-rendered frame and never re-requests — no id list
  // means loadA stays on the board forever, deleted or not.
  it('never drops a deletion frame, even though its version equals what is already on screen', async () => {
    const store = useLoadboardStore()
    store.loads = [{ ...loadA, version: 4 }, loadB]
    store.connectRealtime()
    mockedGet.mockResolvedValue({ data: { loads: [] } }) // the server no longer returns a deleted row

    emit({ type: 'load_changed', loadId: 'a', version: 4, fields: ['deleted'] })
    await flushCoalesce()

    const calls = mockedGet.mock.calls.filter(([url]) => url === '/dispatcher/loadboard')
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as { params: { ids: string } }).params.ids).toBe('a')
    expect(store.loads.map((l) => l.id)).toEqual(['b']) // the deleted row is gone from the board

    store.disconnectRealtime()
  })

  // Not in the brief's failing-test list, but the same Step 3 wires this up
  // (`subscribe(OPEN, ...)`) — a dropped-and-reconnected socket missed frames
  // with no id list to patch, so the only honest recovery is a full re-read.
  it('re-reads the whole board and refreshes derived data after a reconnect', () => {
    const store = useLoadboardStore()
    store.connectRealtime()
    const loadSpy = vi.spyOn(store, 'load').mockResolvedValue()
    const refreshSpy = vi.spyOn(store, 'refreshDerived').mockResolvedValue()

    emit({ type: '$open' })

    expect(loadSpy).toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalled()

    store.disconnectRealtime()
  })
})
