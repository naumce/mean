import { api } from '../../lib/api'

// Task 11 (the Connect tab): the thin client for /api/dispatcher/sheet
// (fleet-backend routes/dispatcherSheet.ts, Task 7/9). Portal isolation
// (binding for this task): sheet endpoints live HERE, not in lib/api.ts —
// this module imports the shared axios client but nothing else under
// src/nightshift/ reaches into it directly.

/** Our key -> their header column, verbatim. Mirrors
 *  fleet-backend/src/lib/sheet/mapping.ts `SheetColumnKey` field-for-field —
 *  copied rather than imported (the portal never imports backend code). Keep
 *  this list, `REQUIRED_KEYS` and `SHEET_COLUMN_KEYS` in sync with that file
 *  by hand if the server's key list ever changes. */
export type SheetColumnKey =
  | 'loadRef' | 'driverPhone' | 'driverName' | 'pickup' | 'delivery'
  | 'pickupAppt' | 'deliveryAppt' | 'customerEmail' | 'carrierName'
  | 'carrierPhone' | 'rate' | 'notes'

export const SHEET_COLUMN_KEYS: readonly SheetColumnKey[] = [
  'loadRef', 'driverPhone', 'driverName', 'pickup', 'delivery',
  'pickupAppt', 'deliveryAppt', 'customerEmail', 'carrierName',
  'carrierPhone', 'rate', 'notes',
]

/** Same source as above — fleet-backend/src/lib/sheet/mapping.ts `REQUIRED_KEYS`
 *  (pickupAppt joined in the final fix wave, I7). */
export const REQUIRED_KEYS: readonly SheetColumnKey[] = ['loadRef', 'driverPhone', 'pickup', 'delivery', 'pickupAppt', 'deliveryAppt']

export type SheetMapping = Partial<Record<SheetColumnKey, string>>

/** How many sheet rows make one load (SheetBinding.rowsPerLoad): 2 is the
 *  broker layout — a customer row with the carrier row under it, folded by
 *  the server (lib/sheet/foldPairs.ts); 1 is one row per load. */
export type RowsPerLoad = 1 | 2

/** The one pair of keys allowed to share a header — mirrors mapping.ts
 *  (two-rows-per-load sheets: the broker layout keeps both appointments in
 *  one "APPT SCHEDULE" column). */
export const SHARED_HEADER_PAIR: readonly SheetColumnKey[] = ['pickupAppt', 'deliveryAppt']

export interface SheetMappingProposal {
  mapping: SheetMapping
  extras: string[]
  missing: SheetColumnKey[]
}

export interface SheetTab { id: string; title: string }

/** What GET /dispatcher/sheet/tabs answers for one spreadsheet id: its own
 *  title and its tabs (final fix wave, C1 — there is no account-wide
 *  spreadsheet listing any more; the dispatcher pastes the sheet's link). */
export interface SheetSpreadsheetInfo { title: string; tabs: SheetTab[] }

/** The spreadsheet id out of a pasted Google Sheets link
 *  (`…/spreadsheets/d/<id>/edit#gid=0`), or a bare id typed as-is. Null when
 *  neither shape fits. */
export function spreadsheetIdFromLink(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(text)
  if (fromUrl) return fromUrl[1]
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text
  return null
}

/** Mirrors the server's SAFE_BINDING_SELECT (dispatcherSheet.ts) — the
 *  fields a dispatcher's session is ever allowed to see. Never a
 *  refreshToken; the server never sends one. */
export interface SheetBinding {
  id: string
  spreadsheetId: string
  /** The spreadsheet's own title, recorded by POST /mapping. Null on a
   *  binding made before it was recorded. */
  spreadsheetTitle: string | null
  tabId: string
  tabTitle: string
  headerRow: number
  columns: SheetMapping
  rowsPerLoad: RowsPerLoad
  agentSwitchCol: string | null
  agentStatusCol: string | null
  accountEmail: string
  lastSyncAt: string | null
  lastError: string | null
  status: 'connected' | 'paused' | 'error'
}

/** Mirrors fleet-backend/src/lib/sheet/sync.ts `SyncReport` field-for-field —
 *  what POST /sheet/sync-now answers with. */
export interface SheetSyncReport {
  read: number
  created: number
  updated: number
  unchanged: number
  skipped: { rowIndex: number; reason: string }[]
  statusWrites: number
  error: string | null
}

export async function fetchBinding(): Promise<SheetBinding | null> {
  const { data } = await api.get<{ binding: SheetBinding | null }>('/dispatcher/sheet')
  return data.binding
}

export async function startOAuth(): Promise<string> {
  const { data } = await api.get<{ url: string }>('/dispatcher/sheet/oauth/start')
  return data.url
}

export async function fetchTabs(spreadsheetId: string): Promise<SheetSpreadsheetInfo> {
  const { data } = await api.get<SheetSpreadsheetInfo>('/dispatcher/sheet/tabs', { params: { spreadsheetId } })
  return data
}

export interface SheetHeaderResponse {
  header: string[]
  proposal: SheetMappingProposal
  /** 2 when the first rows under the header look like the broker layout
   *  (a carrier row with no cities right under each load), else 1. */
  suggestedRowsPerLoad: RowsPerLoad
}

export async function fetchHeader(spreadsheetId: string, tabId: string, headerRow = 1): Promise<SheetHeaderResponse> {
  const { data } = await api.get<SheetHeaderResponse>('/dispatcher/sheet/header', {
    params: { spreadsheetId, tabId, headerRow },
  })
  return data
}

export interface SaveMappingBody {
  spreadsheetId: string
  tabId: string
  tabTitle: string
  headerRow: number
  mapping: SheetMapping
  rowsPerLoad: RowsPerLoad
}

export async function saveMapping(body: SaveMappingBody): Promise<SheetBinding> {
  const { data } = await api.post<{ binding: SheetBinding }>('/dispatcher/sheet/mapping', body)
  return data.binding
}

export async function install(): Promise<SheetBinding> {
  const { data } = await api.post<{ binding: SheetBinding }>('/dispatcher/sheet/install')
  return data.binding
}

export async function syncNow(): Promise<SheetSyncReport> {
  const { data } = await api.post<{ report: SheetSyncReport }>('/dispatcher/sheet/sync-now')
  return data.report
}

export async function disconnect(): Promise<SheetBinding> {
  const { data } = await api.delete<{ binding: SheetBinding }>('/dispatcher/sheet')
  return data.binding
}
