import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import BrokerImportDialog from './BrokerImportDialog.vue'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const preview = {
  sheetName: 'July',
  layout: [{ key: 'bol', label: 'BOL#' }, { key: 'agent', label: 'AGENT' }],
  unmatched: ['TRAILER #'],
  missing: [],
  loads: [{ line: 3, loadNo: '145205', customer: 'ACME FOODS', carrier: 'BLUE ROAD LLC', pickup: 'Henderson, NV', delivery: 'Dallas, TX', rateCents: 400000, notes: ['equipment assumed Dry Van (the sheet has no equipment column)'] }],
  notes: [
    "also found a board on sheet 'August' — only 'July' was imported",
    'line 6: duplicate LOAD# 145205 — first occurrence on line 3 kept',
  ],
}

/** The dialog reads the file off the input's own `files`, which jsdom does
 *  not let a test assign directly. */
async function choose(w: ReturnType<typeof mount>) {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [new File([new Uint8Array([1])], 'board.xlsx')] })
  await input.trigger('change')
  await flushPromises()
}

describe('BrokerImportDialog', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('shows the workbook notes — the tab it read and the row it skipped — above the table', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    const notes = w.findAll('[data-preview-notes] li').map((li) => li.text())
    expect(notes).toContain("also found a board on sheet 'August' — only 'July' was imported")
    expect(notes).toContain('line 6: duplicate LOAD# 145205 — first occurrence on line 3 kept')
    expect(w.text()).toContain('Sheet July')
  })

  it('says an unknown column is not imported, rather than promising it is kept as text', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    expect(w.text()).toContain('not imported in this version: TRAILER #')
    expect(w.text()).not.toContain('kept as text')
  })

  it('reports the rows the import skipped and why, next to the counts', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 4, updated: 0, skipped: 1, attention: 1, notes: ['line 6: duplicate LOAD# 145205 — first occurrence on line 3 kept'] } })
    mockedGet.mockResolvedValueOnce({ data: { layout: preview.layout, loads: [] } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    await w.find('button.bg-brand').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('4 new, 0 updated, 1 skipped, 1 need attention')
    expect(w.findAll('[data-result-notes] li').map((li) => li.text())).toContain('line 6: duplicate LOAD# 145205 — first occurrence on line 3 kept')
  })

  // Final review finding 8 (IMPORTANT): a re-import deliberately leaves an
  // archived load archived, but counted it as a plain "updated" — the line
  // said "5 updated" while the board showed 4, with nothing to explain the
  // gap. Say how many of them stayed off the board.
  it('says how many matched loads stayed archived instead of hiding them in the update count', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 0, updated: 5, skipped: 0, attention: 0, archivedKept: 1, notes: [] } })
    mockedGet.mockResolvedValueOnce({ data: { layout: preview.layout, loads: [] } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    await w.find('button.bg-brand').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('0 new, 5 updated, 1 left archived')
  })

  // F10: a row the importer left alone because a dispatcher was editing that
  // load (spec §7.3). The server has always counted it; the dialog dropped
  // the count on the floor, so an import that silently skipped three rows
  // looked like a clean one.
  it('says how many rows were skipped because someone was editing them', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 2, updated: 0, skipped: 0, locked: 2, attention: 0, archivedKept: 0, notes: ['row 6: Maria is editing this load — not imported'] } })
    mockedGet.mockResolvedValueOnce({ data: { layout: preview.layout, loads: [] } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    await w.find('button.bg-brand').trigger('click')
    await flushPromises()
    expect(w.find('[data-locked-skipped]').text()).toBe('2 rows being edited were skipped.')
    expect(w.findAll('[data-result-notes] li').map((li) => li.text())).toContain('row 6: Maria is editing this load — not imported')
  })

  it('says nothing about edited rows when none were skipped', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 5, updated: 0, skipped: 0, locked: 0, attention: 0, archivedKept: 0, notes: [] } })
    mockedGet.mockResolvedValueOnce({ data: { layout: preview.layout, loads: [] } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    await w.find('button.bg-brand').trigger('click')
    await flushPromises()
    expect(w.find('[data-locked-skipped]').exists()).toBe(false)
  })

  it('says nothing about archived loads when none stayed archived', async () => {
    mockedPost.mockResolvedValueOnce({ data: { preview } })
    mockedPost.mockResolvedValueOnce({ data: { batchId: 'b1', created: 5, updated: 0, skipped: 0, attention: 0, archivedKept: 0, notes: [] } })
    mockedGet.mockResolvedValueOnce({ data: { layout: preview.layout, loads: [] } })
    const w = mount(BrokerImportDialog)
    await choose(w)
    await w.find('button.bg-brand').trigger('click')
    await flushPromises()
    expect(w.text()).not.toContain('left archived')
  })
})
