import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'

// Task 6: BrokerGrid now reads useBrokerBoardStore (the AGENT switch's
// stale-reload) and, through AgentSwitch, useNightShiftStore (the policy
// picker) — both need an active Pinia, and the store module needs its `api`
// mocked so AgentSwitch's onMounted policy fetch never reaches a real
// server.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { get: vi.fn().mockResolvedValue({ data: { policies: [], loadsByPolicy: {} } }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

// Slice 2B: the board is a spreadsheet. Selection, typing, copy, paste,
// merge and fill — proven through the component, since the rules live in the
// composables but the wiring is where they meet a dispatcher.
const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'rate', label: 'RATE' }, { key: 'agent', label: 'AGENT' },
]
const mk = (id: string, bol: string, rate: string, carrier: string | null): BoardLoad =>
  ({ id, line: 1, top: { bol, customer: 'ACME', rate }, bottom: carrier ? { customer: carrier } : null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol), version: 0 })
const loads = [mk('a', '1', '$900.00', 'BLUE'), mk('b', '2', '$4,000.00', null), mk('c', '3', '$2,000.00', 'RED')]

const mountGrid = (props: Record<string, unknown> = {}) =>
  mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, ...props }, attachTo: document.body })

/** The cells of one line, without the checkbox gutter. */
const cellsOf = (w: ReturnType<typeof mountGrid>, loadId: string, line: 'top' | 'bottom') =>
  w.findAll(`tr[data-load="${loadId}"][data-row="${line}"] td[data-col]`)

describe('the selection rectangle', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('anchors on the cell that was clicked', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    expect(cellsOf(w, 'a', 'top')[1].classes()).toContain('bb-anchor')
    expect(cellsOf(w, 'a', 'top')[1].classes()).toContain('bb-sel')
    expect(cellsOf(w, 'b', 'top')[1].classes()).not.toContain('bb-sel')
  })

  it('extends over a block with shift-click and reports what it adds up to', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[2].trigger('mousedown')
    await cellsOf(w, 'c', 'top')[2].trigger('mousedown', { shiftKey: true })
    // RATE down three loads: the status bar totals what the eye sees, money
    // punctuation and all.
    const status = w.find('[data-status-bar]').text()
    expect(status).toContain('3 cells')
    expect(status).toContain('Sum 6,900')
    expect(status).toContain('Avg 2,300')
  })

  it('drops the selection when a sort changes what a coordinate means', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    expect(w.find('.bb-anchor').exists()).toBe(true)
    await w.findAll('thead th button')[2].trigger('click')
    await nextTick()
    expect(w.find('.bb-anchor').exists()).toBe(false)
  })
})

