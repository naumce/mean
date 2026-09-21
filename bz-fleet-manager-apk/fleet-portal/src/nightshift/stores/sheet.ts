import { defineStore } from 'pinia'
import { extractApiErrorMessage } from '../../lib/errors'
import * as sheetApi from '../api/sheetApi'
import { REQUIRED_KEYS, spreadsheetIdFromLink, type SheetBinding, type SheetMapping, type SheetMappingProposal, type SheetSyncReport, type SheetTab } from '../api/sheetApi'

export type { SheetBinding, SheetMapping, SheetMappingProposal, SheetSyncReport, SheetTab }
export { REQUIRED_KEYS, SHEET_COLUMN_KEYS, spreadsheetIdFromLink, type SheetColumnKey } from '../api/sheetApi'

/** Mirrors fleet-backend/src/lib/sheet/mapping.ts `validateMapping`'s two
 *  mapping-shape checks (required present, no header used twice) — the
 *  "does this header exist in the sheet" check is not repeated here because
 *  the picker only ever offers headers pulled from the sheet itself, so a
 *  mapping built through this UI cannot name one that isn't there. Run
 *  before the round trip so the dispatcher sees the same complaint the
 *  server would give, without waiting on it. */
export function validateMappingLocally(mapping: SheetMapping): string[] {
  const errors: string[] = []
  const usedBy = new Map<string, string[]>()
  for (const [key, header] of Object.entries(mapping) as [string, string | undefined][]) {
    if (!header) continue
    const list = usedBy.get(header) ?? []
    usedBy.set(header, [...list, key])
  }
  for (const [header, keys] of usedBy) {
    if (keys.length > 1) errors.push(`"${header}" is used for both ${keys.join(' and ')}`)
  }
  for (const key of REQUIRED_KEYS) {
    if (!mapping[key]) errors.push(`missing required key "${key}"`)
  }
  return errors
}

interface SheetState {
  binding: SheetBinding | null
  tabs: SheetTab[]
  header: string[]
  proposal: SheetMappingProposal | null
  selectedSpreadsheetId: string | null
  /** The opened spreadsheet's own title (GET /sheet/tabs), for step 2. */
  selectedSpreadsheetTitle: string | null
  selectedTabId: string | null
  lastReport: SheetSyncReport | null
  loading: boolean
  error: string | null
}

