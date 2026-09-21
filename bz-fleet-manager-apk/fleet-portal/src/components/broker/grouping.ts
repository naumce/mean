import type { BoardLoad } from '../../lib/api'

// Grouping the board by one field or several, with the money totalled on each
// group row. A pure walk: rows in (already sorted and filtered by TanStack),
// a flat list of group headers and loads out — flat because that is what a
// virtualizer can measure and what a <tbody> can render.

export interface GroupField {
  /** the board column this groups by */
  id: string
  label: string
  /** how to read the value off a load — the carrier lives on the second line */
  read: (l: BoardLoad) => string
}

export interface GroupTotals { rate: number; sold: number; profit: number }

export type GroupItem =
  | { kind: 'group'; key: string; level: number; label: string; value: string; count: number; totals: GroupTotals; collapsed: boolean }
  | { kind: 'load'; load: BoardLoad; index: number }

/** Money as their sheet prints it ("$4,000.00", "(1,200)", ""). Anything that
 *  is not a number contributes nothing rather than poisoning the total with
 *  NaN — a blank RATE is exactly the case the board leaves empty on purpose. */
export function moneyOf(text: string | undefined): number {
  const cleaned = (text ?? '').replace(/[$,\s]/g, '')
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : 0
}

const totalsOf = (loads: readonly BoardLoad[]): GroupTotals => ({
  rate: loads.reduce((n, l) => n + moneyOf(l.top.rate), 0),
  sold: loads.reduce((n, l) => n + moneyOf(l.top.soldRate), 0),
  profit: loads.reduce((n, l) => n + moneyOf(l.top.profit), 0),
})

/** Natural order, so "Load 2" sorts before "Load 10" and an empty value sinks
 *  to the bottom instead of leading the board. */
const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' })
const byValue = (a: string, b: string): number => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b))

export const BLANK = '(blank)'

/** Walk the rows into a flat list. `collapsed` is keyed by the group's own key
 *  — the joined path — so collapsing "ACME" under "07/13" leaves "ACME" under
 *  "07/14" open, which is what a dispatcher means by collapsing a group. */
export function groupRows(
  loads: readonly BoardLoad[],
  fields: readonly GroupField[],
  collapsed: Readonly<Record<string, boolean>>,
): GroupItem[] {
  if (fields.length === 0) return loads.map((load, index) => ({ kind: 'load' as const, load, index }))
  const indexOf = new Map(loads.map((l, i) => [l.id, i]))

  const walk = (rows: readonly BoardLoad[], level: number, path: string): GroupItem[] => {
    const field = fields[level]
    if (!field) return rows.map((load) => ({ kind: 'load' as const, load, index: indexOf.get(load.id) ?? 0 }))
    const buckets = new Map<string, BoardLoad[]>()
    for (const l of rows) {
      const value = field.read(l).trim()
      const bucket = buckets.get(value)
      if (bucket) bucket.push(l)
      else buckets.set(value, [l])
    }
    const out: GroupItem[] = []
    for (const value of [...buckets.keys()].sort(byValue)) {
      const rowsHere = buckets.get(value) as BoardLoad[]
      const key = `${path}/${field.id}=${value}`
      const isCollapsed = collapsed[key] === true
      out.push({
        kind: 'group', key, level, label: field.label, value: value === '' ? BLANK : value,
        count: rowsHere.length, totals: totalsOf(rowsHere), collapsed: isCollapsed,
      })
      if (!isCollapsed) out.push(...walk(rowsHere, level + 1, key))
    }
    return out
  }
  return walk(loads, 0, '')
}

/** Every group key in a walk, so "collapse all" does not need a second pass
 *  over the data and cannot disagree with what was rendered. */
export function groupKeys(items: readonly GroupItem[]): string[] {
  return items.filter((i): i is Extract<GroupItem, { kind: 'group' }> => i.kind === 'group').map((i) => i.key)
}
