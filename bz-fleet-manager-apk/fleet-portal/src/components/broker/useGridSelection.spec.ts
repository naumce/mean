import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useGridSelection } from './useGridSelection'

const grid = (rows = 5, cols = 4) => useGridSelection(ref(rows), ref(cols))

describe('useGridSelection', () => {
  it('starts as one cell and remembers which line it is on', () => {
    const s = grid()
    s.start(2, 1, 'bottom')
    expect(s.anchor.value).toEqual({ r: 2, c: 1, line: 'bottom' })
    expect(s.range.value).toEqual({ r1: 2, c1: 1, r2: 2, c2: 1 })
    expect(s.isAnchor(2, 1, 'bottom')).toBe(true)
    expect(s.isAnchor(2, 1, 'top')).toBe(false)
  })

  it('extends in any direction without moving the anchor', () => {
    const s = grid()
    s.start(2, 2)
    s.extendTo(0, 0)
    expect(s.range.value).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 })
    expect(s.anchor.value?.r).toBe(2)
    // A second shift-click from the same anchor re-measures rather than
    // growing from wherever the last one ended.
    s.extendTo(3, 3)
    expect(s.range.value).toEqual({ r1: 2, c1: 2, r2: 3, c2: 3 })
  })

  it('moves with the arrows and stops at the edges', () => {
    const s = grid(3, 3)
    s.start(0, 0)
    s.move(-1, 0)
    expect(s.anchor.value).toEqual({ r: 0, c: 0, line: 'top' })
    s.move(1, 1)
    expect(s.anchor.value?.r).toBe(1)
    s.move(5, 5)
    expect(s.anchor.value).toEqual({ r: 2, c: 2, line: 'top' })
  })

  it('grows and shrinks from the same edge with shift+arrows', () => {
    const s = grid(5, 4)
    s.start(2, 1)
    s.move(1, 0, true)
    expect(s.range.value).toEqual({ r1: 2, c1: 1, r2: 3, c2: 1 })
    s.move(1, 0, true)
    expect(s.range.value).toEqual({ r1: 2, c1: 1, r2: 4, c2: 1 })
    // Back up: the rectangle shrinks toward the anchor instead of jumping
    // across it.
    s.move(-1, 0, true)
    expect(s.range.value).toEqual({ r1: 2, c1: 1, r2: 3, c2: 1 })
  })

  it('selects the whole board, and nothing at all when there is nothing', () => {
    const s = grid(3, 2)
    s.selectAll()
    expect(s.range.value).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 })
    expect(s.cells.value).toHaveLength(6)
    const empty = grid(0, 0)
    empty.selectAll()
    expect(empty.range.value).toBeNull()
  })

  it('walks the rectangle row by row — the order a copy writes', () => {
    const s = grid()
    s.start(1, 1)
    s.extendTo(2, 2)
    expect(s.cells.value).toEqual([
      { r: 1, c: 1 }, { r: 1, c: 2 },
      { r: 2, c: 1 }, { r: 2, c: 2 },
    ])
  })

  it('totals only the cells that hold a number, money punctuation and all', () => {
    const s = grid(2, 2)
    s.start(0, 0)
    s.extendTo(1, 1)
    const read = (r: number, c: number) => [['$4,000.00', 'ACME'], ['2500', '']][r][c]
    expect(s.stats(read)).toEqual({ cells: 4, numeric: 2, sum: 6500, avg: 3250 })
  })

  it('has no average when nothing in the range is a number', () => {
    const s = grid(1, 2)
    s.start(0, 0)
    s.extendTo(0, 1)
    expect(s.stats(() => 'ACME')).toEqual({ cells: 2, numeric: 0, sum: 0, avg: null })
  })

  it('clears everything', () => {
    const s = grid()
    s.start(1, 1)
    s.clear()
    expect(s.anchor.value).toBeNull()
    expect(s.range.value).toBeNull()
    expect(s.isSelected(1, 1)).toBe(false)
    expect(s.stats(() => '1')).toEqual({ cells: 0, numeric: 0, sum: 0, avg: null })
  })
})