export const useSheetStore = defineStore('sheet', {
  state: (): SheetState => ({
    binding: null,
    tabs: [],
    header: [],
    proposal: null,
    selectedSpreadsheetId: null,
    selectedSpreadsheetTitle: null,
    selectedTabId: null,
    lastReport: null,
    loading: false,
    error: null,
  }),

  getters: {
    /** The tab title for whichever tab is currently selected — what
     *  `saveMapping` needs to send (the server's mapping body wants
     *  `tabTitle`, not just the id) and never something the caller should
     *  have to track separately from `tabs`. */
    selectedTabTitle: (state): string => state.tabs.find((t) => t.id === state.selectedTabId)?.title ?? '',
  },

  actions: {
    /** GET /dispatcher/sheet — the org's current binding, or null when
     *  nothing has ever been connected. */
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.binding = await sheetApi.fetchBinding()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load the sheet connection right now.')
      } finally {
        this.loading = false
      }
    },

    /** GET /dispatcher/sheet/oauth/start, then hand the browser to Google —
     *  this is a full-page redirect, not an XHR the store can await the
     *  result of. The callback lands back on `/night-shift?tab=connect&step=2`. */
    async startOAuth(): Promise<void> {
      this.error = null
      try {
        const url = await sheetApi.startOAuth()
        window.location.assign(url)
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to start Google sign-in right now.')
      }
    },

    /** Step 2 (final fix wave, C1 — no account-wide listing): the
     *  dispatcher pastes the sheet's link (or its bare id); the id is pulled
     *  out locally and GET /dispatcher/sheet/tabs answers the spreadsheet's
     *  title and tabs. Clears any tab/header state from a previously opened
     *  spreadsheet so step 3 never renders a stale mapping against the wrong
     *  sheet. A link that carries no id is refused without a round trip. */
    async openSpreadsheet(link: string): Promise<void> {
      this.error = null
      const spreadsheetId = spreadsheetIdFromLink(link)
      if (!spreadsheetId) {
        this.error = 'That does not look like a Google Sheets link — paste the address from your browser\'s bar.'
        return
      }
      this.selectedSpreadsheetId = spreadsheetId
      this.selectedSpreadsheetTitle = null
      this.selectedTabId = null
      this.tabs = []
      this.header = []
      this.proposal = null
      this.loading = true
      try {
        const info = await sheetApi.fetchTabs(spreadsheetId)
        this.selectedSpreadsheetTitle = info.title
        this.tabs = info.tabs
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to open that spreadsheet right now.')
      } finally {
        this.loading = false
      }
    },

    /** Step 2: pick the tab. Reading its header (`readHeader`) is a separate
     *  step so a caller can show "loading the header…" between the two. */
    pickTab(tabId: string): void {
      this.selectedTabId = tabId
      this.header = []
      this.proposal = null
    },

    /** GET /dispatcher/sheet/header — the tab's header row and the server's
     *  proposed mapping (spec §9.3 step 3's starting point). */
    async readHeader(): Promise<void> {
      if (!this.selectedSpreadsheetId || !this.selectedTabId) return
      this.loading = true
      this.error = null
      try {
        const { header, proposal } = await sheetApi.fetchHeader(this.selectedSpreadsheetId, this.selectedTabId)
        this.header = header
        this.proposal = proposal
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to read that tab\'s header row right now.')
      } finally {
        this.loading = false
      }
    },

    /** POST /dispatcher/sheet/mapping — refused locally (mirroring the
     *  server's own `validateMapping`) before the round trip, so a blank
     *  required key or a header used twice never leaves the browser. Throws
     *  on either kind of refusal so a caller's own try/catch (as
     *  `savePolicy` does) can stop and leave the step open. */
    async saveMapping(mapping: SheetMapping): Promise<SheetBinding> {
      this.error = null
      const localErrors = validateMappingLocally(mapping)
      if (localErrors.length > 0) {
        this.error = localErrors.join('; ')
        throw new Error(this.error)
      }
      if (!this.selectedSpreadsheetId || !this.selectedTabId) {
        this.error = 'Pick a spreadsheet and tab first.'
        throw new Error(this.error)
      }
      this.loading = true
      try {
        this.binding = await sheetApi.saveMapping({
          spreadsheetId: this.selectedSpreadsheetId,
          tabId: this.selectedTabId,
          tabTitle: this.selectedTabTitle,
          headerRow: 1,
          mapping,
        })
        return this.binding
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to save that mapping right now.')
        throw error
      } finally {
        this.loading = false
      }
    },

    /** POST /dispatcher/sheet/install — writes the Night Shift columns onto
     *  the connected tab (Task 9). */
    async install(): Promise<SheetBinding> {
      this.loading = true
      this.error = null
      try {
        this.binding = await sheetApi.install()
        return this.binding
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to install the Night Shift columns right now.')
        throw error
      } finally {
        this.loading = false
      }
    },

    /** POST /dispatcher/sheet/sync-now, then reload the binding — sync-now
     *  writes `lastSyncAt`/`lastError` server-side (fix round 1, finding 1),
     *  and the summary card's "Last sync" must reflect that fresh value, not
     *  the one it rendered before the button was pressed. The reload is
     *  best-effort: a report we already have is real regardless of whether
     *  the follow-up GET succeeds, so its failure is swallowed rather than
     *  turned into a false "sync failed". */
    async syncNow(): Promise<SheetSyncReport> {
      this.loading = true
      this.error = null
      try {
        this.lastReport = await sheetApi.syncNow()
        try {
          this.binding = await sheetApi.fetchBinding()
        } catch {
          // The sync itself succeeded; a binding refresh is a nicety.
        }
        return this.lastReport
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to sync right now.')
        throw error
      } finally {
        this.loading = false
      }
    },

    /** DELETE /dispatcher/sheet — pauses the binding and revokes the token
     *  server-side; the response binding (status: "paused") replaces ours so
     *  the summary card disappears immediately. */
    async disconnect(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.binding = await sheetApi.disconnect()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to disconnect the sheet right now.')
        throw error
      } finally {
        this.loading = false
      }
    },

    /** Re-map (the summary card's button): jump back into step 3 against the
     *  binding's own spreadsheet/tab, re-reading the header fresh rather than
     *  trusting whatever `columns` it already has (the sheet may have grown
     *  or lost headers since it was first mapped). */
    async reenterMapping(): Promise<void> {
      if (!this.binding) return
      this.selectedSpreadsheetId = this.binding.spreadsheetId
      this.selectedSpreadsheetTitle = this.binding.spreadsheetTitle
      this.selectedTabId = this.binding.tabId
      this.tabs = [{ id: this.binding.tabId, title: this.binding.tabTitle }]
      await this.readHeader()
      if (this.proposal) {
        // Re-mapping starts from what is actually installed, not the
        // server's fresh alias guess — a dispatcher who already fixed a
        // mismatch should not see it silently reverted.
        this.proposal = { ...this.proposal, mapping: { ...this.proposal.mapping, ...this.binding.columns } }
      }
    },
  },
})
