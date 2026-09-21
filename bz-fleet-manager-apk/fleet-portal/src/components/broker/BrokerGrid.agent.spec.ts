import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import type { LoadLock } from '../../lib/api'
import { useSheetStore } from '../../nightshift/stores/sheet'
import BrokerGrid from './BrokerGrid.vue'

// Night Shift on the Board, Task 6, Step 1: the AGENT column shows the pill
// and the switch, and the UPDATE cell keeps the agent's latest line under
// the human's own text (spec §6.2).
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'update', label: '****UPDATE****' }, { key: 'agent', label: 'AGENT' },
]
const mk = (id: string, over: Partial<BoardLoad> = {}): BoardLoad => ({
  id, line: 1, top: { bol: '1', customer: 'ACME', update: 'DELIVERED 07/15/2026' }, bottom: null,
  pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 1, version: 2,
  agentEnabled: false, agentPolicyId: null, agentPill: 'off',
  ...over,
})
const standardPolicy = {
  id: 'pol-standard', name: 'Standard', stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60, offRouteMi: 3.1,
  offRouteMin: 10, rungGapMin: 5, maxCalls: 2, dispatcherEmail: 'd@fleet.test', dispatcherPhone: null,
  customerEmailOn: false, shadow: true, bossCallOn: true, quietFrom: null, quietTo: null,
}

describe('the agent pill and switch on the AGENT column', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedGet.mockResolvedValue({ data: { policies: [standardPolicy], loadsByPolicy: {} } })
  })

  it('renders the pill from agentPill/agentLine and the switch reflecting agentEnabled', async () => {
    const loads = [mk('a', { agentPill: 'watching', agentEnabled: true, agentPolicyId: 'pol-standard', agentLine: { text: 'EN ROUTE — 40 mi out', atMs: 1 } })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    expect(w.get('[data-agent-pill]').text()).toBe('Watching')
    expect(w.get('[data-agent-switch]').attributes('aria-checked')).toBe('true')
  })

  it('keeps the agent line under the human UPDATE text, never replacing it', async () => {
    const loads = [mk('a', { agentLine: { text: 'STOPPED 25 min near Bethany, asked driver', atMs: 1 } })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    const updateCell = w.find('td[data-col="update"]')
    expect(updateCell.text()).toContain('DELIVERED 07/15/2026')
    expect(updateCell.get('[data-agent-line]').text()).toContain('STOPPED 25 min near Bethany, asked driver')
  })

  it('shows no agent line under UPDATE when there is none', async () => {
    const loads = [mk('a')]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    expect(w.find('td[data-col="update"] [data-agent-line]').exists()).toBe(false)
  })

  it('clicking the pill emits open-agent with the load id, not a cell edit', async () => {
    const loads = [mk('a', { agentPill: 'asked' })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    await w.get('[data-agent-pill]').trigger('click')
    expect(w.emitted('open-agent')).toEqual([['a']])
    expect(w.find('[data-cell-editor]').exists()).toBe(false)
  })

  it('a load someone else holds still shows the pill but disables the switch', async () => {
    const maria: LoadLock = { loadId: 'a', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: 61_001 }
    const loads = [mk('a', { agentPill: 'watching' })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, locks: { a: maria } } })
    await flushPromises()
    expect(w.find('[data-agent-pill]').exists()).toBe(true)
    expect(w.get('[data-agent-switch]').attributes('disabled')).toBeDefined()
  })

  it('Task 11: a connected sheet binding disables the switch with the sheet-column title', async () => {
    const sheetStore = useSheetStore()
    sheetStore.binding = {
      id: 'b1', spreadsheetId: 's1', spreadsheetTitle: 'Dispatch Sheet', tabId: 't1', tabTitle: 'Loads', headerRow: 1, columns: {},
      agentSwitchCol: 'K', agentStatusCol: 'L', accountEmail: 'me@gmail.com',
      lastSyncAt: null, lastError: null, status: 'connected',
    }
    const loads = [mk('a', { agentPill: 'off' })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    const sw = w.get('[data-agent-switch]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(sw.attributes('title')).toBe('Change it in the Night Shift column of your sheet')
  })

  it('Task 11: with no sheet binding connected, the switch stays enabled', async () => {
    const loads = [mk('a', { agentPill: 'off' })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    expect(w.get('[data-agent-switch]').attributes('disabled')).toBeUndefined()
  })

  it('turning the switch on flips it through the nightShift store with the row\'s version', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 3 } })
    const loads = [mk('a', { version: 2 })]
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    await flushPromises()
    await w.get('[data-agent-switch]').trigger('click')
    await w.get('[data-agent-policy-picker] [data-confirm]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/a/agent', { enabled: true, policyId: 'pol-standard', baseVersion: 2 })
  })
})
