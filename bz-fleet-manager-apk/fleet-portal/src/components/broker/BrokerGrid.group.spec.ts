import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'

// Task 6: BrokerGrid now reads useBrokerBoardStore/useNightShiftStore (the
// AGENT switch) — both need an active Pinia, and the store module's `api`
// is mocked so the switch's onMounted policy fetch never reaches a server.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { get: vi.fn().mockResolvedValue({ data: { policies: [], loadsByPolicy: {} } }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

// Grouping, frozen columns, the header menu and the CSV — the parts of the
// handoff that change what the board LOOKS like rather than what it stores.
const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'shipDate', label: 'SHIP DATE' }, { key: 'rate', label: 'RATE' },
]
const mk = (id: string, bol: string, customer: string, ship: string, rate: string, carrier: string | null): BoardLoad =>
  ({ id, line: 1, top: { bol, customer, shipDate: ship, rate }, bottom: carrier ? { customer: carrier } : null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol), version: 0 })
const loads = [
  mk('a', '1', 'ACME', '7/13/2026', '$4,000.00', 'BLUE'),
  mk('b', '2', 'BETA', '7/13/2026', '$2,000.00', null),
  mk('c', '3', 'ACME', '7/14/2026', '$1,000.00', null),
]
const mountGrid = (props: Record<string, unknown> = {}) =>
  mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, ...props }, attachTo: document.body })

describe('grouping the board', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('puts a header over each group with its count and its money', async () => {
    const w = mountGrid({ groupBy: ['customer'] })
    await nextTick()
    const groups = w.findAll('tr[data-group]')
    expect(groups).toHaveLength(2)
    expect(groups[0].text()).toContain('ACME')
    expect(groups[0].text()).toContain('2 loads')
    expect(groups[0].find('[data-totals]').text()).toContain('Rate $5,000')
    expect(groups[0].find('[data-totals]').text()).toContain('Profit $0')
  })

  it('collapses a group by clicking it, and puts its loads back', async () => {
    const w = mountGrid({ groupBy: ['customer'] })
    await nextTick()
    expect(w.findAll('tr[data-load]').length).toBeGreaterThan(0)
    await w.find('tr[data-group] button').trigger('click')
    await nextTick()
    // ACME's two loads are gone; BETA's is not.
    expect(w.findAll('tr[data-load="a"]')).toHaveLength(0)
    expect(w.findAll('tr[data-load="b"]')).toHaveLength(1)
    await w.find('tr[data-group] button').trigger('click')
    await nextTick()
    expect(w.findAll('tr[data-load="a"]').length).toBeGreaterThan(0)
  })

  it('groups by CARRIER, which is the second line and not a column of its own', async () => {
    // Looking `carrier` up in the layout finds nothing — it is the bottom
    // line of CUSTOMER — and the grouping was silently dropped on the real
    // board while every other field worked.
    const w = mountGrid({ groupBy: ['carrier'] })
    await nextTick()
    const groups = w.findAll('tr[data-group]')
    expect(groups.length).toBeGreaterThan(0)
    expect(groups[0].text()).toContain('CARRIER')
    expect(groups.map((g) => g.text()).join(' ')).toContain('BLUE')
  })

  it('nests groups, indenting each level', async () => {
    const w = mountGrid({ groupBy: ['shipDate', 'customer'] })
    await nextTick()
    const levels = w.findAll('tr[data-group]').map((g) => g.attributes('data-level'))
    expect(levels).toEqual(['0', '1', '1', '0', '1'])
  })

  it('keeps the arrow keys on loads, never on a group header', async () => {
    const w = mountGrid({ groupBy: ['customer'] })
    await nextTick()
    // ACME holds a and c; BETA holds b. Moving down from the first load lands
    // on the next LOAD in display order, stepping over BETA's header.
    await w.find('tr[data-load="a"] td[data-col="bol"]').trigger('mousedown')
    await w.find('[data-grid-scroller]').trigger('keydown', { key: 'ArrowDown' })
    await w.find('[data-grid-scroller]').trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(w.find('tr[data-load="b"] td[data-col="bol"]').classes()).toContain('bb-anchor')
  })

  it('drops the selection when the grouping changes what a row index means', async () => {
    const w = mountGrid()
    await w.find('tr[data-load="a"] td[data-col="bol"]').trigger('mousedown')
    expect(w.find('.bb-anchor').exists()).toBe(true)
    await w.setProps({ groupBy: ['customer'] })
    await nextTick()
    expect(w.find('.bb-anchor').exists()).toBe(false)
  })
})

