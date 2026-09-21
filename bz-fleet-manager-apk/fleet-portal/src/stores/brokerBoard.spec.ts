import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type BoardLoad } from '../lib/api'
import { useBrokerBoardStore } from './brokerBoard'
import { useLoadLocksStore } from './loadLocks'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
  // brokerBoard.ts's connectRealtime reads useLoadLocksStore().holds(...);
  // that store's own actions import these named exports too — undefined
  // here is harmless as long as nothing actually calls hold/release/refresh,
  // which none of this file's tests do, but they are mocked anyway (same as
  // cockpit.spec.ts does for the same cross-store read) so a future test
  // that DOES touch them fails on its own assertion, not a TypeError.
  acquireLoadLock: vi.fn(),
  heartbeatLoadLock: vi.fn(),
  releaseLoadLock: vi.fn(),
  fetchLoadLocks: vi.fn(),
}))
vi.mock('../lib/download', () => ({ triggerDownload: vi.fn(), triggerBlobDownload: vi.fn() }))
// A4 Task 7: the shared socket, mocked the same way loadLocks.spec.ts and
// cockpit.spec.ts do — a map of frame type -> the one handler each type gets.
const realtimeHandlers = new Map<string, (f: { type: string } & Record<string, unknown>) => void>()
vi.mock('../lib/realtime', () => ({
  OPEN: '$open',
  subscribe: vi.fn((type: string, h: (f: { type: string } & Record<string, unknown>) => void) => {
    realtimeHandlers.set(type, h)
    return () => realtimeHandlers.delete(type)
  }),
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPatch = vi.mocked(api.patch)

const board = {
  layout: [{ key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'agent', label: 'AGENT' }],
  loads: [{ id: 'l1', line: 1, top: { bol: '0500001', customer: 'ACME FOODS' }, bottom: { customer: 'BLUE ROAD LLC' }, pill: { state: 'none', text: null }, agentLine: null }],
}

describe('brokerBoard store', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('loads the layout and the row pairs', async () => {
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    await s.load()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/broker-board')
    expect(s.layout).toHaveLength(3)
    expect(s.loads[0].bottom?.customer).toBe('BLUE ROAD LLC')
    expect(s.error).toBeNull()
  })

  it('keeps the server error message when the board cannot load', async () => {
    mockedGet.mockRejectedValueOnce({ response: { data: { error: 'The broker board requires an org-scoped dispatcher account' } } })
    const s = useBrokerBoardStore()
    await s.load()
    expect(s.error).toMatch(/org-scoped/)
  })

  it('previews and confirms a workbook as multipart, then reloads', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview: { layout: board.layout, loads: [], notes: [], unmatched: [], missing: [] } } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 5, updated: 0, attention: 1, notes: [] } })
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    const file = new File([new Uint8Array([1, 2, 3])], 'board.xlsx')
    const p = await s.preview(file)
    expect(p?.layout).toHaveLength(3)
    expect(mockedPost.mock.calls[0][0]).toBe('/dispatcher/broker-board/import')
    expect(mockedPost.mock.calls[0][1]).toBeInstanceOf(FormData)
    const r = await s.confirm(file)
    expect(r?.created).toBe(5)
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })

  it('archives, deletes and exports a selection through the org endpoints, then reloads and clears', async () => {
    mockedPost.mockResolvedValueOnce({ data: { updated: 2 } })
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    s.selectedIds = ['l1', 'l2']
    await s.archive(['l1', 'l2'], true)
    expect(mockedPost).toHaveBeenLastCalledWith('/dispatcher/broker-board/loads/archive', { ids: ['l1', 'l2'], archived: true })
    expect(s.selectedIds).toEqual([])
    expect(s.notice).toMatch(/2 loads archived/)
    mockedPost.mockResolvedValueOnce({ data: { deleted: 1 } })
    mockedGet.mockResolvedValueOnce({ data: board })
    await s.remove(['l1'])
    expect(mockedPost).toHaveBeenLastCalledWith('/dispatcher/broker-board/loads/delete', { ids: ['l1'] })
    mockedPost.mockResolvedValueOnce({ data: new Blob(['x']) })
    await s.exportSelected(['l1'])
    expect(mockedPost.mock.calls.at(-1)?.[0]).toBe('/dispatcher/broker-board/export')
    expect(mockedPost.mock.calls.at(-1)?.[2]).toMatchObject({ responseType: 'blob' })
  })

  it('keeps the server\'s refusal verbatim so the dispatcher sees which loads blocked it', async () => {
    mockedPost.mockRejectedValueOnce({ response: { status: 409, data: { error: "These loads can't be deleted while assigned or in progress: 145205" } } })
    const s = useBrokerBoardStore()
    await s.remove(['l1'])
    expect(s.error).toMatch(/145205/)
  })

  // Final review finding 6 (IMPORTANT) + NIT 12: `exportSelected` sets
  // responseType 'blob', so axios hands a refusal's body back as a Blob and
  // the duck-typed `.error` read found nothing — the dispatcher saw "Request
  // failed with status code 404" instead of the server's own sentence (spec
  // §10 wants it verbatim). A stale green notice must not sit next to it.
  it("decodes a blob refusal so the server's own words reach the dispatcher, and clears a stale notice", async () => {
    const s = useBrokerBoardStore()
    s.notice = '3 loads archived'
    mockedPost.mockRejectedValueOnce({ response: { status: 404, data: new Blob([JSON.stringify({ error: 'One or more loads were not found' })]) } })
    await s.exportSelected(['l1', 'gone'])
    expect(s.error).toMatch(/not found/)
    expect(s.notice).toBeNull()
  })

  it('falls back to a plain sentence when an export failure carries no readable body', async () => {
    const s = useBrokerBoardStore()
    mockedPost.mockRejectedValueOnce({ response: { status: 500, data: new Blob(['<html>gateway</html>']) } })
    await s.exportSelected(['l1'])
    expect(s.error).toBe('Could not export')
  })

  // B2: the server has always answered a cell with `statusRefused` (spec
  // §6.3) and the board never read it — a dispatcher who typed DELIVERED on a
  // load one of our own drivers runs saw the cell save and the status not
  // move, with no word about why.
  it('keeps the record\'s refusal from a cell save, and clears it on the next write', async () => {
    const s = useBrokerBoardStore()
    s.loads = board.loads as never
    mockedPatch.mockResolvedValueOnce({ data: { load: board.loads[0], version: 3, statusRefused: 'record says assigned — advance the trip in the Cockpit' } })
    expect(await s.editCell('l1', { row: 'top', key: 'update', value: 'DELIVERED', baseVersion: 2 })).toBe(true)
    expect(mockedPatch).toHaveBeenLastCalledWith('/dispatcher/broker-board/loads/l1/cell', { row: 'top', key: 'update', value: 'DELIVERED', baseVersion: 2 })
    expect(s.lastRefusal).toBe('record says assigned — advance the trip in the Cockpit')
    expect(s.error).toBeNull()

    mockedPatch.mockResolvedValueOnce({ data: { load: board.loads[0], version: 4, statusRefused: null } })
    await s.editCell('l1', { row: 'top', key: 'customer', value: 'ACME', baseVersion: 3 })
    expect(s.lastRefusal).toBeNull()
  })

  it('keeps the first refusal of a paste', async () => {
    const s = useBrokerBoardStore()
    s.loads = board.loads as never
    mockedPost.mockResolvedValueOnce({ data: { loads: board.loads, refusals: [{ loadId: 'l1', sentence: 'record says archived — unarchive it on the board first' }] } })
    await s.pasteCells([{ loadId: 'l1', row: 'top', key: 'update', value: 'DELIVERED', baseVersion: 0 }])
    expect(s.lastRefusal).toMatch(/unarchive it on the board first/)

    mockedPost.mockResolvedValueOnce({ data: { loads: board.loads, refusals: [] } })
    await s.pasteCells([{ loadId: 'l1', row: 'top', key: 'customer', value: 'ACME', baseVersion: 0 }])
    expect(s.lastRefusal).toBeNull()
  })

  it('asks for archived loads when the toggle is on', async () => {
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    s.showArchived = true
    await s.load()
    expect(mockedGet).toHaveBeenLastCalledWith('/dispatcher/broker-board?archived=1')
  })
})