describe('editing a cell', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('opens on a double click and asks the server for exactly what changed', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('dblclick')
    await nextTick()
    const editor = w.find('[data-cell-editor]')
    expect(editor.exists()).toBe(true)
    await editor.setValue('NEW CUSTOMER')
    await editor.trigger('keydown.enter')
    expect(w.emitted('edit')?.[0][0]).toEqual({ loadId: 'a', row: 'top', key: 'customer', source: 'CUSTOMER /CARRIER', value: 'NEW CUSTOMER', baseVersion: 0 })
  })

  it('shows the row its props carry after the store swaps in the server answer', async () => {
    // NOT a regression test for the stale-cell bug, and it should not be read
    // as one: `setProps` re-renders the component by itself, which is exactly
    // what the real failure lacked — in a browser the props updated, nothing
    // re-rendered, and the cell kept the old text. jsdom cannot reproduce
    // that, so the fix (`void props.loads` in `rows`) is verified in a real
    // browser instead. What this does hold is the plain property: the cell
    // renders the value its props carry.
    const w = mountGrid()
    expect(cellsOf(w, 'a', 'top')[2].text()).toBe('$900.00')
    const fresh = loads.map((l) => (l.id === 'a' ? { ...l, top: { ...l.top, rate: '$4,500.00' } } : l))
    await w.setProps({ loads: fresh })
    await nextTick()
    expect(cellsOf(w, 'a', 'top')[2].text()).toBe('$4,500.00')
  })

  it('says nothing to the server when the value did not change', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('dblclick')
    await nextTick()
    await w.find('[data-cell-editor]').trigger('keydown.enter')
    expect(w.emitted('edit')).toBeUndefined()
  })

  it('starts typing straight into the cell, seeded with the key that was pressed', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    await w.find('[data-grid-scroller]').trigger('keydown', { key: 'X' })
    await nextTick()
    expect((w.find('[data-cell-editor]').element as HTMLInputElement).value).toBe('X')
  })

  it('throws the edit away on Escape', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('dblclick')
    await nextTick()
    await w.find('[data-cell-editor]').setValue('NOPE')
    await w.find('[data-cell-editor]').trigger('keydown.esc')
    expect(w.emitted('edit')).toBeUndefined()
    expect(w.find('[data-cell-editor]').exists()).toBe(false)
  })

  it('never opens an editor on the agent column or on PROFIT', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[3].trigger('dblclick')
    await nextTick()
    expect(w.find('[data-cell-editor]').exists()).toBe(false)
  })

  it('opens nothing at all on a read-only board', async () => {
    const w = mountGrid({ editable: false })
    await cellsOf(w, 'a', 'top')[1].trigger('dblclick')
    await nextTick()
    expect(w.find('[data-cell-editor]').exists()).toBe(false)
  })

  // Fix round 1, Finding 1 (MEDIUM): `edit-start` fires before loadLocks.held
  // is set (acquireLoadLock is still in flight), so a `load_changed` frame
  // can patch this row — and bump its version — while the editor is already
  // open. `commitEdit` must send the version the dispatcher actually saw
  // (captured when the editor opened), not a fresh read at commit time —
  // otherwise the write sails past the server's stale-version check on a
  // version number the dispatcher never looked at, and a colleague's
  // concurrent change is silently overwritten instead of raising the
  // conflict panel.
  it('captures baseVersion when the editor opens, not when it commits', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('dblclick')
    await nextTick()
    // Simulates a load_changed frame patching this row mid-edit: the prop
    // updates with a newer version, but the draft (a local ref, seeded at
    // open) is untouched — same as the real store swapping `loads` in place.
    const bumped = loads.map((l) => (l.id === 'a' ? { ...l, version: 7 } : l))
    await w.setProps({ loads: bumped })
    await nextTick()
    await w.find('[data-cell-editor]').setValue('NEW CUSTOMER')
    await w.find('[data-cell-editor]').trigger('keydown.enter')
    // baseVersion 0 — what was on screen when the editor opened — not 7,
    // which landed under the dispatcher while they were still typing.
    expect(w.emitted('edit')?.[0][0]).toMatchObject({ loadId: 'a', value: 'NEW CUSTOMER', baseVersion: 0 })
  })

  // A4-R9: the dirty-check used to compare the draft against the LIVE row's
  // text, so a load_changed frame that patched this cell while the editor sat
  // open and untouched made the commit look like an edit the dispatcher never
  // made. The rule: an edit is a change the dispatcher made, measured from
  // what they were shown at open — not from what the row says now.
  it('does not call an untouched cell dirty just because the row moved underneath it', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('dblclick')
    await nextTick()
    // Same simulated load_changed frame as the baseVersion test above, but
    // this time it also rewrites the very cell being edited. The dispatcher
    // never touched the draft, so the text they were shown and the text
    // they're committing are identical even though the live row disagrees.
    const changed = loads.map((l) => (l.id === 'a' ? { ...l, version: 7, top: { ...l.top, customer: 'CHANGED REMOTELY' } } : l))
    await w.setProps({ loads: changed })
    await nextTick()
    await w.find('[data-cell-editor]').trigger('keydown.enter')
    expect(w.emitted('edit')).toBeUndefined()
  })

  it('edits the carrier line as the carrier line', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'bottom')[0].trigger('dblclick')
    await nextTick()
    await w.find('[data-cell-editor]').setValue('RED LINE')
    await w.find('[data-cell-editor]').trigger('keydown.enter')
    expect(w.emitted('edit')?.[0][0]).toMatchObject({ loadId: 'a', row: 'bottom', key: 'customer', value: 'RED LINE' })
  })
})