describe('frozen columns', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('pins the first column past the checkbox gutter by default', () => {
    const w = mountGrid()
    const first = w.find('tbody td[data-col="bol"]')
    expect(first.classes()).toContain('sticky')
    expect(first.attributes('style')).toContain('left: 48px')
    expect(w.find('tbody td[data-col="customer"]').classes()).not.toContain('sticky')
  })

  it('freezes up to the column the header menu was opened on', async () => {
    const w = mountGrid()
    await w.findAll('thead th')[2].trigger('contextmenu')
    await nextTick()
    await w.find('[data-header-menu] [data-freeze]').trigger('click')
    await nextTick()
    // BOL# and CUSTOMER are both pinned now, and CUSTOMER sits after BOL#.
    expect(w.find('tbody td[data-col="customer"]').classes()).toContain('sticky')
    expect(w.find('tbody td[data-col="customer"]').attributes('style')).toMatch(/left: \d+px/)
    expect(w.find('tbody td[data-col="shipDate"]').classes()).not.toContain('sticky')
  })

  // D1: `.bb-cell:not([data-frozen]) { position: relative }` is what stops the
  // scoped rule from out-ranking Tailwind's `.sticky`. The attribute was only
  // ever set on the TOP line, so a frozen column's carrier-line cell got
  // `position: relative` and slid away with the horizontal scroll.
  it('marks the carrier line\'s frozen cells too, so they stay pinned', () => {
    const w = mountGrid({ frozen: 2 })
    const bottom = w.find('tr[data-row="bottom"] td[data-col="customer"]')
    expect(bottom.exists()).toBe(true)
    expect(bottom.attributes('data-frozen')).toBeDefined()
    expect(bottom.classes()).toContain('sticky')
    // A column past the freeze line still carries nothing.
    expect(w.find('tr[data-row="top"] td[data-col="shipDate"]').attributes('data-frozen')).toBeUndefined()
  })

  it('unfreezes everything', async () => {
    const w = mountGrid()
    await w.findAll('thead th')[1].trigger('contextmenu')
    await nextTick()
    await w.find('[data-header-menu] [data-unfreeze]').trigger('click')
    await nextTick()
    expect(w.find('tbody td[data-col="bol"]').classes()).not.toContain('sticky')
  })

  it('paints a whole column from the header menu', async () => {
    const w = mountGrid()
    await w.findAll('thead th')[2].trigger('contextmenu')
    await nextTick()
    await w.find('[data-header-menu] [data-col-swatch="#cfe3ff"]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    const next = w.emitted('view')?.[0][0] as { fills: { col?: Record<string, string> } }
    expect(next.fills.col).toEqual({ customer: '#cfe3ff' })
  })
})

describe('the CSV', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('writes the visible columns and the rows the filters left', () => {
    const w = mountGrid()
    const csv = (w.vm as unknown as { exportCsv: () => string }).exportCsv().split('\r\n')
    expect(csv[0]).toBe('BOL#,CUSTOMER /CARRIER,SHIP DATE,RATE')
    expect(csv[1]).toBe('1,ACME,7/13/2026,"$4,000.00"')
    // Load "a" has a carrier line, so it writes a second row under its own.
    expect(csv[2]).toBe(',BLUE,,')
  })

  it('follows the search, so the file is what is on screen', async () => {
    const w = mountGrid({ search: 'BETA' })
    await nextTick()
    const csv = (w.vm as unknown as { exportCsv: () => string }).exportCsv()
    expect(csv).toContain('BETA')
    expect(csv).not.toContain('ACME')
  })
})
