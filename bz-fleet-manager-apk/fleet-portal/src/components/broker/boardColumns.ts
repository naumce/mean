import type { AccessorFnColumnDef, Row } from '@tanstack/vue-table'
import type { BoardColumn, BoardColumnKey, BoardLoad } from '../../lib/api'

// One TanStack column per layout column. We never let the library render;
// these definitions exist for sorting, filtering and column state.

const SHARED: ReadonlySet<BoardColumnKey> = new Set(['customer', 'phone', 'contact', 'mc', 'loadNo', 'appt'])

// `index` is the column's position in `layout`: two `extra` columns can
// share a label (and have no distinct `source`), and without the index
// they'd collide on the same TanStack column id — duplicate v-for keys in
// BrokerGrid.vue and a Map entry in layoutById that silently drops one of
// them. Known keys (bol, customer, …) are already unique and keep their
// plain id so `layoutById`/`col()` lookups and every other id in this file
// stay unchanged for them.
export const columnId = (c: BoardColumn, index: number): string => (c.key === 'extra' ? `extra:${c.source ?? c.label}:${index}` : c.key)

export function cellOf(cells: BoardLoad['top'] | null, c: BoardColumn): string {
  if (!cells) return ''
  if (c.key === 'extra') return (cells as Record<string, string>)[c.source ?? c.label] ?? ''
  return cells[c.key] ?? ''
}

export function moneyValue(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, '')
  return cleaned && /^-?\d+(\.\d{1,2})?$/.test(cleaned) ? Math.round(Number(cleaned) * 100) : null
}
export function dateValue(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  const iso = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return iso ? Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : null
}
const PILL_RANK: Record<string, number> = { none: 0, shadow: 1, watching: 2, asked: 3, calling: 4, attention: 5, escalated: 6, delivered: 1 }

/** Final review finding 2 (IMPORTANT): the money and date columns hand
 *  TanStack a NUMBER through `accessorFn` (so sorting is numeric and blanks
 *  can be `undefined`), which makes the `auto` filter resolve to
 *  `inNumberRange` — it destructures the dispatcher's typed string as
 *  [min, max] and empties the board with no explanation. `includesString`
 *  is not the fix either: it stringifies the cents integer, so "4,000" never
 *  matches 400000. This filters the RENDERED text instead — what they can
 *  see in the cell is what they can type — and, because money and dates
 *  carry punctuation the eye skips, matches loosely too, so "4000" finds
 *  "$4,000.00" and "$4,0" still finds it as a prefix. */
const loose = (s: string): string => s.replace(/[$,\s]/g, '')
const renderedTextFilter = (c: BoardColumn) => (row: Row<BoardLoad>, _columnId: string, value: unknown): boolean => {
  // Slice 2B: a filter value is EITHER text a dispatcher typed in the filter
  // row, or the set of values they ticked in the column's popover.
  //
  // The SET is matched exactly against the customer line, because that is the
  // line the popover listed. This filter must be on every column, not just
  // the money and date ones: TanStack's default `auto` filter stringifies an
  // array into "MEIBORG,ACME" and then matches nothing at all, which emptied
  // the board the moment anyone unticked a value.
  if (Array.isArray(value)) return value.includes(cellOf(row.original.top, c))
  const needle = String(value ?? '').trim().toLowerCase()
  if (!needle) return true
  // TYPED text matches what the column shows — both of its lines. A
  // dispatcher typing a carrier's name into CUSTOMER means the carrier line
  // under it, which is what the column's accessor has always joined.
  const text = [cellOf(row.original.top, c), cellOf(row.original.bottom, c)].filter(Boolean).join(' ').toLowerCase()
  // A needle that is nothing but punctuation ("," or "$") would loosen to
  // the empty string and match every row — keep it on the literal path.
  return text.includes(needle) || (loose(needle) !== '' && loose(text).includes(loose(needle)))
}

