import { defineStore } from 'pinia'
import { api, type BoardCellPaste, type BoardCellResponse, type BoardCellWrite, type BoardColumn, type BoardLoad, type BoardPasteResponse, type BoardViewState, type BrokerBoard, type BrokerImportResult, type BrokerPreview, type LoadLockedBody, type StaleVersionBody } from '../lib/api'
import { triggerBlobDownload } from '../lib/download'
import { extractApiErrorMessage } from '../lib/errors'
import { OPEN, subscribe, type Frame } from '../lib/realtime'
import { useLoadLocksStore } from './loadLocks'

// A4 Task 7: the version backstop's conflict, keyed by load id. A single
// slot let two saves in flight blame each other (A2 finding R14, parked for
// this task) — `l1`'s conflict and `l2`'s conflict now live side by side and
// resolving one never touches the other.
export type ConflictEntry = { loadId: string; write: BoardCellWrite; current: number; theirs: string; load: BoardLoad }

/** Long enough to swallow a paste's burst, short enough that a single edit
 *  still feels immediate — same value as loadboard.ts's Task 6 coalescing. */
const COALESCE_MS = 50

// L10: the board's own order — dispatcherBrokerBoard.ts's GET orders
// `[{ boardLine: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }]`.
// `createdAt` never reaches the wire (BoardLoad carries no such field), so a
// tie on `boardLine` (including two loads that both never came from a
// sheet) falls back to Array.prototype.sort's stability, which is the
// closest a client without that field can get to the server's own
// tie-break.
function byBoardLine(a: BoardLoad, b: BoardLoad): number {
  return (a.boardLine ?? Infinity) - (b.boardLine ?? Infinity)
}

// Calls go through `api.get`/`api.post` directly (rather than the typed
// fetchBrokerBoard/previewBrokerBoard/confirmBrokerBoard wrappers also
// exported from lib/api) because this store's tests mock '../lib/api' down
// to just `{ api, API_BASE_URL }` — a full vi.mock replaces the module, so
// named exports the factory doesn't list come back undefined. The wrappers
// stay in lib/api as the typed surface other, non-mocked call sites can use.
function workbookForm(file: File): FormData {
  const fd = new FormData()
  fd.append('file', file, file.name)
  return fd
}

// extractApiErrorMessage only reads `.response.data.error` off a real
// AxiosError *instance* (see lib/errors.ts's `instanceof AxiosError` guard).
// This store's own tests (and the fixture the backend team writes 404/403
// bodies against) reject with a plain `{ response: { data: { error } } }`
// object, which fails that instanceof check — so read the duck-typed shape
// first and only fall back to the shared helper for a real Error/AxiosError.
function boardErrorMessage(e: unknown, fallback: string): string {
  const data = (e as { response?: { data?: { error?: unknown } } } | undefined)?.response?.data
  if (data && typeof data.error === 'string' && data.error) return data.error
  return extractApiErrorMessage(e, fallback)
}

