import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as lockApi from '../lib/api'
import { api } from '../lib/api'
import BrokerGrid from '../components/broker/BrokerGrid.vue'
import { useAuthStore } from '../stores/auth'
import { useBrokerBoardStore } from '../stores/brokerBoard'
import BrokerBoardView from './BrokerBoardView.vue'

const mountView = () => mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
  // The lock calls the view drives through stores/loadLocks (A2 Task 8/F4).
  acquireLoadLock: vi.fn(),
  heartbeatLoadLock: vi.fn(),
  releaseLoadLock: vi.fn(),
  fetchLoadLocks: vi.fn(),
}))
// A4 Task 7: onMounted now calls store.connectRealtime(). Mocked (rather than
// left pointed at the real singleton) so mounting this view in a test never
// tries to open a real WebSocket and never leaks a handler into a shared
// module-scope map across this file's un-unmounted tests.
vi.mock('../lib/realtime', () => ({
  OPEN: '$open',
  subscribe: vi.fn(() => () => {}),
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPatch = vi.mocked(api.patch)

const layout = ['BOL#', 'CUSTOMER /CARRIER', 'TELEPHONE#', 'CONTACT NAME', 'PICK UP', 'PU ZIP', 'DEL ZIP', 'DELIVERY', 'RATE', 'SOLD RATE', 'PROFIT', 'M.C. #', 'LOAD#', 'SHIP DATE', '****UPDATE****', 'APPT SCHEDULE']
  .map((label, i) => ({ key: ['bol', 'customer', 'phone', 'contact', 'pickupCity', 'puZip', 'delZip', 'deliveryCity', 'rate', 'soldRate', 'profit', 'mc', 'loadNo', 'shipDate', 'update', 'appt'][i], label }))
  .concat([{ key: 'agent', label: 'AGENT' }])

const loads = [
  { id: 'l1', line: 1, top: { bol: '0500001', customer: 'ACME FOODS', phone: 'https://cloud.example.com/o/1', pickupCity: 'Henderson, NV', puZip: '89074', delZip: '75236', deliveryCity: 'Dallas, TX', rate: '$4,000.00', soldRate: '$3,600.00', profit: '$400.00', mc: 'MC', loadNo: '2026-34566-00', shipDate: '7/13/2026', update: 'DELIVERED 07/15/2026', appt: 'PU: 07/13 - 13:00' },
    bottom: { customer: 'BLUE ROAD LLC', phone: '(555) 010-0104', contact: 'Contact A', mc: '1000001', loadNo: '145205', appt: 'DEL: 07/15 - 11:00' }, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 1, version: 0 },
  { id: 'l2', line: 2, top: { bol: '0500005', customer: 'ACME FOODS', pickupCity: 'Henderson, NV', deliveryCity: 'Denver, CO', rate: '$3,100.00', loadNo: '2026-35100-00', appt: 'PU: 07/15 - tbd' }, bottom: null, pill: { state: 'attention', text: "can't read PU appointment: \"PU: 07/15 - tbd\"" }, agentLine: null, status: 'open', boardLine: 1, version: 0 },
]

describe('BrokerBoardView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(lockApi.fetchLoadLocks).mockResolvedValue({ locks: [] })
    vi.mocked(lockApi.releaseLoadLock).mockResolvedValue()
    vi.mocked(lockApi.acquireLoadLock).mockImplementation(async (id: string) => ({ lock: { loadId: id, orgId: 'o', dispatcherId: 'me', by: 'Me', since: 1, expiresAt: Date.now() + 60_000 } }))
    vi.mocked(lockApi.heartbeatLoadLock).mockImplementation(async (id: string) => ({ lock: { loadId: id, orgId: 'o', dispatcherId: 'me', by: 'Me', since: 1, expiresAt: Date.now() + 60_000 } }))
  })

  it('renders their header, two rows per load, and the pills', async () => {
    mockedGet.mockResolvedValueOnce({ data: { layout, loads } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    const headers = w.findAll('thead th').map((th) => th.text())
    expect(headers.slice(1, 17)).toEqual(layout.slice(0, 16).map((c) => c.label))   // th[0] is the checkbox gutter
    expect(headers[17]).toBe('AGENT')
    const rows = w.findAll('tbody tr')
    expect(rows).toHaveLength(3)                       // 2 for the first load, 1 for the unassigned one
    expect(rows[0].text()).toContain('ACME FOODS')
    expect(rows[0].find('a[href^="https://"]').exists()).toBe(true)   // the tracking link opens in a new tab
    expect(rows[0].find('a').attributes('target')).toBe('_blank')
    expect(rows[1].text()).toContain('BLUE ROAD LLC')
    expect(rows[1].text()).toContain('145205')
    expect(rows[0].find('[data-pill]').text()).toBe('—')
    expect(rows[2].find('[data-pill]').text()).toBe('Attention')
    expect(rows[2].find('[data-pill]').attributes('title')).toMatch(/can't read PU appointment/)
  })

  it('paints the yellow customer cell only when there is a customer', async () => {
    const fleetLoad = { id: 'l3', line: 3, top: { pickupCity: 'Kansas City, MO', deliveryCity: 'St. Louis, MO', rate: '$660.00', loadNo: 'W-05-JAKE' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 3 }
    mockedGet.mockResolvedValueOnce({ data: { layout, loads: [loads[0], fleetLoad] } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    const rows = w.findAll('tbody tr[data-row="top"]')
    // The yellow is the handoff's own token now, applied inline so a sticky
    // cell can never render transparent. td[0] is the checkbox gutter,
    // td[1] is BOL#.
    expect(rows[0].findAll('td')[2].attributes('style')).toContain('--bb-customer')
    expect(rows[1].findAll('td')[2].attributes('style')).not.toContain('--bb-customer')
  })

  it('Task 11: a sheet-tier org loads the sheet binding on mount, alongside the board and its view', async () => {
    useAuthStore().plan = { tier: 'sheet' }
    mockedGet.mockResolvedValueOnce({ data: { layout, loads } })
    mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet')
  })

  // Final fix wave, minor: only a sheet-tier org can have a binding, so a
  // tower org never fetches one.
  it('a tower-tier org never fetches the sheet binding', async () => {
    useAuthStore().plan = { tier: 'tower' }
    mockedGet.mockResolvedValueOnce({ data: { layout, loads } })
    mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(mockedGet).not.toHaveBeenCalledWith('/dispatcher/sheet')
  })

  it('says what went wrong instead of an empty grid', async () => {
    mockedGet.mockRejectedValueOnce({ response: { data: { error: 'The broker board requires an org-scoped dispatcher account' } } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(w.text()).toContain('org-scoped')
    expect(w.find('table').exists()).toBe(false)
  })

  it('shows the empty board with the import call to action when there are no loads', async () => {
    mockedGet.mockResolvedValueOnce({ data: { layout, loads: [] } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(w.text()).toContain('Import your board')
  })

  it('selecting loads shows the bulk bar, delete asks first and names the loads, archive toggle reloads', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    await w.find('tbody input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(w.find('[data-bulk]').text()).toContain('1 load selected')
    await w.find('button[data-action="delete"]').trigger('click')
    expect(w.find('[role="dialog"]').text()).toContain('145205')
    await w.find('[role="dialog"] button[data-cancel]').trigger('click')
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    await w.find('input[data-show-archived]').setValue(true)
    await flushPromises()
    expect(mockedGet).toHaveBeenLastCalledWith('/dispatcher/broker-board?archived=1')
  })

  it('keeps the grid mounted and the selection visible when a bulk delete is refused', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    mockedPost.mockRejectedValueOnce({ response: { status: 409, data: { error: "These loads can't be deleted while assigned or in progress: 145205" } } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    await w.find('tbody input[type="checkbox"]').setValue(true)
    await flushPromises()
    await w.find('button[data-action="delete"]').trigger('click')
    await w.find('[role="dialog"] button[data-confirm]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain("These loads can't be deleted while assigned or in progress: 145205")
    expect(w.find('table').exists()).toBe(true)
    expect((w.find('tbody input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    expect(useBrokerBoardStore().selectedIds).toContain('l1')
  })

  // Final review finding 1 (CRITICAL), end to end: the dispatcher checks
  // something with "Show archived" on, turns it back off, and acts on the
  // selection. The load that left the board must leave the selection with
  // it — otherwise the bar counted it, the confirmation never named it, and
  // the POST deleted it anyway.
  it('drops a load that left the board from the bar, the confirmation and the POST', async () => {
    const archived = { ...loads[1], id: 'l9', status: 'archived', top: { ...loads[1].top, bol: '0500009', loadNo: '2026-99999-00' } }
    // Routed by URL rather than queued in call order: the view also fetches
    // its fills/merges on mount (slice 2B), and a positional queue silently
    // hands the board's second response to that request instead — which is
    // exactly the kind of shift that makes a real regression look like a
    // fixture problem. The board's own toggle is already in the URL.
    mockedGet.mockImplementation((url: string) => {
      if (url.includes('/view')) return Promise.resolve({ data: { fills: {}, merges: {} } })
      return Promise.resolve({ data: { layout, loads: url.includes('archived=1') ? [...loads, archived] : loads } })
    })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    await w.find('input[data-show-archived]').setValue(true)
    await flushPromises()
    await w.find('thead input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(w.find('[data-bulk]').text()).toContain('3 loads selected')
    await w.find('input[data-show-archived]').setValue(false)
    await flushPromises()
    expect(w.find('[data-bulk]').text()).toContain('2 loads selected')
    expect(useBrokerBoardStore().selectedIds).toEqual(['l1', 'l2'])
    await w.find('button[data-action="delete"]').trigger('click')
    const dialog = w.find('[role="dialog"]').text()
    expect(dialog).toContain('2 loads')
    expect(dialog).not.toContain('0500009')
    mockedPost.mockResolvedValueOnce({ data: { deleted: 2 } })
    await w.find('[role="dialog"] button[data-confirm]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenLastCalledWith('/dispatcher/broker-board/loads/delete', { ids: ['l1', 'l2'] })
  })

  // B2: the record's refusal reaches the dispatcher instead of being dropped
  // — the cell landed, but the status did not move, and this says where it
  // does move. Not red (nothing failed) and dismissible.
  it('shows the record\'s refusal after a cell save, verbatim, and lets it be dismissed', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(w.find('[data-refusal]').exists()).toBe(false)

    const sentence = 'record says assigned — advance the trip in the Cockpit'
    mockedPatch.mockResolvedValueOnce({ data: { load: loads[0], version: 2, statusRefused: sentence } })
    await useBrokerBoardStore().editCell('l1', { row: 'top', key: 'update', value: 'DELIVERED 07/17/2026', baseVersion: 1 })
    await flushPromises()
    expect(w.find('[data-refusal]').text()).toContain(sentence)

    await w.find('[data-dismiss-refusal]').trigger('click')
    await flushPromises()
    expect(w.find('[data-refusal]').exists()).toBe(false)
  })

  // NIT 9: the selection deliberately survives a search, so the bar has to
  // say how much of it the search is hiding.
  it('says how many selected loads the current search is hiding', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mount(BrokerBoardView, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    await w.find('thead input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(w.find('[data-bulk]').text()).toContain('2 loads selected')
    expect(w.find('[data-bulk]').text()).not.toContain('not shown')
    await w.find('input[type="search"]').setValue('0500005')
    await flushPromises()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    expect(w.find('[data-bulk]').text()).toContain('2 loads selected')
    expect(w.find('[data-bulk]').text()).toContain('1 not shown by the current search/filters')
  })

  it('offers keep mine / take theirs when a cell collides with a newer version', async () => {
    const w = mountView()
    const store = useBrokerBoardStore()
    store.conflicts = { a: { loadId: 'a', write: { row: 'top', key: 'customer', value: 'MINE', baseVersion: 3 }, current: 4, theirs: 'THEIRS', load: { id: 'a', version: 4 } as never } }
    await nextTick()
    expect(w.find('[data-conflict]').text()).toContain('MINE')
    expect(w.find('[data-conflict]').text()).toContain('THEIRS')
    const resolve = vi.spyOn(store, 'resolveConflict').mockResolvedValue(true)
    await w.find('[data-keep-mine]').trigger('click')
    expect(resolve).toHaveBeenCalledWith('a', 'mine')
  })

  // A4 Task 7: a single slot let a second collision steal the first's panel.
  // Two conflicted loads must render two panels, each resolvable on its own.
  it('renders one conflict panel per conflicted row, and resolving one leaves the other standing', async () => {
    const w = mountView()
    const store = useBrokerBoardStore()
    store.conflicts = {
      a: { loadId: 'a', write: { row: 'top', key: 'customer', value: 'MINE-A', baseVersion: 3 }, current: 4, theirs: 'MEIBORG', load: { id: 'a', version: 4 } as never },
      b: { loadId: 'b', write: { row: 'top', key: 'customer', value: 'MINE-B', baseVersion: 8 }, current: 9, theirs: 'ACME', load: { id: 'b', version: 9 } as never },
    }
    await nextTick()
    const panels = w.findAll('[data-conflict]')
    expect(panels).toHaveLength(2)
    expect(panels.map((p) => p.text()).join(' ')).toContain('MEIBORG')
    expect(panels.map((p) => p.text()).join(' ')).toContain('ACME')
    const resolve = vi.spyOn(store, 'resolveConflict').mockResolvedValue(true)
    await panels[0].find('[data-take-theirs]').trigger('click')
    expect(resolve).toHaveBeenCalledWith('a', 'theirs')
  })

  // --- F4: a fast typist ---------------------------------------------------
  //
  // Tab across a row and the next editor opens before the previous cell's
  // PATCH has landed. With one pending save and one held load per tab, load
  // A's lock was released the moment B's editor opened — and A's write then
  // landed on a row anyone could have taken in between.
  it("releases load A only once A's PATCH settles, and holds B throughout", async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mountView()
    await flushPromises()
    const grid = w.findComponent(BrokerGrid)
    const release = vi.mocked(lockApi.releaseLoadLock)

    // A: the editor opens, the cell is committed, the editor closes — and the
    // PATCH is still in the air.
    let landA!: (v: unknown) => void
    mockedPatch.mockReturnValueOnce(new Promise((r) => { landA = r }))
    grid.vm.$emit('edit-start', 'l1')
    await flushPromises()
    expect(lockApi.acquireLoadLock).toHaveBeenCalledWith('l1')
    grid.vm.$emit('edit', { loadId: 'l1', row: 'top', key: 'customer', value: 'A', baseVersion: 0 })
    grid.vm.$emit('edit-end', 'l1')
    await flushPromises()
    expect(release).not.toHaveBeenCalled()

    // B: a second editor, before A has landed.
    grid.vm.$emit('edit-start', 'l2')
    await flushPromises()
    expect(lockApi.acquireLoadLock).toHaveBeenCalledWith('l2')
    expect(release).not.toHaveBeenCalled()

    // A lands: A's lock goes, B's does not.
    landA({ data: { load: loads[0], version: 1, statusRefused: null } })
    await flushPromises()
    expect(release).toHaveBeenCalledWith('l1')
    expect(release).not.toHaveBeenCalledWith('l2')

    // B is released by its own commit.
    mockedPatch.mockResolvedValueOnce({ data: { load: loads[1], version: 1, statusRefused: null } })
    grid.vm.$emit('edit', { loadId: 'l2', row: 'top', key: 'customer', value: 'B', baseVersion: 0 })
    grid.vm.$emit('edit-end', 'l2')
    await flushPromises()
    expect(release).toHaveBeenCalledWith('l2')
  })

  // F8: `resolveConflict` can be refused again (the row moved a second time
  // while the panel was open). Releasing there handed the row away
  // mid-decision.
  it('keeps the lock when resolving the conflict is itself refused', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mountView()
    await flushPromises()
    const grid = w.findComponent(BrokerGrid)
    const release = vi.mocked(lockApi.releaseLoadLock)
    const store = useBrokerBoardStore()

    grid.vm.$emit('edit-start', 'l1')
    await flushPromises()
    mockedPatch.mockRejectedValueOnce({ response: { status: 409, data: { error: 'STALE_VERSION', current: 4, theirs: 'THEIRS', load: { ...loads[0], version: 4 } } } })
    grid.vm.$emit('edit', { loadId: 'l1', row: 'top', key: 'customer', value: 'MINE', baseVersion: 0 })
    grid.vm.$emit('edit-end', 'l1')
    await flushPromises()
    expect(store.conflictFor('l1')).not.toBeNull()
    expect(release).not.toHaveBeenCalled()

    // Keep mine, and the re-based write collides AGAIN.
    vi.spyOn(store, 'resolveConflict').mockImplementation(async () => false)
    await w.find('[data-keep-mine]').trigger('click')
    await flushPromises()
    expect(release).not.toHaveBeenCalled()
  })

  // F12: a selected id with no rendered version claimed `baseVersion: 0` —
  // a version it never read, which §7.4 would then have waved through.
  it('skips a selected row that is no longer on the board instead of sending baseVersion 0', async () => {
    mockedGet.mockResolvedValue({ data: { layout, loads } })
    const w = mountView()
    await flushPromises()
    const store = useBrokerBoardStore()
    store.selectedIds = ['l1', 'ghost']
    mockedPost.mockResolvedValueOnce({ data: { loads: [], refusals: [] } })
    await w.findComponent({ name: 'BulkBar' }).vm.$emit('set-update', 'DELIVERED')
    await flushPromises()
    const sent = mockedPost.mock.calls.find((c) => c[0] === '/dispatcher/broker-board/cells')
    expect(sent?.[1]).toEqual({ cells: [{ loadId: 'l1', row: 'top', key: 'update', source: 'UPDATE', value: 'DELIVERED', baseVersion: 0 }] })
    expect(store.error).toContain('skipped')
  })
})
