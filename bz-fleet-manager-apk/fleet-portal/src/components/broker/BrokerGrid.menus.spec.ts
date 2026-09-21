import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'
import BulkBar from './BulkBar.vue'

// Task 6: BrokerGrid now reads useBrokerBoardStore/useNightShiftStore (the
// AGENT switch) — both need an active Pinia, and the store module's `api`
// is mocked so the switch's onMounted policy fetch never reaches a server.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { get: vi.fn().mockResolvedValue({ data: { policies: [], loadsByPolicy: {} } }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

// The menus: Excel's value filter, and the right-click on a row.
const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'rate', label: 'RATE' },
]
const mk = (id: string, bol: string, customer: string, rate: string): BoardLoad =>
  ({ id, line: 1, top: { bol, customer, rate }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol), version: 0 })
const loads = [mk('a', '1', 'ACME', '$4,000.00'), mk('b', '2', 'BETA', '$2,000.00'), mk('c', '3', 'ACME', '$1,000.00')]
const mountGrid = (props: Record<string, unknown> = {}) =>
  mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, ...props }, attachTo: document.body })

const openFilter = async (w: ReturnType<typeof mountGrid>, columnId: string) => {
  await w.find(`[data-filter-button="${columnId}"]`).trigger('click')
  await nextTick()
}

describe('the value filter', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('lists every value in the column with how many rows hold it', async () => {
    const w = mountGrid()
    await openFilter(w, 'customer')
    const values = w.findAll('[data-filter-value]').map((v) => v.text())
    expect(values).toEqual(['ACME2', 'BETA1'])
  })

  it('narrows the board to the values left ticked', async () => {
    const w = mountGrid()
    await openFilter(w, 'customer')
    await w.find('[data-filter-value="BETA"] input').setValue(false)
    await nextTick()
    expect(w.findAll('tr[data-load]').map((r) => r.attributes('data-load'))).toEqual(['a', 'c'])
  })

  it('keeps SEVERAL values when one of three is unticked', async () => {
    // Two values was not enough to catch the real bug: unticking one leaves a
    // one-element array, and TanStack's default filter stringifies that to the
    // single value, which matches by accident. With three, the array becomes
    // "ACME,BETA" and the default filter matched NOTHING — the live board went
    // blank the moment a dispatcher unticked anything.
    const w = mountGrid({ loads: [...loads, mk('d', '4', 'GAMMA', '$500.00')] })
    await openFilter(w, 'customer')
    await w.find('[data-filter-value="GAMMA"] input').setValue(false)
    await nextTick()
    expect(w.findAll('tr[data-load]').map((r) => r.attributes('data-load'))).toEqual(['a', 'b', 'c'])
  })

  it('counts what the OTHER filters left, not what its own filter left', async () => {
    // Unticking BETA must not make BETA disappear from the list that
    // unticked it — otherwise there is no way to tick it back on.
    const w = mountGrid()
    await openFilter(w, 'customer')
    await w.find('[data-filter-value="BETA"] input').setValue(false)
    await nextTick()
    expect(w.findAll('[data-filter-value]').map((v) => v.text())).toEqual(['ACME2', 'BETA1'])
  })

  it('searches the value list', async () => {
    const w = mountGrid()
    await openFilter(w, 'customer')
    await w.find('[data-filter-search]').setValue('bet')
    await nextTick()
    expect(w.findAll('[data-filter-value]').map((v) => v.text())).toEqual(['BETA1'])
  })

  it('stores nothing when every value is ticked — a pill for a board nobody narrowed', async () => {
    const w = mountGrid()
    await openFilter(w, 'customer')
    await w.find('[data-filter-value="BETA"] input').setValue(false)
    await nextTick()
    await w.find('[data-filter-value="BETA"] input').setValue(true)
    await nextTick()
    expect((w.vm as unknown as { activeFilters: number }).activeFilters).toBe(0)
  })

  it('clears the column from inside the popover', async () => {
    const w = mountGrid()
    await openFilter(w, 'customer')
    await w.find('[data-filter-value="BETA"] input').setValue(false)
    await nextTick()
    expect(w.findAll('tr[data-load]')).toHaveLength(2)
    // The popover is still open — unticking a value does not close it, so a
    // dispatcher can untick several before deciding to clear the lot.
    await w.find('[data-filter-clear]').trigger('click')
    await nextTick()
    expect(w.findAll('tr[data-load]')).toHaveLength(3)
  })
})

describe('the row menu', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('opens on the row that was right-clicked, and selects it first', async () => {
    const w = mountGrid()
    await w.find('tr[data-load="b"] td[data-col="customer"]').trigger('contextmenu')
    await nextTick()
    expect(w.find('[data-row-menu]').exists()).toBe(true)
    expect(w.find('tr[data-load="b"] td[data-col="customer"]').classes()).toContain('bb-anchor')
  })

  it('paints from the menu', async () => {
    const w = mountGrid()
    await w.find('tr[data-load="b"] td[data-col="customer"]').trigger('contextmenu')
    await nextTick()
    await w.find('[data-row-swatch="#cdf2c8"]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    const next = w.emitted('view')?.[0][0] as { fills: { cell?: Record<string, string> } }
    expect(next.fills.cell).toEqual({ 'b|customer': '#cdf2c8' })
  })

  it('asks for a delete rather than doing one', async () => {
    const w = mountGrid()
    await w.find('tr[data-load="b"] td[data-col="customer"]').trigger('contextmenu')
    await nextTick()
    await w.find('[data-row-delete]').trigger('click')
    expect(w.emitted('delete-rows')?.[0][0]).toEqual(['b'])
    expect(w.find('[data-row-menu]').exists()).toBe(false)
  })

  it('closes on Escape', async () => {
    const w = mountGrid()
    await w.find('tr[data-load="b"] td[data-col="customer"]').trigger('contextmenu')
    await nextTick()
    await w.find('[data-grid-scroller]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(w.find('[data-row-menu]').exists()).toBe(false)
  })
})

describe('setting UPDATE for a selection', () => {
  it('stamps today onto DELIVERED and passes the rest through', async () => {
    const w = mount(BulkBar, { props: { count: 2, busy: false } })
    const select = w.find('[data-action="set-update"]')
    await select.setValue('DELIVERED')
    const today = new Date()
    expect(w.emitted('set-update')?.[0][0]).toBe(`DELIVERED ${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`)
    await select.setValue('WAITING')
    expect(w.emitted('set-update')?.[1][0]).toBe('WAITING')
  })

  it('clears the cell rather than writing the word "(clear)"', async () => {
    const w = mount(BulkBar, { props: { count: 1, busy: false } })
    await w.find('[data-action="set-update"]').setValue('(clear)')
    expect(w.emitted('set-update')?.[0][0]).toBe('')
  })

  it('says nothing when the placeholder is chosen', async () => {
    const w = mount(BulkBar, { props: { count: 1, busy: false } })
    await w.find('[data-action="set-update"]').setValue('')
    expect(w.emitted('set-update')).toBeUndefined()
  })
})