describe('the version backstop in the store', () => {
  it('turns STALE_VERSION into a conflict, re-bases on keep mine, and swaps the row on take theirs', async () => {
    const fresh = { id: 'a', version: 4, top: { customer: 'THEIRS' } } as unknown as BoardLoad
    vi.mocked(api.patch).mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 4, theirs: 'THEIRS', load: fresh } } })
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 3, top: { customer: 'OLD' } } as unknown as BoardLoad]
    expect(await s.editCell('a', { row: 'top', key: 'customer', value: 'MINE', baseVersion: 3 })).toBe(false)
    expect(s.conflictFor('a')).toMatchObject({ loadId: 'a', current: 4, theirs: 'THEIRS' })
    expect(s.error).toBeNull()
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { load: { ...fresh, version: 5, top: { customer: 'MINE' } }, version: 5, statusRefused: null } })
    expect(await s.resolveConflict('a', 'mine')).toBe(true)
    expect(vi.mocked(api.patch).mock.calls.at(-1)?.[1]).toMatchObject({ value: 'MINE', baseVersion: 4 })
    expect(s.conflictFor('a')).toBeNull()
    vi.mocked(api.patch).mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 6, theirs: 'NEWER', load: { ...fresh, version: 6 } } } })
    await s.editCell('a', { row: 'top', key: 'customer', value: 'X', baseVersion: 5 })
    expect(await s.resolveConflict('a', 'theirs')).toBe(true)
    expect(s.loads[0].version).toBe(6)
  })

  // Carried finding, A2 ruling R14: a single `conflict` slot let the second
  // save in flight get blamed for the first one's collision. Two loads
  // colliding at once must stay two separate conflicts.
  it('keeps two conflicts apart instead of blaming the last save', async () => {
    const s = useBrokerBoardStore()
    s.loads = [
      { id: 'a', version: 3, top: {} } as unknown as BoardLoad,
      { id: 'b', version: 8, top: {} } as unknown as BoardLoad,
    ]
    vi.mocked(api.patch)
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 4, theirs: 'MEIBORG', load: { id: 'a', version: 4 } } } })
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 9, theirs: 'ACME', load: { id: 'b', version: 9 } } } })
    const writeA = { row: 'top' as const, key: 'customer' as const, value: 'MINE-A', baseVersion: 3 }
    const writeB = { row: 'top' as const, key: 'customer' as const, value: 'MINE-B', baseVersion: 8 }
    await Promise.all([s.editCell('a', writeA), s.editCell('b', writeB)])
    expect(s.conflictFor('a')!.current).toBe(4)
    expect(s.conflictFor('b')!.current).toBe(9)
    await s.resolveConflict('a', 'theirs')
    expect(s.conflictFor('a')).toBeNull()
    expect(s.conflictFor('b')!.theirs).toBe('ACME') // resolving one leaves the other standing
  })

  it('reports a held load by name, for a cell and for a paste', async () => {
    vi.mocked(api.patch).mockRejectedValueOnce({ response: { status: 409, data: { error: 'LOAD_LOCKED', message: 'Maria is editing this load', lock: { by: 'Maria' } } } })
    const s = useBrokerBoardStore()
    expect(await s.editCell('a', { row: 'top', key: 'customer', value: 'X', baseVersion: 0 })).toBe(false)
    expect(s.error).toBe('Maria is editing this load')
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { error: 'LOAD_LOCKED', message: 'Maria is editing 0563272 — try again when the badge clears', holders: [] } } })
    expect(await s.pasteCells([{ loadId: 'a', row: 'top', key: 'customer', value: 'X', baseVersion: 0 }])).toBe(false)
    expect(s.error).toBe('Maria is editing 0563272 — try again when the badge clears')
  })
})