// Final review finding 6 (IMPORTANT): the export request sets
// `responseType: 'blob'`, so axios hands a refusal's body back as a Blob —
// `boardErrorMessage`'s duck-typed `.error` read finds nothing on it and the
// dispatcher saw axios's "Request failed with status code 404" instead of the
// server's "One or more loads were not found". Spec §10 wants the refusal
// verbatim, and every other action in this store already honors it. Decode
// the blob first; anything that is not JSON with an `error` falls back to the
// same plain sentence as before.
async function exportErrorMessage(e: unknown): Promise<string> {
  const body = (e as { response?: { data?: unknown } } | undefined)?.response?.data
  if (!(body instanceof Blob)) return boardErrorMessage(e, 'Could not export')
  try {
    const parsed = JSON.parse(await body.text()) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch { /* not JSON (an HTML error page, a truncated body): say something true and generic */ }
  return 'Could not export'
}

// Their board: the org's layout and the loads as row pairs. Read-only in
// slice 1; cell edits arrive in slice 2 and go through this store.
export const useBrokerBoardStore = defineStore('brokerBoard', {
  state: () => ({
    layout: [] as BoardColumn[],
    loads: [] as BoardLoad[],
    loading: false,
    error: null as string | null,
    importing: false,
    importError: null as string | null,
    // Bulk bar (spec 2026-09-08 Task 5): archive/unarchive/delete/export a
    // selection of loads. `notice` is a separate channel from `error` so a
    // success message never lands in the same red banner a refusal uses.
    showArchived: false,
    selectedIds: [] as string[],
    busy: false,
    notice: null as string | null,
    // Slice 2B: the board is editable. `view` is the org's own visual state
    // (fills, unmerged columns); `saving` is true while a cell is in flight,
    // which the status bar shows and nothing blocks on — a dispatcher types
    // the next cell before the last one lands.
    view: { fills: {}, merges: {} } as BoardViewState,
    saving: 0,
    // The record's own sentence when it refused the status a cell asked for
    // (spec §6.3). The cell LANDED — this is not an error, it is the record
    // telling the dispatcher where that move actually happens. Separate from
    // `error` (which means nothing was written) and from `notice` (green,
    // for something that went right); it is cleared by the next write that
    // is not refused.
    lastRefusal: null as string | null,
    // The version backstop (spec §7.4): a write refused because the row moved
    // under it, with both values on hand so the dispatcher can choose without
    // retyping. Keyed by loadId (A4 Task 7) so two saves in flight never share
    // a slot — see `conflictFor` below.
    conflicts: {} as Record<string, ConflictEntry>,
    // A4 Task 7: this board's own ears on the shared socket (lib/realtime.ts).
    // Kept in STATE, not module scope — unlike loadboard.ts's Task 6 sibling,
    // which calls connectRealtime directly from disciplined, self-cleaning
    // tests. This store's view-level tests mount/unmount BrokerBoardView
    // repeatedly without ever calling `disconnectRealtime` in between, so a
    // module-level singleton here would silently stop listening after the
    // first test. Per-store state (the same shape as loadLocks.ts's
    // `unsubscribe`) resets for free with every fresh Pinia instance.
    realtimeUnsubscribe: null as (() => void) | null,
    /** Ids collected from `load_changed` frames since the last flush — a
     *  paste across many cells is many frames; the board owes one request. */
    pendingIds: new Set<string>() as Set<string>,
    coalesceTimer: null as number | null,
    /** Ids a `load_changed` frame named while this tab was actively working
     *  that load (an open editor, a save in flight, or its own conflict panel
     *  — loadLocks.held tracks exactly that window). Applying the frame then
     *  would overwrite a cell the dispatcher is mid-keystroke on, so it is
     *  held here instead and re-queued once BrokerBoardView's settle() says
     *  the load is free (`settleLoad`) — keyed by loadId, each paired with
     *  the frame's own version and whether it was a removal (M4 + C1): the
     *  server sends a frame before its HTTP response, so for the
     *  dispatcher's OWN edit this is usually what got deferred here, and the
     *  save's own response already put that exact version on screen —
     *  re-requesting it again at settle time would be a redundant GET on
     *  every single cell edit. `removed` is never judged by that version
     *  check (same reasoning as the echo guard below): a deleted row has no
     *  newer version to catch up to. */
    deferredIds: new Map<string, { version: number; removed: boolean }>() as Map<string, { version: number; removed: boolean }>,
  }),
  actions: {
    async load() {
      this.loading = true; this.error = null
      try {
        const { data } = await api.get<BrokerBoard>('/dispatcher/broker-board' + (this.showArchived ? '?archived=1' : ''))
        this.layout = data.layout; this.loads = data.loads
      } catch (e) {
        this.error = boardErrorMessage(e, 'Could not load the board')
      } finally { this.loading = false }
    },
    async preview(file: File): Promise<BrokerPreview | null> {
      this.importing = true; this.importError = null
      try {
        const { data } = await api.post<{ preview: BrokerPreview }>('/dispatcher/broker-board/import', workbookForm(file), { headers: { 'Content-Type': 'multipart/form-data' } })
        return data.preview
      }
      catch (e) { this.importError = boardErrorMessage(e, 'Could not read that workbook'); return null }
      finally { this.importing = false }
    },
    async confirm(file: File): Promise<BrokerImportResult | null> {
      this.importing = true; this.importError = null
      try {
        const { data } = await api.post<BrokerImportResult>('/dispatcher/broker-board/import/confirm', workbookForm(file), { headers: { 'Content-Type': 'multipart/form-data' } })
        await this.load()
        return data
      } catch (e) { this.importError = boardErrorMessage(e, 'Could not import that workbook'); return null }
      finally { this.importing = false }
    },
    async archive(ids: string[], archived: boolean) {
      await this.bulk(async () => {
        const { data } = await api.post<{ updated: number }>('/dispatcher/broker-board/loads/archive', { ids, archived })
        return `${data.updated} ${data.updated === 1 ? 'load' : 'loads'} ${archived ? 'archived' : 'unarchived'}`
      })
    },
    async remove(ids: string[]) {
      await this.bulk(async () => {
        const { data } = await api.post<{ deleted: number }>('/dispatcher/broker-board/loads/delete', { ids })
        return `${data.deleted} ${data.deleted === 1 ? 'load' : 'loads'} deleted`
      })
    },
    async exportSelected(ids: string[]) {
      this.busy = true; this.error = null
      try {
        const { data } = await api.post<Blob>('/dispatcher/broker-board/export', { ids }, { responseType: 'blob' })
        triggerBlobDownload(`board-${new Date().toISOString().slice(0, 10)}.xlsx`, data)
        this.notice = `${ids.length} ${ids.length === 1 ? 'load' : 'loads'} exported`
      } catch (e) {
        // NIT 12: clear the green notice too, so a stale "3 loads archived"
        // can't sit next to a red export failure.
        this.notice = null
        this.error = await exportErrorMessage(e)
      }
      finally { this.busy = false }
    },
    /** One cell. The server answers with the load's freshly rendered rows and
     *  they replace the row in place: no reload, so the dispatcher's scroll
     *  position, selection and the cell they are typing in all survive. A
     *  refusal ("PROFIT is RATE minus SOLD RATE") lands in `error` verbatim
     *  and the old row stays exactly as it was. */
    async editCell(loadId: string, write: BoardCellWrite): Promise<boolean> {
      this.saving += 1; this.error = null
      try {
        const { data } = await api.patch<BoardCellResponse>(`/dispatcher/broker-board/loads/${loadId}/cell`, write)
        this.replaceLoads([data.load])
        // Verbatim, or cleared: a refusal that outlived the cell it was about
        // would be a sentence about a load the dispatcher has moved on from.
        this.lastRefusal = data.statusRefused ?? null
        return true
      } catch (e) {
        const body = (e as { response?: { data?: StaleVersionBody | LoadLockedBody } })?.response?.data
        if (body?.error === 'STALE_VERSION' && body.load) {
          // Both values, nothing written (spec §7.4): the panel offers keep
          // mine / take theirs. Keyed by loadId — a second save's conflict
          // must never overwrite the first's (A2 finding R14).
          this.conflicts = { ...this.conflicts, [loadId]: { loadId, write, current: body.current ?? 0, theirs: body.theirs ?? '', load: body.load } }
          return false
        }
        if (body?.error === 'LOAD_LOCKED') { this.error = body.message ?? 'Someone is editing that load'; return false }
        this.error = boardErrorMessage(e, 'That cell could not be saved')
        return false
      } finally { this.saving -= 1 }
    },
    /** keep mine re-sends the same cell on the version that refused it; take
     *  theirs swaps in the fresh row the refusal carried. Either way only
     *  THIS load's conflict is over — a second, unrelated conflict on another
     *  load stands untouched. */
    async resolveConflict(loadId: string, choice: 'mine' | 'theirs'): Promise<boolean> {
      const c = this.conflicts[loadId]
      if (!c) return true
      const { [loadId]: _gone, ...rest } = this.conflicts
      this.conflicts = rest
      if (choice === 'theirs') { this.replaceLoads([c.load]); return true }
      return this.editCell(c.loadId, { ...c.write, baseVersion: c.current })
    },
    conflictFor(loadId: string): ConflictEntry | null { return this.conflicts[loadId] ?? null },
    /** A paste: every cell or none. */
    async pasteCells(cells: BoardCellPaste[]): Promise<boolean> {
      if (cells.length === 0) return true
      this.saving += 1; this.error = null
      try {
        const { data } = await api.post<BoardPasteResponse>('/dispatcher/broker-board/cells', { cells })
        this.replaceLoads(data.loads)
        // One notice, not one per load: the first refusal names the reason,
        // and they are all the same reason on a pasted column of UPDATEs.
        this.lastRefusal = data.refusals?.[0]?.sentence ?? null
        return true
      } catch (e) {
        const body = (e as { response?: { data?: StaleVersionBody | LoadLockedBody } })?.response?.data
        if (body?.error === 'LOAD_LOCKED') { this.error = body.message ?? 'Someone is editing that load'; return false }
        if (body?.error === 'STALE_VERSION') {
          // A paste is all-or-nothing across many loads (spec §7.4); there is
          // no single "current/theirs" pair to offer a keep-mine/take-theirs
          // choice on, so the board is refreshed and the dispatcher retries.
          this.error = 'Some rows changed since you copied them — reload the board and paste again'
          await this.load()
          return false
        }
        this.error = boardErrorMessage(e, 'That paste could not be saved')
        return false
      } finally { this.saving -= 1 }
    },
    async addLoad(): Promise<string | null> {
      this.busy = true; this.error = null
      try {
        const { data } = await api.post<{ load: BoardLoad }>('/dispatcher/broker-board/loads', {})
        this.loads = [...this.loads, data.load]
        return data.load.id
      } catch (e) {
        this.error = boardErrorMessage(e, 'Could not add a load')
        return null
      } finally { this.busy = false }
    },
    async duplicate(ids: string[]) {
      await this.bulk(async () => {
        const { data } = await api.post<{ loads: BoardLoad[] }>('/dispatcher/broker-board/loads/duplicate', { ids })
        return `${data.loads.length} ${data.loads.length === 1 ? 'load' : 'loads'} duplicated`
      })
    },
    async loadView() {
      try {
        const { data } = await api.get<BoardViewState>('/dispatcher/broker-board/view')
        this.view = { fills: data.fills ?? {}, merges: data.merges ?? {} }
      } catch {
        // A board that cannot read its fills is still a board. The colors are
        // the least of what a dispatcher needs at 2am; never blank the grid
        // over them.
        this.view = { fills: {}, merges: {} }
      }
    },
    /** Optimistic: the paint lands instantly and is written behind it. A
     *  refusal restores the previous state, so what they see is what is
     *  stored. */
    async saveView(next: BoardViewState): Promise<boolean> {
      const previous = this.view
      this.view = next
      try {
        await api.put('/dispatcher/broker-board/view', next)
        return true
      } catch (e) {
        this.view = previous
        this.error = boardErrorMessage(e, 'That change could not be saved')
        return false
      }
    },
    /** Swap freshly rendered rows into place, keeping the board's order. */
    replaceLoads(fresh: BoardLoad[]) {
      const byId = new Map(fresh.map((l) => [l.id, l]))
      this.loads = this.loads.map((l) => byId.get(l.id) ?? l)
    },
    // --- A4 Task 7: this board listens ------------------------------------
    //
    // Mirrors loadboard.ts's Task 6 subscription: the same coalescing
    // (pendingIds + COALESCE_MS) and the same echo guard (a row already at or
    // ahead of the frame's version is our own write landing, not news). One
    // addition Task 6 does not need: this board is typed into live, so a
    // frame for a load this tab is currently editing or saving is held back
    // rather than applied — see `deferredIds` above and `settleLoad` below.
    connectRealtime(): void {
      if (this.realtimeUnsubscribe) return
      const offChanged = subscribe('load_changed', (frame: Frame) => {
        const loadId = typeof frame.loadId === 'string' ? frame.loadId : null
        const version = typeof frame.version === 'number' ? frame.version : null
        if (!loadId) return
        // C1 (A4-R13): the delete route emits `load_changed` with the load's
        // PRE-delete version — exactly what an up-to-date client already
        // holds, since a deleted row has no newer version to send. The echo
        // guard just below asks "have I already rendered this state"; for a
        // removal the answer is always no, so a removal is exempt from it —
        // never judged by a version comparison it cannot possibly satisfy
        // honestly.
        const removed = Array.isArray(frame.fields) && frame.fields.includes('deleted')
        const known = this.loads.find((l) => l.id === loadId)
        // Our own write already put this version (or a newer one) on screen.
        if (!removed && known && version !== null && known.version >= version) return
        if (useLoadLocksStore().holds(loadId)) {
          this.deferredIds = new Map(this.deferredIds).set(loadId, { version: version ?? Infinity, removed })
          return
        }
        this.queuePatch(loadId)
      })
      // F7 (lib/realtime.ts): a socket that dropped and came back missed
      // whatever changed while it was down. There is no id list to patch a
      // gap like that — only a full re-read is honest.
      const offOpen = subscribe(OPEN, () => { void this.load() })
      this.realtimeUnsubscribe = () => { offChanged(); offOpen() }
    },
    disconnectRealtime(): void {
      this.realtimeUnsubscribe?.()
      this.realtimeUnsubscribe = null
      if (this.coalesceTimer != null) { window.clearTimeout(this.coalesceTimer); this.coalesceTimer = null }
      this.pendingIds = new Set()
      this.deferredIds = new Map()
    },
    /** Queue one load for the next coalesced patch — the frame handler above
     *  uses this directly; `settleLoad` below uses it once a held-back id is
     *  free to apply. */
    queuePatch(loadId: string): void {
      this.pendingIds = new Set(this.pendingIds).add(loadId)
      if (this.coalesceTimer != null) return
      this.coalesceTimer = window.setTimeout(() => {
        const ids = [...this.pendingIds]
        this.pendingIds = new Set()
        this.coalesceTimer = null
        void this.patchRows(ids)
      }, COALESCE_MS)
    },
    /** BrokerBoardView calls this from `settle()` — the same place that
     *  decides a load's lock can finally be released — for every load, every
     *  time. Almost always a no-op: only a load whose frame was actually
     *  deferred above owes a re-request now that it is free.
     *
     *  M4: the server sends a `load_changed` frame before its own HTTP
     *  response, so for the dispatcher's OWN edit that frame usually arrives
     *  while the lock is still held and lands here — but the save's response
     *  already put that exact version (or newer) on screen, so re-requesting
     *  it now would be a redundant GET on every single cell edit. Only a row
     *  genuinely still behind the deferred frame's version owes one. A
     *  removal is exempt from that check, same as the echo guard in
     *  `connectRealtime` and for the same reason: a deleted row's frame
     *  carries no newer version to catch up to, so a version comparison must
     *  never stand in for "already applied" on it. */
    settleLoad(loadId: string): void {
      const deferred = this.deferredIds.get(loadId)
      if (!deferred) return
      const next = new Map(this.deferredIds)
      next.delete(loadId)
      this.deferredIds = next
      const known = this.loads.find((l) => l.id === loadId)
      if (!deferred.removed && known && typeof known.version === 'number' && known.version >= deferred.version) return
      this.queuePatch(loadId)
    },
    /** Re-read exactly these loads and swap them into `loads` in place. An id
     *  the answer omits left the board — archived or deleted elsewhere — and
     *  is dropped, never treated as unchanged (Task 2's `ids` narrowing). A
     *  fresh id the answer DOES carry (a load created elsewhere) is inserted
     *  by `boardLine` (L10) — the board's own order (spec: boardLine asc,
     *  nulls last, matching dispatcherBrokerBoard.ts's `orderBy`) — rather
     *  than dropped at the end, where it would sit until the next full read. */
    async patchRows(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      try {
        const { data } = await api.get<BrokerBoard>('/dispatcher/broker-board', {
          params: { ids: ids.join(','), ...(this.showArchived ? { archived: 1 } : {}) },
        })
        const fresh = new Map(data.loads.map((l) => [l.id, l]))
        const asked = new Set(ids)
        const kept = this.loads
          .filter((l) => !asked.has(l.id) || fresh.has(l.id))
          .map((l) => fresh.get(l.id) ?? l)
        const added = data.loads.filter((l) => !this.loads.some((existing) => existing.id === l.id))
        this.loads = [...kept, ...added].sort(byBoardLine)
      } catch (e) {
        // A failed patch must not leave the board wrong: fall back to the
        // full read, the behaviour this narrowed path replaced.
        this.error = boardErrorMessage(e, 'Could not refresh the board')
        await this.load()
      }
    },
    // Shared shape for archive/unarchive/delete: post, surface a success
    // notice, drop the selection and reload — but only once `run()` actually
    // succeeds. A refusal (409/404) must leave `selectedIds` untouched so the
    // dispatcher can see exactly which rows the bar still has checked and
    // read the server's verbatim reason in `error` right next to them.
    async bulk(run: () => Promise<string>) {
      this.busy = true; this.error = null; this.notice = null
      try { this.notice = await run(); this.selectedIds = []; await this.load() }
      catch (e) { this.error = boardErrorMessage(e, 'That did not work') }
      finally { this.busy = false }
    },
  },
})
