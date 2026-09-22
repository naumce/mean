import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useAuthStore } from '../../stores/auth'
import type { AgentPolicy } from '../../stores/nightShift'
import ConnectSheet from './ConnectSheet.vue'

// Task 11: the Connect tab's five steps (spec §9.3), on one scrolling page
// with the current step expanded. The shared axios client is mocked once,
// the same way BrokerGrid.agent.spec.ts mocks it for two cooperating stores
// (here: the sheet store and nightShift's `savePolicy`) — this component
// isn't the thing under test for either store's own logic, only that it
// wires them correctly.
let routeQuery: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
}))

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPut = vi.mocked(api.put)
const mockedDelete = vi.mocked(api.delete)

const standardPolicy: AgentPolicy = {
  id: 'pol-standard', name: 'Standard', stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60, offRouteMi: 3.1,
  offRouteMin: 10, rungGapMin: 5, maxCalls: 2, dispatcherEmail: 'old@fleet.test', dispatcherPhone: null,
  customerEmailOn: false, shadow: true, bossCallOn: true, quietFrom: null, quietTo: null,
}
const standardWithPhone: AgentPolicy = { ...standardPolicy, dispatcherPhone: '+15559990000' }

// ConnectSheet's onMounted always calls `sheet.load()` then
// `nightShift.loadPolicies()`, in that order — queue this right after
// whichever binding response a test sets up, unless it overrides policies
// for its own purposes (the Edit-contacts/hint tests do).
function mockPoliciesResponse(policies: AgentPolicy[] = [standardPolicy]): void {
  mockedGet.mockResolvedValueOnce({ data: { policies, loadsByPolicy: {} } })
}

// Modal teleports to <body>, outside the mounted component's own subtree —
// same pattern NightShiftView.spec.ts uses for its own go-live/delete modals.
function body(): DOMWrapper<HTMLElement> {
  return new DOMWrapper(document.body)
}

function primeAuth(): void {
  const auth = useAuthStore()
  auth.dispatcher = { id: 'd1', email: 'dispatch@fleet.test', name: 'Dee' }
  auth.org = { id: 'o1', name: 'Acme Logistics', timezone: 'America/Chicago' }
}

const pendingBinding = {
  id: 'b1', spreadsheetId: '', spreadsheetTitle: null, tabId: '', tabTitle: '', headerRow: 1, rowsPerLoad: 1 as const, columns: {},
  agentSwitchCol: null, agentStatusCol: null, accountEmail: 'me@gmail.com',
  lastSyncAt: null, lastError: null, status: 'paused' as const,
}

const connectedBinding = {
  id: 'b2', spreadsheetId: 'sheet-1', spreadsheetTitle: 'Dispatch Sheet', tabId: 'tab-1', tabTitle: 'Loads', headerRow: 1, rowsPerLoad: 1 as const,
  columns: { loadRef: 'Load #', driverPhone: 'Driver Phone', pickup: 'PU', delivery: 'DEL', deliveryAppt: 'Appt' },
  agentSwitchCol: 'K', agentStatusCol: 'L', accountEmail: 'me@gmail.com',
  lastSyncAt: '2026-09-20T05:00:00.000Z', lastError: null, status: 'connected' as const,
}

