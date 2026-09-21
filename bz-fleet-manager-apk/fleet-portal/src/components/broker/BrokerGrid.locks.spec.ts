import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardColumn, BoardLoad, LoadLock } from '../../lib/api'
import BrokerGrid from './BrokerGrid.vue'

// Task 6: BrokerGrid now reads useBrokerBoardStore (the AGENT switch's
// stale-reload) — needs an active Pinia even though this file's layout
// carries no `agent` column, since the store is read unconditionally at
// setup. `api` is mocked so nothing here reaches a real server.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { get: vi.fn().mockResolvedValue({ data: { policies: [], loadsByPolicy: {} } }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

const layout: BoardColumn[] = [{ key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }]
const mk = (id: string, bol: string, version: number): BoardLoad =>
  ({ id, line: 1, top: { bol, customer: 'ACME' }, bottom: null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: Number(bol), version })
const loads = [mk('a', '1', 3), mk('b', '2', 0)]
const maria: LoadLock = { loadId: 'a', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: 61_001 }
const cell = (w: ReturnType<typeof mount>, id: string) => w.find(`tr[data-load="${id}"][data-row="top"] td[data-col]:nth-of-type(3)`)

describe('the lock on a row', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows who is editing, refuses to open an editor there, and says so', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000, locks: { a: maria } }, attachTo: document.body })
    expect(w.find('tr[data-load="a"][data-row="top"]').attributes('data-locked')).toBe('Maria')
    expect(w.find('tr[data-load="a"] [data-lock-badge]').attributes('title')).toBe('Maria is editing this load')
    expect(w.find('tr[data-load="b"] [data-lock-badge]').exists()).toBe(false)
    await cell(w, 'a').trigger('dblclick')
    expect(w.find('[data-cell-editor]').exists()).toBe(false)
    expect(w.emitted('notice')?.[0]).toEqual(['Maria is editing this load'])
    expect(w.emitted('edit-start')).toBeUndefined()
    w.unmount()
  })

  it('announces an edit, carries the version it rendered, and announces the end on commit and on cancel', async () => {
    const w = mount(BrokerGrid, { props: { layout, loads, viewportHeight: 10_000 }, attachTo: document.body })
    await cell(w, 'a').trigger('dblclick')
    expect(w.emitted('edit-start')?.[0]).toEqual(['a'])
    const input = w.find('[data-cell-editor]')
    await input.setValue('BETA')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('edit')?.[0]?.[0]).toMatchObject({ loadId: 'a', key: 'customer', value: 'BETA', baseVersion: 3 })
    expect(w.emitted('edit-end')?.[0]).toEqual(['a'])
    await cell(w, 'b').trigger('dblclick')
    await w.find('[data-cell-editor]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('edit-end')?.[1]).toEqual(['b'])
    expect(w.emitted('edit')).toHaveLength(1)
    w.unmount()
  })

  // B2: the carrier line is the SAME load. Dimming only the top line left a
  // split row half greyed and half live — the read-only half of it still
  // looked editable.
  it('dims both lines of a split load, not just the top one', () => {
    const split: BoardLoad = { ...mk('a', '1', 3), bottom: { customer: 'BLUE ROAD LLC', loadNo: '145205' } }
    const w = mount(BrokerGrid, { props: { layout, loads: [split, loads[1]], viewportHeight: 10_000, locks: { a: maria } }, attachTo: document.body })
    expect(w.find('tr[data-load="a"][data-row="top"]').attributes('data-locked')).toBe('Maria')
    expect(w.find('tr[data-load="a"][data-row="bottom"]').exists()).toBe(true)
    expect(w.find('tr[data-load="a"][data-row="bottom"]').attributes('data-locked')).toBe('Maria')
    // ...and an unheld load carries the attribute on neither line.
    expect(w.find('tr[data-load="b"][data-row="top"]').attributes('data-locked')).toBeUndefined()
    w.unmount()
  })
})