describe('the clipboard', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('copies the range as tab-separated text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    await cellsOf(w, 'b', 'top')[2].trigger('mousedown', { shiftKey: true })
    await w.find('[data-grid-scroller]').trigger('keydown', { key: 'c', ctrlKey: true })
    expect(writeText).toHaveBeenCalledWith('ACME\t$900.00\nACME\t$4,000.00')
  })

  it('lays a pasted block down from the anchor, one write per cell', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    const clipboardData = { getData: () => 'FIRST\t1000\nSECOND\t2000' }
    await w.find('[data-grid-scroller]').trigger('paste', { clipboardData })
    expect(w.emitted('paste')?.[0][0]).toEqual([
      { loadId: 'a', row: 'top', key: 'customer', source: 'CUSTOMER /CARRIER', value: 'FIRST', baseVersion: 0 },
      { loadId: 'a', row: 'top', key: 'rate', source: 'RATE', value: '1000', baseVersion: 0 },
      { loadId: 'b', row: 'top', key: 'customer', source: 'CUSTOMER /CARRIER', value: 'SECOND', baseVersion: 0 },
      { loadId: 'b', row: 'top', key: 'rate', source: 'RATE', value: '2000', baseVersion: 0 },
    ])
  })

  it('says so when the board ends before the paste does', async () => {
    const w = mountGrid()
    await cellsOf(w, 'c', 'top')[1].trigger('mousedown')
    await w.find('[data-grid-scroller]').trigger('paste', { clipboardData: { getData: () => 'ONE\nTWO\nTHREE' } })
    expect(w.emitted('notice')?.[0][0]).toMatch(/board ends before/i)
  })

  it('clears a range with Delete instead of asking the dispatcher to blank each cell', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    await cellsOf(w, 'b', 'top')[1].trigger('mousedown', { shiftKey: true })
    await w.find('[data-grid-scroller]').trigger('keydown', { key: 'Delete' })
    expect(w.emitted('paste')?.[0][0]).toEqual([
      { loadId: 'a', row: 'top', key: 'customer', source: 'CUSTOMER /CARRIER', value: '', baseVersion: 0 },
      { loadId: 'b', row: 'top', key: 'customer', source: 'CUSTOMER /CARRIER', value: '', baseVersion: 0 },
    ])
  })

  it('never pastes into the agent column', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[2].trigger('mousedown')
    await w.find('[data-grid-scroller]').trigger('paste', { clipboardData: { getData: () => '5000\tSOMETHING' } })
    const cells = w.emitted('paste')?.[0][0] as Array<{ key: string }>
    expect(cells.map((c) => c.key)).toEqual(['rate'])
  })
})

describe('merge and fill', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })

  it('draws a load on two lines only where their sheet splits the column', () => {
    const w = mountGrid()
    // Load "a" has a carrier name, so CUSTOMER is split and everything else
    // spans both lines; load "b" has no carrier line at all.
    expect(cellsOf(w, 'a', 'bottom')).toHaveLength(1)
    expect(cellsOf(w, 'a', 'top')[0].attributes('rowspan')).toBe('2')
    expect(cellsOf(w, 'a', 'top')[1].attributes('rowspan')).toBeUndefined()
    expect(w.findAll('tr[data-load="b"]')).toHaveLength(1)
  })

  it('unmerges the selection and hands the whole new state back to be saved', async () => {
    const w = mountGrid()
    await cellsOf(w, 'b', 'top')[1].trigger('mousedown')
    ;(w.vm as unknown as { toggleMerge: () => void }).toggleMerge()
    await nextTick()
    const next = w.emitted('view')?.[0][0] as { merges: Record<string, string[]> }
    expect(next.merges.b).toEqual(['customer'])
  })

  it('merges a split column back, and remembers that decision as an empty list', async () => {
    const w = mountGrid()
    await cellsOf(w, 'a', 'top')[1].trigger('mousedown')
    ;(w.vm as unknown as { toggleMerge: () => void }).toggleMerge()
    await nextTick()
    const next = w.emitted('view')?.[0][0] as { merges: Record<string, string[]> }
    // Not "no entry" — an empty entry, or the derived split would come back
    // and undo them on the next render.
    expect(next.merges.a).toEqual([])
  })

  it('paints what the view says, and lets a fill win over their yellow', () => {
    const view = { fills: { cell: { 'a|customer': '#cdf2c8' } }, merges: {} }
    const w = mountGrid({ view })
    expect(cellsOf(w, 'a', 'top')[1].attributes('style')).toContain('rgb(205, 242, 200)')
  })
})

describe('the marks', () => {
  it('shows a dot with the record\'s value on a cell that disagrees with it, and nothing on one that agrees', () => {
    const marked = { ...loads[0], record: { update: 'assigned', appt: 'PU 07/14 12:00 · DEL 07/20 07:00' } }
    const w = mount(BrokerGrid, { props: { layout: [...layout, { key: 'update', label: 'UPDATE' }, { key: 'appt', label: 'APPT' }], loads: [marked, loads[1]], viewportHeight: 10_000 } })
    const update = w.find('tr[data-load="a"][data-row="top"] td[data-col="update"] [data-record]')
    expect(update.exists()).toBe(true)
    expect(update.attributes('title')).toBe('record says assigned')
    expect(w.find('tr[data-load="a"][data-row="top"] td[data-col="appt"] [data-record]').attributes('title')).toBe('record says PU 07/14 12:00 · DEL 07/20 07:00')
    expect(w.find('tr[data-load="b"] [data-record]').exists()).toBe(false)
  })
})
