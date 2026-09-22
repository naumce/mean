import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { spreadsheetIdFromLink, useSheetStore, validateMappingLocally } from './sheet'

// Task 11 (the Connect tab): each store action is a thin call onto exactly
// one /api/dispatcher/sheet route (fleet-backend routes/dispatcherSheet.ts,
// Task 7/9) — mocked at the shared axios client, the same way nightShift.ts's
// own spec mocks it, not at ../api/sheetApi (that module has no logic of its
// own worth stubbing around).
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedDelete = vi.mocked(api.delete)

const binding = {
  id: 'b1', spreadsheetId: 'sheet-1', spreadsheetTitle: 'Dispatch Sheet', tabId: 'tab-1', tabTitle: 'Loads', headerRow: 1,
  columns: { loadRef: 'Load', driverPhone: 'Driver Phone', pickup: 'Pickup', delivery: 'Delivery', deliveryAppt: 'Del Appt' },
  agentSwitchCol: null, agentStatusCol: null, accountEmail: 'dispatch@fleet.test',
  lastSyncAt: null, lastError: null, status: 'connected' as const,
}

describe('useSheetStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedDelete.mockReset()
  })

  it('load() calls GET /dispatcher/sheet and stores the binding', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding } })
    const store = useSheetStore()
    await store.load()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet')
    expect(store.binding).toEqual(binding)
  })

  it('load() with no binding stores null and no error', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: null } })
    const store = useSheetStore()
    await store.load()
    expect(store.binding).toBeNull()
    expect(store.error).toBeNull()
  })

  it('startOAuth() calls GET /dispatcher/sheet/oauth/start and navigates to the returned url', async () => {
    mockedGet.mockResolvedValueOnce({ data: { url: 'https://accounts.google.com/o/oauth2/auth?x=1' } })
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { assign }, writable: true })
    const store = useSheetStore()
    await store.startOAuth()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet/oauth/start')
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1')
  })

  // Final fix wave, C1: no GET /sheet/spreadsheets. The dispatcher pastes
  // the sheet's link; the id comes out of it locally.
  it('spreadsheetIdFromLink() pulls the id out of a Sheets URL, accepts a bare id, refuses anything else', () => {
    expect(spreadsheetIdFromLink('https://docs.google.com/spreadsheets/d/1AbC_d-EF9/edit#gid=0')).toBe('1AbC_d-EF9')
    expect(spreadsheetIdFromLink('  https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing ')).toBe('1AbC')
    expect(spreadsheetIdFromLink('1AbC_d-EF9')).toBe('1AbC_d-EF9')
    expect(spreadsheetIdFromLink('')).toBeNull()
    expect(spreadsheetIdFromLink('https://docs.google.com/document/d/1AbC/edit')).toBeNull()
    expect(spreadsheetIdFromLink('not a link at all')).toBeNull()
  })

  it('openSpreadsheet(link) extracts the id, calls GET /dispatcher/sheet/tabs and stores the title + tabs', async () => {
    mockedGet.mockResolvedValueOnce({ data: { title: 'Dispatch Sheet', tabs: [{ id: 't1', title: 'Loads' }] } })
    const store = useSheetStore()
    await store.openSpreadsheet('https://docs.google.com/spreadsheets/d/s1/edit#gid=0')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet/tabs', { params: { spreadsheetId: 's1' } })
    expect(store.selectedSpreadsheetId).toBe('s1')
    expect(store.selectedSpreadsheetTitle).toBe('Dispatch Sheet')
    expect(store.tabs).toEqual([{ id: 't1', title: 'Loads' }])
    expect(store.error).toBeNull()
  })

  it('openSpreadsheet(link) refuses a link with no spreadsheet id without a round trip', async () => {
    const store = useSheetStore()
    await store.openSpreadsheet('https://example.com/nothing')
    expect(mockedGet).not.toHaveBeenCalled()
    expect(store.selectedSpreadsheetId).toBeNull()
    expect(store.error).toContain('Google Sheets link')
  })

  it('pickTab(id) sets the selected tab without a round trip', () => {
    const store = useSheetStore()
    store.pickTab('t1')
    expect(store.selectedTabId).toBe('t1')
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('readHeader() calls GET /dispatcher/sheet/header with the selected spreadsheet/tab and stores header + proposal', async () => {
    const proposal = { mapping: { loadRef: 'Load #' }, extras: ['Broker', 'Notes'], missing: ['driverPhone'] }
    mockedGet.mockResolvedValueOnce({ data: { header: ['Load #', 'Broker', 'Notes'], proposal } })
    const store = useSheetStore()
    store.selectedSpreadsheetId = 's1'
    store.selectedTabId = 't1'
    await store.readHeader()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet/header', { params: { spreadsheetId: 's1', tabId: 't1', headerRow: 1 } })
    expect(store.header).toEqual(['Load #', 'Broker', 'Notes'])
    expect(store.proposal).toEqual(proposal)
  })

  it('saveMapping() refuses locally when a required key is blank, without a round trip', async () => {
    const store = useSheetStore()
    store.selectedSpreadsheetId = 's1'
    store.selectedTabId = 't1'
    store.tabs = [{ id: 't1', title: 'Loads' }]
    await expect(store.saveMapping({ loadRef: 'Load #' })).rejects.toThrow()
    expect(mockedPost).not.toHaveBeenCalled()
    expect(store.error).toContain('driverPhone')
  })

  it('saveMapping() refuses locally when the same header is used twice', async () => {
    const store = useSheetStore()
    store.selectedSpreadsheetId = 's1'
    store.selectedTabId = 't1'
    const dup = { loadRef: 'Load #', driverPhone: 'Load #', pickup: 'PU', delivery: 'DEL', deliveryAppt: 'Appt' }
    await expect(store.saveMapping(dup)).rejects.toThrow()
    expect(mockedPost).not.toHaveBeenCalled()
    expect(store.error).toContain('used for both')
  })

  it('saveMapping() with a complete mapping calls POST /dispatcher/sheet/mapping and stores the binding', async () => {
    mockedPost.mockResolvedValueOnce({ data: { binding } })
    const store = useSheetStore()
    store.selectedSpreadsheetId = 'sheet-1'
    store.selectedTabId = 'tab-1'
    store.tabs = [{ id: 'tab-1', title: 'Loads' }]
    const mapping = { loadRef: 'Load', driverPhone: 'Driver Phone', pickup: 'Pickup', delivery: 'Delivery', pickupAppt: 'PU Appt', deliveryAppt: 'Del Appt' }
    const result = await store.saveMapping(mapping)
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/mapping', {
      spreadsheetId: 'sheet-1', tabId: 'tab-1', tabTitle: 'Loads', headerRow: 1, mapping, rowsPerLoad: 1,
    })
    expect(result).toEqual(binding)
    expect(store.binding).toEqual(binding)
  })

  // Two-rows-per-load sheets.
  it('readHeader() stores the server\'s suggestedRowsPerLoad', async () => {
    const proposal = { mapping: { loadRef: 'LOAD#', pickupAppt: 'APPT SCHEDULE', deliveryAppt: 'APPT SCHEDULE' }, extras: [], missing: [] }
    mockedGet.mockResolvedValueOnce({ data: { header: ['LOAD#', 'APPT SCHEDULE'], proposal, suggestedRowsPerLoad: 2 } })
    const store = useSheetStore()
    store.selectedSpreadsheetId = 's1'
    store.selectedTabId = 't1'
    await store.readHeader()
    expect(store.suggestedRowsPerLoad).toBe(2)
  })

  it('saveMapping() sends rowsPerLoad: 2 when asked, and a shared appointment column passes local validation', async () => {
    mockedPost.mockResolvedValueOnce({ data: { binding: { ...binding, rowsPerLoad: 2 } } })
    const store = useSheetStore()
    store.selectedSpreadsheetId = 'sheet-1'
    store.selectedTabId = 'tab-1'
    store.tabs = [{ id: 'tab-1', title: 'Board' }]
    const mapping = { loadRef: 'LOAD#', driverPhone: 'TELEPHONE#', pickup: 'PICK UP', delivery: 'DELIVERY', pickupAppt: 'APPT SCHEDULE', deliveryAppt: 'APPT SCHEDULE' }
    const result = await store.saveMapping(mapping, 2)
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/mapping', {
      spreadsheetId: 'sheet-1', tabId: 'tab-1', tabTitle: 'Board', headerRow: 1, mapping, rowsPerLoad: 2,
    })
    expect(result.rowsPerLoad).toBe(2)
  })

  it('install() calls POST /dispatcher/sheet/install and stores the returned binding', async () => {
    const installed = { ...binding, agentSwitchCol: 'K', agentStatusCol: 'L' }
    mockedPost.mockResolvedValueOnce({ data: { binding: installed } })
    const store = useSheetStore()
    await store.install()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/install')
    expect(store.binding).toEqual(installed)
  })

  it('syncNow() calls POST /dispatcher/sheet/sync-now, stores the report, and reloads the binding', async () => {
    const report = { read: 4, created: 1, updated: 2, unchanged: 1, skipped: [], statusWrites: 3, error: null }
    const refreshed = { ...binding, lastSyncAt: '2026-09-21T00:00:00.000Z' }
    mockedPost.mockResolvedValueOnce({ data: { report } })
    mockedGet.mockResolvedValueOnce({ data: { binding: refreshed } })
    const store = useSheetStore()
    const result = await store.syncNow()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/sync-now')
    expect(result).toEqual(report)
    expect(store.lastReport).toEqual(report)
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet')
    expect(store.binding).toEqual(refreshed)
  })

  it('syncNow() keeps the report even when the follow-up binding reload fails', async () => {
    const report = { read: 1, created: 0, updated: 0, unchanged: 1, skipped: [], statusWrites: 0, error: null }
    mockedPost.mockResolvedValueOnce({ data: { report } })
    mockedGet.mockRejectedValueOnce(new Error('network down'))
    const store = useSheetStore()
    const result = await store.syncNow()
    expect(result).toEqual(report)
    expect(store.error).toBeNull()
  })

  it('disconnect() calls DELETE /dispatcher/sheet and stores the paused binding', async () => {
    const paused = { ...binding, status: 'paused' as const }
    mockedDelete.mockResolvedValueOnce({ data: { binding: paused } })
    const store = useSheetStore()
    await store.disconnect()
    expect(mockedDelete).toHaveBeenCalledWith('/dispatcher/sheet')
    expect(store.binding).toEqual(paused)
  })
})

