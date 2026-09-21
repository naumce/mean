import { computed, ref, type Ref } from 'vue'

// A spreadsheet selection: one anchor cell and the rectangle it spans. Kept
// out of BrokerGrid.vue because it is the piece every other 2B feature reads —
// editing opens at the anchor, copy serializes the range, fill paints it —
// and because a rectangle with keyboard rules is worth testing on its own.
//
// Coordinates are (row index in the CURRENT visible order, column index in the
// CURRENT visible order). Sorting or filtering the board changes what a
// coordinate means, so the grid clears the selection when the row model
// changes rather than trying to follow a cell that may not be on screen.

export type CellLine = 'top' | 'bottom'
export interface CellRef { r: number; c: number; line: CellLine }
export interface CellRange { r1: number; c1: number; r2: number; c2: number }

/** Sum and average count only cells that hold a number, so a range dragged
 *  across CUSTOMER and RATE still totals the money — the same thing Excel's
 *  status bar does. */
export interface RangeStats { cells: number; numeric: number; sum: number; avg: number | null }

const between = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a])

export function useGridSelection(rowCount: Ref<number>, colCount: Ref<number>) {
  const anchor = ref<CellRef | null>(null)
  const range = ref<CellRange | null>(null)
  const dragging = ref(false)

  const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, max - 1))

  function start(r: number, c: number, line: CellLine = 'top') {
    anchor.value = { r: clamp(r, rowCount.value), c: clamp(c, colCount.value), line }
    range.value = { r1: anchor.value.r, c1: anchor.value.c, r2: anchor.value.r, c2: anchor.value.c }
  }

  /** Drag or shift-click: the rectangle from the anchor to here. The anchor
   *  does not move — that is what makes shift-click after shift-click grow
   *  and shrink from the same corner instead of walking away. */
  function extendTo(r: number, c: number) {
    if (!anchor.value) return start(r, c)
    const [r1, r2] = between(anchor.value.r, clamp(r, rowCount.value))
    const [c1, c2] = between(anchor.value.c, clamp(c, colCount.value))
    range.value = { r1, c1, r2, c2 }
  }

  /** Arrows move the anchor; shift+arrows grow the rectangle. Movement stops
   *  at the edges rather than wrapping: a dispatcher holding ↓ should land on
   *  the last load, not on the first one. */
  function move(dr: number, dc: number, extend = false) {
    if (!anchor.value) return start(0, 0)
    if (extend) {
      const cur = range.value ?? { r1: anchor.value.r, c1: anchor.value.c, r2: anchor.value.r, c2: anchor.value.c }
      // Grow from the edge that is not the anchor, so shift+↓ then shift+↑
      // undoes itself instead of jumping across the anchor.
      const r = anchor.value.r === cur.r1 ? cur.r2 : cur.r1
      const c = anchor.value.c === cur.c1 ? cur.c2 : cur.c1
      return extendTo(clamp(r + dr, rowCount.value), clamp(c + dc, colCount.value))
    }
    start(clamp(anchor.value.r + dr, rowCount.value), clamp(anchor.value.c + dc, colCount.value), anchor.value.line)
  }

  function selectAll() {
    if (rowCount.value === 0 || colCount.value === 0) return
    anchor.value = anchor.value ?? { r: 0, c: 0, line: 'top' }
    range.value = { r1: 0, c1: 0, r2: rowCount.value - 1, c2: colCount.value - 1 }
  }

  function clear() {
    anchor.value = null
    range.value = null
    dragging.value = false
  }

  const isSelected = (r: number, c: number): boolean => {
    const s = range.value
    return !!s && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2
  }
  const isAnchor = (r: number, c: number, line: CellLine): boolean =>
    !!anchor.value && anchor.value.r === r && anchor.value.c === c && anchor.value.line === line

  /** Every (r, c) in the rectangle, row-major — the order a copy writes and a
   *  paste reads. */
  const cells = computed<Array<{ r: number; c: number }>>(() => {
    const s = range.value
    if (!s) return []
    const out: Array<{ r: number; c: number }> = []
    for (let r = s.r1; r <= s.r2; r += 1) for (let c = s.c1; c <= s.c2; c += 1) out.push({ r, c })
    return out
  })

  /** `read` is how the grid hands over what a cell displays; the money and
   *  punctuation a sheet prints ("$4,000.00") is stripped before the sum, so
   *  what the status bar totals is what the dispatcher sees. */
  function stats(read: (r: number, c: number) => string): RangeStats {
    let numeric = 0
    let sum = 0
    for (const { r, c } of cells.value) {
      const raw = read(r, c).replace(/[$,\s]/g, '')
      if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) continue
      numeric += 1
      sum += Number(raw)
    }
    return { cells: cells.value.length, numeric, sum, avg: numeric === 0 ? null : sum / numeric }
  }

  return { anchor, range, dragging, start, extendTo, move, selectAll, clear, isSelected, isAnchor, cells, stats }
}