// Every column we build always sets an explicit `id` and `accessorFn`, so the
// precise TanStack union member is AccessorFnColumnDef (not the wider
// ColumnDef union the brief's interface names) — the brief's own spec reads
// `.accessorFn` straight off a `buildColumns()` result, which only
// type-checks under v8.21.3's real types when the return type is this
// narrow; ColumnDef's other union arms (e.g. StringHeaderIdentifier) don't
// declare that property, and Vue's own accessorFn columns are always
// assignable back to the wider ColumnDef union wherever the table expects it.
// TValue is widened to `string | number | undefined` (not just `string`)
// because the money/date columns below hand TanStack a raw number (or
// `undefined` for a blank/unparseable cell) rather than a formatted string —
// see the `sortUndefined: 'last'` comment.
export function buildColumns(layout: BoardColumn[]): AccessorFnColumnDef<BoardLoad, string | number | undefined>[] {
  const defs = layout.map((c, index) => {
    const id = columnId(c, index)
    const base: AccessorFnColumnDef<BoardLoad, string | number | undefined> = {
      id,
      header: c.label,
      accessorFn: (l) => (SHARED.has(c.key) ? [cellOf(l.top, c), cellOf(l.bottom, c)].filter(Boolean).join(' ') : cellOf(l.top, c)),
      enableSorting: true,
      size: 120,
      // Every column filters on what it renders — see renderedTextFilter.
      filterFn: renderedTextFilter(c),
    }
    if (c.key === 'rate' || c.key === 'soldRate' || c.key === 'profit') {
      // Fixing review Finding 1 (HIGH): TanStack's getSortedRowModel negates
      // a *custom* sortingFn's return value on a descending sort, so a
      // hand-rolled "nulls last" comparator (the previous `nullsLast`
      // helper) flips right along with everything else and blanks end up
      // FIRST on desc instead of last. `sortUndefined: 'last'` is handled
      // by TanStack before that negation (it returns directly, is never
      // multiplied by -1), so it stays "last" in both directions — but it
      // only fires for a column value that is really `undefined`, not a
      // manual null sentinel baked into a sortingFn's own compare result.
      // So the accessor itself must surface the parsed value (or
      // `undefined`), and sorting must go through the plain 'basic'
      // comparator over that value instead of a bespoke fn.
      base.accessorFn = (l) => moneyValue(cellOf(l.top, c)) ?? undefined
      base.sortingFn = 'basic'
      base.sortUndefined = 'last'
      // TanStack infers a column's first-click direction from its first
      // row's value type when sortDescFirst is unset (getAutoSortDir:
      // string -> asc, anything else -> desc). The accessor above now hands
      // it a number instead of the formatted string it used to, which would
      // silently flip "first click" to descending — pin it explicitly so
      // clicking a money/date header still sorts ascending first, same as
      // every other column.
      base.sortDescFirst = false
    }
    if (c.key === 'shipDate') {
      base.accessorFn = (l) => dateValue(cellOf(l.top, c)) ?? undefined
      base.sortingFn = 'basic'
      base.sortUndefined = 'last'
      base.sortDescFirst = false
    }
    if (c.key === 'agent') {
      base.accessorFn = (l) => String(PILL_RANK[l.pill.state] ?? 0)
      base.sortingFn = (a: Row<BoardLoad>, b: Row<BoardLoad>) => (PILL_RANK[a.original.pill.state] ?? 0) - (PILL_RANK[b.original.pill.state] ?? 0)
      base.size = 110
    }
    if (c.key === 'bol') base.size = 90
    if (c.key === 'phone') base.size = 220
    return base
  })
  // Task 6: a hidden column driving the status `<select>` in the view.
  // Never rendered (size 0, never listed in ColumnTools) — it exists purely
  // so `t.table.getColumn('status')?.setFilterValue(...)` can filter the row
  // model by `l.status` with an exact match (equals), independent of the
  // free-text search box and the per-column filter row.
  const status: AccessorFnColumnDef<BoardLoad, string | number | undefined> = {
    id: 'status',
    header: 'Status',
    accessorFn: (l) => l.status,
    enableSorting: false,
    enableHiding: true,
    filterFn: 'equals',
    size: 0,
  }
  return [...defs, status]
}