describe('validateMappingLocally', () => {
  it('flags every missing required key', () => {
    const errors = validateMappingLocally({})
    expect(errors).toContain('missing required key "loadRef"')
    expect(errors).toContain('missing required key "driverPhone"')
    expect(errors).toContain('missing required key "pickup"')
    expect(errors).toContain('missing required key "delivery"')
    expect(errors).toContain('missing required key "deliveryAppt"')
    // Final fix wave, I7: pickupAppt is required too (mirrors mapping.ts).
    expect(errors).toContain('missing required key "pickupAppt"')
  })

  it('refuses a mapping with everything but pickupAppt (final fix wave, I7)', () => {
    const errors = validateMappingLocally({ loadRef: 'Load', driverPhone: 'Phone', pickup: 'PU', delivery: 'DEL', deliveryAppt: 'Appt' })
    expect(errors).toEqual(['missing required key "pickupAppt"'])
  })

  it('flags a header used for two keys', () => {
    const errors = validateMappingLocally({ loadRef: 'Load', driverPhone: 'Load' })
    expect(errors.some((e) => e.includes('used for both'))).toBe(true)
  })

  // Two-rows-per-load sheets: mirrors mapping.ts — only that pair may share.
  it('allows pickupAppt and deliveryAppt to share one header, and nothing else', () => {
    const shared = { loadRef: 'LOAD#', driverPhone: 'TELEPHONE#', pickup: 'PICK UP', delivery: 'DELIVERY', pickupAppt: 'APPT SCHEDULE', deliveryAppt: 'APPT SCHEDULE' }
    expect(validateMappingLocally(shared)).toEqual([])
    expect(validateMappingLocally({ ...shared, notes: 'APPT SCHEDULE' })).toEqual(['"APPT SCHEDULE" is used for both pickupAppt and deliveryAppt and notes'])
    expect(validateMappingLocally({ ...shared, driverPhone: 'LOAD#' })).toEqual(['"LOAD#" is used for both loadRef and driverPhone'])
  })

  it('passes a complete, non-duplicated mapping', () => {
    const errors = validateMappingLocally({
      loadRef: 'Load', driverPhone: 'Phone', pickup: 'PU', delivery: 'DEL', pickupAppt: 'PU Appt', deliveryAppt: 'Appt',
    })
    expect(errors).toEqual([])
  })
})