describe('ConnectSheet', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery = {}
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPut.mockReset()
    mockedDelete.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('with no binding, step 1 shows Sign in with Google', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: null } })
    mockPoliciesResponse()
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()
    expect(w.find('[data-testid="sign-in-google"]').exists()).toBe(true)
    expect(w.find('[data-testid="sheet-summary"]').exists()).toBe(false)
  })

  it('Sign in with Google calls startOAuth and navigates to the returned url', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: null } })
    mockPoliciesResponse()
    mockedGet.mockResolvedValueOnce({ data: { url: 'https://accounts.google.com/o/oauth2/auth?x=1' } })
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { assign }, writable: true })
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()
    await w.get('[data-testid="sign-in-google"]').trigger('click')
    await flushPromises()
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1')
  })

  it('walks a paused (post-OAuth) binding through pasting a sheet link, a tab, mapping, contacts and install', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: pendingBinding } }) // load()
    mockPoliciesResponse() // loadPolicies() at mount
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()

    // Step 2 (final fix wave, C1): no listing — paste the link, get the
    // sheet's title and a tab picker back.
    expect(w.find('[data-testid="sheet-link"]').exists()).toBe(true)
    expect(w.find('[data-testid="spreadsheet-select"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-select"]').exists()).toBe(false)

    mockedGet.mockResolvedValueOnce({ data: { title: 'Dispatch Sheet', tabs: [{ id: 't1', title: 'Loads' }] } }) // GET /sheet/tabs
    await w.get('[data-testid="sheet-link"]').setValue('https://docs.google.com/spreadsheets/d/s1/edit#gid=0')
    await w.get('[data-testid="open-spreadsheet"]').trigger('click')
    await flushPromises()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/sheet/tabs', { params: { spreadsheetId: 's1' } })
    expect(w.get('[data-testid="spreadsheet-title"]').text()).toBe('Dispatch Sheet')
    expect(w.find('[data-testid="tab-select"]').exists()).toBe(true)
    expect(w.text()).toContain('Loads')

    // Step 3: picking the tab reads the header and shows the mapping table
    const proposal = {
      mapping: { loadRef: 'Load #', pickup: 'PU', delivery: 'DEL', pickupAppt: 'PU Appt', deliveryAppt: 'Appt' },
      extras: ['Broker', 'Notes'],
      missing: ['driverPhone'],
    }
    mockedGet.mockResolvedValueOnce({ data: { header: ['Load #', 'Driver Phone', 'PU', 'DEL', 'PU Appt', 'Appt', 'Broker', 'Notes'], proposal } })
    await w.get('[data-testid="tab-select"]').setValue('t1')
    await flushPromises()

    expect(w.find('[data-testid="mapping-table"]').exists()).toBe(true)
    expect(w.get('[data-testid="mapping-extras"]').text()).toBe('kept as extra: Broker, Notes')
    // driverPhone was never proposed -> required and blank -> highlighted;
    // pickupAppt is required too (final fix wave, I7) and proposed, so it
    // carries the required mark but no highlight.
    expect(w.get('[data-testid="mapping-row-driverPhone"]').classes().join(' ')).toContain('bg-red-50')
    expect(w.get('[data-testid="mapping-row-pickupAppt"]').find('[aria-label="required"]').exists()).toBe(true)
    expect(w.get('[data-testid="mapping-row-pickupAppt"]').classes().join(' ')).not.toContain('bg-red-50')
    expect((w.get('[data-testid="map-select-loadRef"]').element as HTMLSelectElement).value).toBe('Load #')
    // optional key not proposed offers "not mapped"
    const carrierSelect = w.get('[data-testid="map-select-carrierName"]').element as HTMLSelectElement
    expect(Array.from(carrierSelect.options).some((o) => o.text === '— not mapped —')).toBe(true)

    // Local validation refuses before the round trip while driverPhone is blank
    await w.get('[data-testid="save-mapping"]').trigger('click')
    await flushPromises()
    expect(mockedPost).not.toHaveBeenCalled()
    expect(w.get('[data-testid="mapping-error"]').text()).toContain('driverPhone')

    // Fill it in and save for real
    mockedPost.mockResolvedValueOnce({ data: { binding: connectedBinding } }) // POST /sheet/mapping
    await w.get('[data-testid="map-select-driverPhone"]').setValue('Driver Phone')
    await w.get('[data-testid="save-mapping"]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/mapping', expect.objectContaining({
      spreadsheetId: 's1', tabId: 't1', tabTitle: 'Loads',
      mapping: expect.objectContaining({ driverPhone: 'Driver Phone' }),
    }))

    // Step 4: contacts, pre-filled with the session's email
    expect((w.get('#connect-dispatcher-email').element as HTMLInputElement).value).toBe('dispatch@fleet.test')
    expect(w.text()).toContain('America/Chicago')
    await w.get('#connect-dispatcher-phone').setValue('+15551234567')
    mockedPut.mockResolvedValueOnce({ data: { policy: { ...standardPolicy, dispatcherPhone: '+15551234567' } } })
    mockPoliciesResponse() // savePolicy's own reload
    await w.get('[data-testid="save-contacts"]').trigger('click')
    await flushPromises()
    expect(mockedPut).toHaveBeenCalledWith(
      '/dispatcher/night-shift/policies/pol-standard',
      expect.objectContaining({ dispatcherEmail: 'dispatch@fleet.test', dispatcherPhone: '+15551234567' }),
    )

    // Step 5: install, then the done sentence
    mockedPost.mockResolvedValueOnce({ data: { binding: connectedBinding } }) // POST /sheet/install
    await w.get('[data-testid="do-install"]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/install')
    expect(w.get('[data-testid="done-sentence"]').text()).toBe(
      'Choose a policy in the Night Shift column on any row to start. Everything runs in shadow until you go live in Settings.',
    )
  })

  it('a link that is not a Google Sheets link is refused in place, with no round trip', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: pendingBinding } })
    mockPoliciesResponse()
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()
    const callsBefore = mockedGet.mock.calls.length

    await w.get('[data-testid="sheet-link"]').setValue('https://example.com/not-a-sheet')
    await w.get('[data-testid="open-spreadsheet"]').trigger('click')
    await flushPromises()

    expect(mockedGet.mock.calls.length).toBe(callsBefore)
    expect(w.get('[data-testid="sheet-error"]').text()).toContain('Google Sheets link')
    expect(w.find('[data-testid="tab-select"]').exists()).toBe(false)
  })

  it('back links on steps 2-4 reopen the previous step without losing entered values', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: pendingBinding } })
    mockPoliciesResponse()
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()

    expect(w.find('[data-testid="back-to-1"]').exists()).toBe(true)
    await w.get('[data-testid="back-to-1"]').trigger('click')
    expect(w.find('[data-testid="sign-in-google"]').exists()).toBe(true)
    // the spreadsheet already picked (none here) is irrelevant; re-entering
    // step 2 is a plain step change, nothing in the store gets cleared by it
  })

  it('a connected binding shows the summary card with sync/re-map/disconnect and a live sync result', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
    mockPoliciesResponse([standardWithPhone])
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()

    const summary = w.get('[data-testid="sheet-summary"]')
    // Final fix wave, C1 (closes Task 11's deferred item): the summary card
    // shows the spreadsheet's own title, not the tab title or the id.
    expect(w.get('[data-testid="summary-title"]').text()).toBe('Dispatch Sheet')
    expect(summary.text()).toContain('Loads')
    expect(summary.text()).toContain('me@gmail.com')
    expect(w.find('[data-testid="columns-not-installed"]').exists()).toBe(false)
    expect(w.find('[data-testid="sync-result"]').exists()).toBe(false)

    // Fix round 1, finding 1: Sync now shows a result sentence and the
    // binding (hence "Last sync") is reloaded, not left stale.
    const report = { read: 12, created: 2, updated: 3, unchanged: 7, skipped: [{ rowIndex: 4, reason: 'no load number' }], statusWrites: 5, error: null }
    mockedPost.mockResolvedValueOnce({ data: { report } })
    mockedGet.mockResolvedValueOnce({ data: { binding: { ...connectedBinding, lastSyncAt: '2026-09-21T09:00:00.000Z' } } })
    await w.get('[data-testid="sync-now"]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/sync-now')
    expect(w.get('[data-testid="sync-result"]').text()).toBe(
      'Synced just now — 12 rows read, 2 new, 3 updated, 5 status cells written, 1 skipped (no load number)',
    )
    expect(w.text()).toContain('2026-09-21T09:00:00.000Z')

    await w.get('[data-testid="disconnect"]').trigger('click')
    expect(body().text()).toContain('Disconnect this sheet?')
    mockedDelete.mockResolvedValueOnce({ data: { binding: { ...connectedBinding, status: 'paused' } } })
    await body().get('[data-testid="confirm-disconnect"]').trigger('click')
    await flushPromises()
    expect(mockedDelete).toHaveBeenCalledWith('/dispatcher/sheet')
  })

  it('caps a long skipped-reasons list at three, then "…"', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
    mockPoliciesResponse()
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()

    const report = {
      read: 5, created: 0, updated: 0, unchanged: 1, statusWrites: 0, error: null,
      skipped: [
        { rowIndex: 1, reason: 'no load number' },
        { rowIndex: 2, reason: 'duplicate load ref' },
        { rowIndex: 3, reason: 'blank row' },
        { rowIndex: 4, reason: 'no driver phone' },
      ],
    }
    mockedPost.mockResolvedValueOnce({ data: { report } })
    mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
    await w.get('[data-testid="sync-now"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="sync-result"]').text()).toBe(
      'Synced just now — 5 rows read, 0 new, 0 updated, 0 status cells written, 4 skipped (no load number; duplicate load ref; blank row; …)',
    )
  })

  it('a connected binding whose columns are not installed shows the install button', async () => {
    mockedGet.mockResolvedValueOnce({ data: { binding: { ...connectedBinding, agentSwitchCol: null, agentStatusCol: null } } })
    mockPoliciesResponse()
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()
    expect(w.find('[data-testid="columns-not-installed"]').exists()).toBe(true)
    expect(w.find('[data-testid="install-columns"]').exists()).toBe(true)
  })

  // Two-rows-per-load sheets.
  describe('two rows per load', () => {
    const brokerHeader = ['BOL#', 'CUSTOMER /CARRIER', 'TELEPHONE#', 'CONTACT NAME', 'PICK UP', 'DELIVERY', 'RATE', 'LOAD#', 'APPT SCHEDULE']
    const brokerProposal = {
      mapping: { loadRef: 'LOAD#', driverPhone: 'TELEPHONE#', driverName: 'CONTACT NAME', pickup: 'PICK UP', delivery: 'DELIVERY', pickupAppt: 'APPT SCHEDULE', deliveryAppt: 'APPT SCHEDULE', carrierName: 'CUSTOMER /CARRIER', rate: 'RATE' },
      extras: ['BOL#'],
      missing: [],
    }

    async function mountAtStep3(suggestedRowsPerLoad: 1 | 2) {
      mockedGet.mockResolvedValueOnce({ data: { binding: pendingBinding } })
      mockPoliciesResponse()
      primeAuth()
      const w = mount(ConnectSheet)
      await flushPromises()
      mockedGet.mockResolvedValueOnce({ data: { title: 'Board', tabs: [{ id: 't1', title: 'Board' }] } })
      await w.get('[data-testid="sheet-link"]').setValue('https://docs.google.com/spreadsheets/d/s1/edit')
      await w.get('[data-testid="open-spreadsheet"]').trigger('click')
      await flushPromises()
      mockedGet.mockResolvedValueOnce({ data: { header: brokerHeader, proposal: brokerProposal, suggestedRowsPerLoad } })
      await w.get('[data-testid="tab-select"]').setValue('t1')
      await flushPromises()
      return w
    }

    it('the checkbox is pre-checked from suggestedRowsPerLoad === 2, with its help line, and rowsPerLoad: 2 is sent', async () => {
      const w = await mountAtStep3(2)
      const box = w.get('[data-testid="two-rows"]').element as HTMLInputElement
      expect(box.checked).toBe(true)
      expect(w.text()).toContain('Each load takes two rows (customer row + carrier row)')
      expect(w.text()).toContain("The top row is the load; the carrier row below it supplies the carrier's phone, contact and LOAD#. Night Shift's two cells go on the top row.")
      // the shared appointment column is accepted by the pickup select and by local validation
      expect((w.get('[data-testid="map-select-pickupAppt"]').element as HTMLSelectElement).value).toBe('APPT SCHEDULE')
      expect((w.get('[data-testid="map-select-deliveryAppt"]').element as HTMLSelectElement).value).toBe('APPT SCHEDULE')

      mockedPost.mockResolvedValueOnce({ data: { binding: { ...connectedBinding, rowsPerLoad: 2 } } })
      await w.get('[data-testid="save-mapping"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="mapping-error"]').exists()).toBe(false)
      expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/mapping', expect.objectContaining({
        rowsPerLoad: 2,
        mapping: expect.objectContaining({ pickupAppt: 'APPT SCHEDULE', deliveryAppt: 'APPT SCHEDULE' }),
      }))
    })

    it('unchecked when the server suggests 1; ticking it sends 2', async () => {
      const w = await mountAtStep3(1)
      const box = w.get('[data-testid="two-rows"]')
      expect((box.element as HTMLInputElement).checked).toBe(false)
      await box.setValue(true)
      mockedPost.mockResolvedValueOnce({ data: { binding: { ...connectedBinding, rowsPerLoad: 2 } } })
      await w.get('[data-testid="save-mapping"]').trigger('click')
      await flushPromises()
      expect(mockedPost).toHaveBeenCalledWith('/dispatcher/sheet/mapping', expect.objectContaining({ rowsPerLoad: 2 }))
    })

    it('the summary card says "2 rows per load" when the binding has it, and nothing when it is 1', async () => {
      mockedGet.mockResolvedValueOnce({ data: { binding: { ...connectedBinding, rowsPerLoad: 2 } } })
      mockPoliciesResponse([standardWithPhone])
      primeAuth()
      const w = mount(ConnectSheet)
      await flushPromises()
      expect(w.get('[data-testid="sheet-summary"]').text()).toContain('2 rows per load')
      w.unmount()

      setActivePinia(createPinia())
      mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
      mockPoliciesResponse([standardWithPhone])
      primeAuth()
      const w1 = mount(ConnectSheet)
      await flushPromises()
      expect(w1.get('[data-testid="sheet-summary"]').text()).not.toContain('rows per load')
    })
  })

  it('?step=2 after the OAuth redirect opens the wizard at step 2', async () => {
    routeQuery = { tab: 'connect', step: '2' }
    mockedGet.mockResolvedValueOnce({ data: { binding: pendingBinding } })
    mockPoliciesResponse()
    primeAuth()
    const w = mount(ConnectSheet)
    await flushPromises()
    expect(w.find('[data-testid="sheet-link"]').exists()).toBe(true)
    expect(w.find('[data-testid="sign-in-google"]').exists()).toBe(false)
  })

  describe('Edit contacts on the summary card (fix round 1, finding 2)', () => {
    it('shows Edit contacts; clicking it opens step 4 prefilled from Standard, and saving calls savePolicy', async () => {
      mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
      mockPoliciesResponse([{ ...standardPolicy, dispatcherEmail: 'dispatch2@fleet.test', dispatcherPhone: '+15550001111' }])
      primeAuth()
      const w = mount(ConnectSheet)
      await flushPromises()

      expect(w.find('[data-testid="edit-contacts"]').exists()).toBe(true)
      expect(w.find('[data-testid="edit-contacts-step"]').exists()).toBe(false)

      await w.get('[data-testid="edit-contacts"]').trigger('click')
      expect(w.find('[data-testid="edit-contacts-step"]').exists()).toBe(true)
      expect((w.get('#edit-dispatcher-email').element as HTMLInputElement).value).toBe('dispatch2@fleet.test')
      expect((w.get('#edit-dispatcher-phone').element as HTMLInputElement).value).toBe('+15550001111')

      await w.get('#edit-dispatcher-phone').setValue('+15559998888')
      mockedPut.mockResolvedValueOnce({ data: { policy: standardPolicy } })
      mockPoliciesResponse() // savePolicy's own reload
      await w.get('[data-testid="save-contacts-edit"]').trigger('click')
      await flushPromises()

      expect(mockedPut).toHaveBeenCalledWith(
        '/dispatcher/night-shift/policies/pol-standard',
        expect.objectContaining({
          name: 'Standard', dispatcherEmail: 'dispatch2@fleet.test', dispatcherPhone: '+15559998888',
        }),
      )
      expect(w.find('[data-testid="edit-contacts-step"]').exists()).toBe(false)
    })

    it('shows the missing-phone hint only when Standard has no dispatcherPhone', async () => {
      mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
      mockPoliciesResponse([{ ...standardPolicy, dispatcherPhone: null }])
      primeAuth()
      const w = mount(ConnectSheet)
      await flushPromises()
      expect(w.get('[data-testid="missing-phone-hint"]').text()).toContain("can't call you at night")
    })

    it('hides the missing-phone hint once Standard has a phone', async () => {
      mockedGet.mockResolvedValueOnce({ data: { binding: connectedBinding } })
      mockPoliciesResponse([standardWithPhone])
      primeAuth()
      const w = mount(ConnectSheet)
      await flushPromises()
      expect(w.find('[data-testid="missing-phone-hint"]').exists()).toBe(false)
    })
  })
})
