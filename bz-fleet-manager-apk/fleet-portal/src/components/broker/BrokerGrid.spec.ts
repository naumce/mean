import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'

// Task 6: BrokerGrid now reads useBrokerBoardStore (the AGENT switch's
// stale-reload) and, through AgentSwitch, useNightShiftStore (the policy
// picker) — both need an active Pinia, and the store module needs its `api`
// mocked so AgentSwitch's onMounted policy fetch never reaches a real
// server. Everything else from lib/api stays real (BrokerGrid only imports
// its types).
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { get: vi.fn().mockResolvedValue({ data: { policies: [], loadsByPolicy: {} } }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'rate', label: 'RATE' }, { key: 'agent', label: 'AGENT' },
]
const mk = (id: string, bol: string, rate: string, carrier: string | null): BoardLoad =>
  ({ id, line: 1, top: { bol, customer: 'ACME', rate }, bottom: carrier ? { customer: carrier } : null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol), version: 0 })
const loads = [mk('a', '1', '$900.00', 'BLUE'), mk('b', '2', '$4,000.00', null), mk('c', '3', '$2,000.00', 'RED')]

// jsdom has no layout: the virtualizer is given a fixed viewport via the prop so all rows render.
const mountGrid = () => mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })

describe('BrokerGrid', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('renders their headers with a checkbox gutter and both rows of a pair', () => {
    const w = mountGrid()
    expect(w.findAll('thead th').map((t) => t.text()).slice(1)).toEqual(['BOL#', 'CUSTOMER /CARRIER', 'RATE', 'AGENT'])
    expect(w.findAll('tbody tr[data-row]')).toHaveLength(5)
    expect(w.findAll('tbody input[type="checkbox"]')).toHaveLength(3)
  })

  it('selects a pair as one, select-all selects every load, and emits the ids', async () => {
    const w = mountGrid()
    await w.findAll('tbody input[type="checkbox"]')[0].setValue(true)
    expect(w.emitted('update:selectedIds')?.at(-1)).toEqual([['a']])
    // Both physical lines of one load carry the checked marking — a load is
    // one row to a dispatcher however many lines it is drawn on.
    expect(w.findAll('tr[data-load="a"]').every((tr) => tr.classes().includes('bb-checked'))).toBe(true)
    await w.find('thead input[type="checkbox"]').setValue(true)
    expect(w.emitted('update:selectedIds')?.at(-1)?.[0]).toHaveLength(3)
  })

  it('sorts by rate as money when the header is clicked, and flips on the second click', async () => {
    const w = mountGrid()
    const rateHeader = w.findAll('thead th')[3]
    await rateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['1', '3', '2'])
    expect(rateHeader.attributes('aria-sort')).toBe('ascending')
    await rateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['2', '3', '1'])
  })

  it('filters every cell of both rows with the search box', async () => {
    const w = mountGrid()
    await w.setProps({ search: 'red' })
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    expect(w.find('tbody tr[data-row="top"] td[data-col="bol"]').text()).toBe('3')
  })

  it('remembers a hidden column and resets to their layout', async () => {
    const w = mountGrid()
    await w.vm.$.exposed!.hideColumn('rate')
    await nextTick()
    expect(w.findAll('thead th').map((t) => t.text())).not.toContain('RATE')
    expect(JSON.parse(localStorage.getItem('brokerBoard.columns.v1')!).visibility.rate).toBe(false)
    await w.vm.$.exposed!.resetColumns()
    await nextTick()
    expect(w.findAll('thead th').map((t) => t.text())).toContain('RATE')
    expect(localStorage.getItem('brokerBoard.columns.v1')).toBeNull()
  })

  // Step 6 (break it): dropping the shift branch in onCheckClick leaves this
  // as the only spec that fails — everything above passes on setValue()
  // alone, which never carries a shiftKey.
  it('shift-clicks a range between the last checkbox clicked and this one, in visible order', async () => {
    const w = mountGrid()
    const checkboxes = () => w.findAll('tbody input[type="checkbox"]')
    await checkboxes()[0].trigger('click')
    await checkboxes()[2].trigger('click', { shiftKey: true })
    expect(w.emitted('update:selectedIds')?.at(-1)?.[0]).toHaveLength(3)
    expect(w.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual(expect.arrayContaining(['a', 'b', 'c']))
  })

  // Fix round 1, Finding 1 (HIGH): a blank RATE must render last whether the
  // column is sorted ascending or descending — end-to-end proof that
  // sortUndefined: 'last' (not a hand-rolled nulls-last comparator, which
  // TanStack's descending negation would flip) actually holds through a
  // real header click and a real render.
  it('keeps a blank RATE last in both sort directions', async () => {
    const rateLayout: BoardColumn[] = [{ key: 'bol', label: 'BOL#' }, { key: 'rate', label: 'RATE' }]
    const rateLoads = [
      { id: 'x', line: 1, top: { bol: '1', rate: '$900.00' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 1 },
      { id: 'y', line: 2, top: { bol: '2', rate: '$4,000.00' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 2 },
      { id: 'z', line: 3, top: { bol: '3', rate: '' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 3 },
    ] as BoardLoad[]
    const w = mount(BrokerGrid, { props: { layout: rateLayout, loads: rateLoads, viewportHeight: 10_000 } })
    const rateHeader = w.findAll('thead th')[2]   // checkbox, BOL#, RATE
    await rateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['1', '2', '3'])   // asc: 900, 4000, blank
    await rateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['2', '1', '3'])   // desc: 4000, 900, blank — still last
  })

  it('keeps a blank SHIP DATE last in both sort directions', async () => {
    const dateLayout: BoardColumn[] = [{ key: 'bol', label: 'BOL#' }, { key: 'shipDate', label: 'SHIP DATE' }]
    const dateLoads = [
      { id: 'x', line: 1, top: { bol: '1', shipDate: '7/13/2026' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 1 },
      { id: 'y', line: 2, top: { bol: '2', shipDate: '12/1/2026' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 2 },
      { id: 'z', line: 3, top: { bol: '3', shipDate: '' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 3 },
    ] as BoardLoad[]
    const w = mount(BrokerGrid, { props: { layout: dateLayout, loads: dateLoads, viewportHeight: 10_000 } })
    const dateHeader = w.findAll('thead th')[2]
    await dateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['1', '2', '3'])
    await dateHeader.find('button').trigger('click')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['2', '1', '3'])
  })

  // Fix round 1, Finding 2 (MEDIUM): two `extra` columns sharing a label
  // used to collide on the same TanStack column id (duplicate v-for keys,
  // one header silently standing in for both). Now each gets its layout
  // index baked into the id, so both render.
  it('renders two distinct header cells for duplicate extra columns', () => {
    const dupLayout: BoardColumn[] = [{ key: 'bol', label: 'BOL#' }, { key: 'extra', label: 'NOTES' }, { key: 'extra', label: 'NOTES' }]
    const dupLoads = [mk('a', '1', '$900.00', 'BLUE')]
    const w = mount(BrokerGrid, { props: { layout: dupLayout, loads: dupLoads, viewportHeight: 10_000 } })
    expect(w.findAll('thead th').map((t) => t.text()).filter((t) => t === 'NOTES')).toHaveLength(2)
  })

  // Task 6: the filter row's per-column text inputs combine (AND) with each
  // other and, via the same TanStack filtered row model, with the search
  // box; moveColumn(id, dir) swaps the column with its neighbor and the new
  // order renders.
  it('filters one column with the filter row and reorders columns', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, showFilters: true } })
    await w.find('thead tr[data-filters] input[data-filter="customer"]').setValue('red')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    await w.vm.$.exposed!.moveColumn('rate', -1)
    await nextTick()
    expect(w.findAll('thead tr:first-child th').map((t) => t.text()).slice(1)).toEqual(['BOL#', 'RATE', 'CUSTOMER /CARRIER', 'AGENT'])
  })

  // Task 6: the hidden `status` column drives the status filter. The grid
  // itself doesn't know whether the server included archived rows at all —
  // it just filters whatever loads it was handed by `status`.
  it('hides archived loads from the status filter and shows them when asked', async () => {
    const withArchived = [...loads, { ...mk('d', '4', '$1.00', null), status: 'archived' }]
    const w = mount(BrokerGrid, { props: { layout, loads: withArchived, viewportHeight: 10_000, statusFilter: 'archived' } })
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['4'])
  })

  // Fix round 1, Finding 2 (HIGH): turning "Filters" off is the only
  // affordance a dispatcher has for a still-active per-column filter — it
  // must actually clear the row-narrowing, not just hide the input that set
  // it (an invisible filter reads as "loads vanished" on a live ops board).
  // The status filter is a separate channel (driven by the status <select>,
  // not the filter row) and must survive the same toggle.
  it('clears the per-column filters when Filters is turned off', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, showFilters: true } })
    await w.find('thead tr[data-filters] input[data-filter="customer"]').setValue('red')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    await w.setProps({ showFilters: false })
    // Final review finding 7: `setProps` + a single `nextTick` is one flush
    // short of the showFilters watcher's resetColumnFilters() propagating
    // through vue-table's own watchEffect into the rendered row model — the
    // assertion below saw 1 row instead of 3 on a loaded machine. Drain the
    // microtask queue first, then let Vue re-render.
    await flushPromises()
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(3)
  })

  it('keeps the status filter through a Filters toggle', async () => {
    const withArchived = [...loads, { ...mk('d', '4', '$1.00', null), status: 'archived' }]
    const w = mount(BrokerGrid, { props: { layout, loads: withArchived, viewportHeight: 10_000, showFilters: true, statusFilter: 'archived' } })
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    await w.setProps({ showFilters: false })
    await flushPromises()
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['4'])
    await w.setProps({ showFilters: true })
    await flushPromises()
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['4'])
  })

  // Fix round 1, Finding 3 (MEDIUM): same failure mode as Finding 2, but
  // triggered by hiding a column via ColumnTools instead of the Filters
  // toggle — a filter on a column with no remaining header or filter-row
  // input left no way to see or clear it.
  it("clears a column's own filter when it is hidden", async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, showFilters: true } })
    await w.find('thead tr[data-filters] input[data-filter="customer"]').setValue('red')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(1)
    await w.vm.$.exposed!.toggleColumn('customer')
    await nextTick()
    expect(w.findAll('tbody tr[data-row="top"]')).toHaveLength(3)
  })

  // Fix round 1, Finding 1 (MEDIUM): `toggleColumn`/`moveColumn` take a bare
  // string id, so `status` is reachable even though ColumnTools never lists
  // it. Making it visible has no `layout` entry for the header to render
  // (crash) and would persist `status: true`, permanently breaking every
  // future mount until Reset — both must be no-ops for `status`.
  it('never toggles visibility or reorders the hidden status column', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 } })
    expect(() => w.vm.$.exposed!.toggleColumn('status')).not.toThrow()
    expect(() => w.vm.$.exposed!.moveColumn('status', -1)).not.toThrow()
    await nextTick()
    expect(w.vm.$.exposed!.table.getColumn('status')?.getIsVisible()).toBe(false)
    expect(localStorage.getItem('brokerBoard.columns.v1')).toBeNull()
  })
  // Final review finding 1 (CRITICAL): TanStack never prunes `rowSelection`
  // when `data` changes, and neither did we — a load that was selected and
  // then left the board (Show archived off, a reload without it) stayed in
  // the selection, was NOT named in the delete confirmation (which reads
  // `store.loads`), and was still deleted. The selection has to be
  // reconciled against the loads the grid actually holds.
  it('drops a selected load from the selection when it leaves the board', async () => {
    const w = mountGrid()
    await w.find('thead input[type="checkbox"]').setValue(true)
    await nextTick()
    expect(w.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual(['a', 'b', 'c'])
    await w.setProps({ loads: [loads[0], loads[2]] })
    await flushPromises()
    await nextTick()
    expect(w.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual(['a', 'c'])
    expect(w.findAll('tbody input[type="checkbox"]').every((cb) => (cb.element as HTMLInputElement).checked)).toBe(true)
  })

  // Final review finding 2 (IMPORTANT): the money/date columns hand TanStack
  // a number for sorting, so the `auto` filter resolved to inNumberRange and
  // a typed rate emptied the board with no explanation. The filter now reads
  // the rendered text a dispatcher can see.
  it('filters RATE by what the cell says, with or without the comma', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, showFilters: true } })
    for (const typed of ['4,000', '4000', '$4,0']) {
      await w.find('thead tr[data-filters] input[data-filter="rate"]').setValue(typed)
      await flushPromises()
      await nextTick()
      expect(w.findAll('tbody tr[data-row="top"]').map((tr) => tr.find('td[data-col="bol"]').text())).toEqual(['2'])
    }
  })

  // Final review finding 3 (IMPORTANT): the spread order was
  // `{ status: false, ...prefs.visibility }`, so a stored `status: true`
  // won — the header render then threw on a column with no layout entry and
  // the whole page was a stack trace until someone cleared storage.
  it('never lets a stored status:true surface the hidden helper column', async () => {
    localStorage.setItem('brokerBoard.columns.v1', JSON.stringify({ visibility: { status: true }, order: [], sizing: {}, density: 'theirs' }))
    const w = mountGrid()
    await nextTick()
    expect(w.vm.$.exposed!.table.getColumn('status')?.getIsVisible()).toBe(false)
    expect(w.findAll('thead th').map((t) => t.text()).slice(1)).toEqual(['BOL#', 'CUSTOMER /CARRIER', 'RATE', 'AGENT'])
  })

  // Final review finding 4 (IMPORTANT): `estimateSize` was a flat row height
  // per LOAD, but a load with no carrier row is half that — and because
  // `estimateSize` is not a dependency of virtual-core's measurement memo,
  // a density change never re-measured at all (stale padding and scrollbar
  // for the rest of the session).
  it('estimates a single-row load as half a pair and re-measures on a density change', async () => {
    const w = mountGrid()
    await nextTick()
    const pairs = 2, singles = 1   // a + c have a carrier row, b does not
    // 27 and 21 are LINE_PX in the component, and CSS is pinned to the same
    // two numbers (`--bb-line`). They were 29 and 22 while the DOM actually
    // rendered 17.25px lines: the scrollbar promised half again as much board
    // as existed, and the fractional line dropped the 1px separator between
    // three loads out of every four.
    const theirs = w.vm.$.exposed!.totalSize.value as number
    expect(theirs).toBeLessThan(3 * 54)                      // not a flat pair-height per load
    expect(theirs).toBe((pairs * 2 + singles) * 27)
    await w.vm.$.exposed!.setDensity('tight')
    await flushPromises()
    await nextTick()
    expect(w.vm.$.exposed!.totalSize.value).toBe((pairs * 2 + singles) * 21)
  })

  // Final review finding 5 (IMPORTANT): a `position: sticky` cell with no
  // background paints over — and lets through — the text of every column
  // sliding underneath it. The board is 16+ columns wide and always scrolls
  // sideways, so this hit the one column a dispatcher pins.
  it('gives the sticky BOL cell and the checkbox gutter a background of their own', async () => {
    const w = mountGrid()
    // Asserted as an INLINE background rather than a class: a scoped
    // stylesheet is not applied in jsdom, so a class assertion here would
    // pass while the real cell rendered transparent. Every cell paints
    // itself (see cellStyle) precisely so the pinned column cannot bleed.
    expect(w.find('tbody td[data-col="bol"]').attributes('style')).toContain('background')
    expect(w.find('tbody td:first-child').classes()).toContain('bb-gutter')
    await w.findAll('tbody input[type="checkbox"]')[0].setValue(true)
    await nextTick()
    expect(w.find('tr[data-load="a"]').classes()).toContain('bb-checked')
  })

  // NIT 9: the bulk bar needs to say how much of the selection the current
  // search/filters are hiding, so the grid publishes the filtered row ids.
  it('exposes the ids of the rows the current search leaves visible', async () => {
    const w = mountGrid()
    expect(w.vm.$.exposed!.visibleIds.value).toEqual(['a', 'b', 'c'])
    await w.setProps({ search: 'red' })
    await flushPromises()
    await nextTick()
    expect(w.vm.$.exposed!.visibleIds.value).toEqual(['c'])
  })
})