// A4 Task 7: the board listens. Frames arrive through the same mocked
// `subscribe` as loadLocks.spec.ts/cockpit.spec.ts use — `realtimeHandlers`
// captures the one handler each frame type registers.
describe('connectRealtime', () => {
  const COALESCE_MS = 50
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    realtimeHandlers.clear()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('swaps in a row another dispatcher changed, and drops one that left the board', async () => {
    const s = useBrokerBoardStore()
    s.loads = [
      { id: 'a', version: 5, top: {} } as unknown as BoardLoad,
      // C1: the delete route emits the load's PRE-delete version — exactly
      // what an up-to-date client already has. Fixture version equal to the
      // frame's version is what the real server actually sends; a fixture
      // with a lower version (the old shape here) let the echo guard's
      // branch go unreached and masked the bug for nine reviews.
      { id: 'b', version: 3, top: {} } as unknown as BoardLoad,
    ]
    s.connectRealtime()
    mockedGet.mockResolvedValueOnce({ data: { layout: board.layout, loads: [{ id: 'a', version: 6, top: { rate: '$2,450.00' } }] } })
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'a', version: 6, fields: ['rate'] })
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'b', version: 3, fields: ['deleted'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await vi.waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(mockedGet.mock.calls.at(-1)?.[1]).toMatchObject({ params: { ids: 'a,b' } })
    expect(s.loads.map((l) => l.id)).toEqual(['a'])
    expect(s.loads[0].top.rate).toBe('$2,450.00')
  })

  // Fix round 1, Finding 2 (LOW): patchRows's `added` branch (a load created
  // elsewhere) had no test.
  it('appends a load the board did not know about yet, and leaves the existing one untouched', async () => {
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 1, top: { customer: 'ACME' } } as unknown as BoardLoad]
    s.connectRealtime()
    mockedGet.mockResolvedValueOnce({ data: { layout: board.layout, loads: [{ id: 'z', version: 1, top: { customer: 'NEW LOAD' } }] } })
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'z', version: 1, fields: ['created'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await vi.waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(s.loads.map((l) => l.id)).toEqual(['a', 'z'])
    expect(s.loads[0]).toMatchObject({ id: 'a', version: 1, top: { customer: 'ACME' } }) // unchanged
    expect(s.loads[1]).toMatchObject({ id: 'z', version: 1, top: { customer: 'NEW LOAD' } }) // appended
  })

  // L10: a colleague's new row belongs at its `boardLine` position, not at
  // the bottom of the board until the next full read.
  it('inserts a newly created load at its boardLine position, not last', async () => {
    const s = useBrokerBoardStore()
    s.loads = [
      { id: 'a', version: 1, boardLine: 1, top: {} } as unknown as BoardLoad,
      { id: 'c', version: 1, boardLine: 3, top: {} } as unknown as BoardLoad,
    ]
    s.connectRealtime()
    mockedGet.mockResolvedValueOnce({ data: { layout: board.layout, loads: [{ id: 'b', version: 1, boardLine: 2, top: { customer: 'NEW LOAD' } }] } })
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'b', version: 1, fields: ['created'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await vi.waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(s.loads.map((l) => l.id)).toEqual(['a', 'b', 'c']) // landed between its neighbors, not appended after both
  })

  it('ignores a frame at or behind the version already on screen (our own write landing)', async () => {
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 6, top: {} } as unknown as BoardLoad]
    s.connectRealtime()
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'a', version: 6, fields: ['rate'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await Promise.resolve()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('re-reads the whole board on a reconnect — a gap has no id list to patch', async () => {
    mockedGet.mockResolvedValueOnce({ data: board })
    const s = useBrokerBoardStore()
    s.connectRealtime()
    realtimeHandlers.get('$open')!({ type: '$open' })
    await vi.waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/dispatcher/broker-board'))
  })

  // The rule the brief calls the one behaviour a dispatcher will never
  // forgive: a frame for a load this tab is editing or saving must not
  // clobber it. loadLocks.held tracks that window.
  it('does not clobber a row this tab is editing or saving, and catches it up once the edit settles', async () => {
    const locks = useLoadLocksStore()
    locks.held = { a: { heartbeatId: 0 } }
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 5, top: {} } as unknown as BoardLoad]
    s.connectRealtime()
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'a', version: 6, fields: ['rate'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await Promise.resolve()
    expect(mockedGet).not.toHaveBeenCalled()

    // The editor closes and the lock is free — settleLoad re-requests the row.
    locks.held = {}
    mockedGet.mockResolvedValueOnce({ data: { layout: board.layout, loads: [{ id: 'a', version: 6, top: { rate: '$2,450.00' } }] } })
    s.settleLoad('a')
    vi.advanceTimersByTime(COALESCE_MS)
    await vi.waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(s.loads[0].version).toBe(6)
  })

  // M4: the server sends `load_changed` before its own HTTP response, so for
  // the dispatcher's OWN edit the frame usually arrives while the lock is
  // still held and gets deferred — but `editCell`'s response already puts
  // that exact version on screen via `replaceLoads`. settleLoad must not
  // re-request a row the save itself already delivered.
  it('settling an edit the frame already caught up to fires no redundant GET', async () => {
    const locks = useLoadLocksStore()
    locks.held = { a: { heartbeatId: 0 } }
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 5, top: {} } as unknown as BoardLoad]
    s.connectRealtime()
    // The server's echo of the dispatcher's own write, arriving mid-save.
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'a', version: 6, fields: ['rate'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await Promise.resolve()
    expect(mockedGet).not.toHaveBeenCalled() // deferred, not dropped and not yet re-requested

    // The save's own response lands (editCell -> replaceLoads), independent
    // of the socket, putting version 6 on screen before the lock is released.
    s.loads = [{ id: 'a', version: 6, top: { rate: '$2,450.00' } } as unknown as BoardLoad]
    locks.held = {}
    s.settleLoad('a')
    vi.advanceTimersByTime(COALESCE_MS)
    await Promise.resolve()
    expect(mockedGet).not.toHaveBeenCalled() // no redundant GET: the row is already at the deferred version
  })

  // Second half of the same finding: a deferred frame that is GENUINELY
  // ahead of what's on screen (not our own write's echo) must still cost a
  // request once the load is free — M4 must not swallow real news.
  it('settling a load that is still behind a genuinely newer deferred frame still re-requests it', async () => {
    const locks = useLoadLocksStore()
    locks.held = { a: { heartbeatId: 0 } }
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 5, top: {} } as unknown as BoardLoad]
    s.connectRealtime()
    // A colleague's own change lands on the wire — genuinely newer news, not
    // this tab's own write settling.
    realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'a', version: 7, fields: ['rate'] })
    vi.advanceTimersByTime(COALESCE_MS)
    await Promise.resolve()
    expect(mockedGet).not.toHaveBeenCalled() // still held; deferred

    // The lock frees, but nothing updated the row in the meantime — it is
    // still behind the deferred frame's version.
    locks.held = {}
    mockedGet.mockResolvedValueOnce({ data: { layout: board.layout, loads: [{ id: 'a', version: 7, top: { rate: '$2,600.00' } }] } })
    s.settleLoad('a')
    vi.advanceTimersByTime(COALESCE_MS)
    await vi.waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(s.loads[0].version).toBe(7)
  })

  it('settleLoad is a no-op when nothing was held back for that load', async () => {
    const s = useBrokerBoardStore()
    s.loads = [{ id: 'a', version: 5, top: {} } as unknown as BoardLoad]
    s.connectRealtime()
    s.settleLoad('a')
    vi.advanceTimersByTime(COALESCE_MS)
    await Promise.resolve()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('a second connectRealtime call does not double-subscribe', async () => {
    const { subscribe } = await import('../lib/realtime')
    const s = useBrokerBoardStore()
    s.connectRealtime()
    const callsAfterFirst = vi.mocked(subscribe).mock.calls.length
    s.connectRealtime()
    expect(vi.mocked(subscribe).mock.calls.length).toBe(callsAfterFirst)
  })
})
