import { describe, expect, it } from 'vitest'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import { buildColumns, columnId, dateValue, moneyValue } from './boardColumns'

const layout: BoardColumn[] = [
  { key: 'bol', label: 'BOL#' }, { key: 'customer', label: 'CUSTOMER /CARRIER' }, { key: 'rate', label: 'RATE' },
  { key: 'shipDate', label: 'SHIP DATE' }, { key: 'extra', label: 'NOTES', source: 'NOTES' }, { key: 'agent', label: 'AGENT' },
]
const load = (over: Partial<BoardLoad['top']>, bottom: BoardLoad['bottom'] = null, pill: BoardLoad['pill'] = { state: 'none', text: null }): BoardLoad =>
  ({ id: Math.random().toString(36).slice(2), line: 1, top: { bol: '1', customer: 'ACME', rate: '$4,000.00', shipDate: '7/13/2026', ...over }, bottom, pill, agentLine: null, status: 'open', boardLine: 1, version: 0 })

describe('buildColumns', () => {
  it('makes one column per layout column with stable ids, plus the hidden status column', () => {
    // Fix round 1, Finding 2: an `extra` column's id carries its layout
    // index (here 4) so two `extra` columns sharing a label never collide.
    // Task 6: buildColumns always appends a trailing `status` column (never
    // derived from `layout`, so it can never collide with a real one) that
    // drives the status filter; it is never shown in ColumnTools or the grid.
    expect(buildColumns(layout).map((c) => c.id)).toEqual(['bol', 'customer', 'rate', 'shipDate', 'extra:NOTES:4', 'agent', 'status'])
  })

  it('disambiguates two extra columns that share a label', () => {
    const dup: BoardColumn[] = [
      { key: 'bol', label: 'BOL#' }, { key: 'extra', label: 'NOTES' }, { key: 'extra', label: 'NOTES' },
    ]
    const ids = buildColumns(dup).map((c) => c.id)
    expect(ids).toEqual(['bol', 'extra:NOTES:1', 'extra:NOTES:2', 'status'])
    expect(new Set(ids).size).toBe(4)
    // columnId itself (used by BrokerGrid.vue's layoutById) agrees with
    // buildColumns for every *layout-derived* column — status has no
    // layout entry (it's synthesized, not derived from `dup`), so it's
    // excluded from this side of the comparison.
    expect(dup.map((c, i) => columnId(c, i))).toEqual(ids.slice(0, -1))
  })

  it('sees both rows of a pair for the shared columns', () => {
    const cols = buildColumns(layout)
    const customer = cols.find((c) => c.id === 'customer')!
    const l = load({}, { customer: 'BLUE ROAD LLC' })
    expect((customer.accessorFn as (r: BoardLoad, i: number) => string)(l, 0)).toBe('ACME BLUE ROAD LLC')
  })

  it('sorts money as numbers and dates as dates, with blanks always last', () => {
    // Fix round 1, Finding 1: money/date columns hand TanStack a raw
    // number (or `undefined` for a blank/unparseable cell) via accessorFn,
    // and rely on the built-in 'basic' comparator + `sortUndefined: 'last'`
    // rather than a hand-rolled comparator — a custom sortingFn's return
    // value gets negated by TanStack on a descending sort, which would flip
    // a manual "nulls last" rule to "nulls first" on desc. `sortUndefined`
    // is handled separately, before that negation, so it holds in both
    // directions (see BrokerGrid.spec.ts for the end-to-end proof).
    expect(moneyValue('$4,000.00')).toBe(400000)
    expect(moneyValue('')).toBeNull()
    const cols = buildColumns(layout)

    const rate = cols.find((c) => c.id === 'rate')!
    expect(rate.sortingFn).toBe('basic')
    expect(rate.sortUndefined).toBe('last')
    const rateFn = rate.accessorFn as (r: BoardLoad, i: number) => number | undefined
    expect(rateFn(load({ rate: '$900.00' }), 0)).toBe(90000)
    expect(rateFn(load({ rate: '$4,000.00' }), 0)).toBe(400000)
    expect(rateFn(load({ rate: '' }), 0)).toBeUndefined()

    const ship = cols.find((c) => c.id === 'shipDate')!
    expect(ship.sortingFn).toBe('basic')
    expect(ship.sortUndefined).toBe('last')
    const shipFn = ship.accessorFn as (r: BoardLoad, i: number) => number | undefined
    expect(shipFn(load({ shipDate: '12/1/2026' }), 0)).toBe(dateValue('12/1/2026'))
    expect(shipFn(load({ shipDate: '12/1/2026' }), 0)).toBeGreaterThan(shipFn(load({ shipDate: '7/13/2026' }), 0)!)
    expect(shipFn(load({ shipDate: '' }), 0)).toBeUndefined()
  })

  // Final review finding 2 (IMPORTANT): those numeric accessors made
  // TanStack's `auto` filter resolve to inNumberRange, which read the typed
  // string as [min, max] — a dispatcher typing a rate watched the board go
  // blank. The filter reads the RENDERED text instead, so what they see in
  // the cell is what they can type; punctuation ($ and ,) is optional on
  // either side.
  it('filters money and date columns on the text the cell actually shows', () => {
    const cols = buildColumns(layout)
    const hit = (id: string, l: BoardLoad, typed: string): boolean => {
      const c = cols.find((x) => x.id === id)!
      // TanStack types `row` as the full Row<BoardLoad>; this filter only ever reads `original`.
      const fn = c.filterFn as unknown as (row: { original: BoardLoad }, columnId: string, value: unknown, addMeta: () => void) => boolean
      return fn({ original: l }, id, typed, () => {})
    }
    for (const typed of ['4000', '4,000', '$4,0', '$4,000.00', '4,000.00']) {
      expect(hit('rate', load({ rate: '$4,000.00' }), typed)).toBe(true)
      expect(hit('rate', load({ rate: '$900.00' }), typed)).toBe(false)
    }
    expect(hit('rate', load({ rate: '' }), '4000')).toBe(false)
    expect(hit('shipDate', load({ shipDate: '7/13/2026' }), '7/13')).toBe(true)
    expect(hit('shipDate', load({ shipDate: '12/1/2026' }), '7/13')).toBe(false)
  })

  it('sorts the agent column by pill severity', () => {
    const cols = buildColumns(layout)
    const agent = cols.find((c) => c.id === 'agent')!
    const none = load({}), att = load({}, null, { state: 'attention', text: 'x' })
    expect((agent.accessorFn as (r: BoardLoad, i: number) => string)(att, 0) > (agent.accessorFn as (r: BoardLoad, i: number) => string)(none, 0)).toBe(true)
  })
})
