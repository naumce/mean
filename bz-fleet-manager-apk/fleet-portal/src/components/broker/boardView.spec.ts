import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, cellKey, fillFor, isExpanded, isUnmerged, withFill, withMerge } from './boardView'

describe('fills', () => {
  it('lets the most specific paint win: cell over row over column', () => {
    const view = { fills: { col: { rate: '#cfe3ff' }, row: { L1: '#fff3b0' }, cell: { [cellKey('L1', 'rate')]: '#ffc9c9' } }, merges: {} }
    expect(fillFor(view, 'L1', 'rate')).toBe('#ffc9c9')
    expect(fillFor(view, 'L2', 'rate')).toBe('#cfe3ff')
    expect(fillFor(view, 'L1', 'customer')).toBe('#fff3b0')
    expect(fillFor(view, 'L2', 'customer')).toBeUndefined()
  })

  it('paints the two lines of one cell separately', () => {
    const view = withFill(EMPTY_VIEW, [{ kind: 'cell', loadId: 'L1', colId: 'customer', line: 2 }], '#cdf2c8')
    expect(fillFor(view, 'L1', 'customer', 2)).toBe('#cdf2c8')
    expect(fillFor(view, 'L1', 'customer', 1)).toBeUndefined()
  })

  it('paints a whole row, a whole column, and several cells at once', () => {
    let view = withFill(EMPTY_VIEW, [{ kind: 'row', loadId: 'L1' }, { kind: 'col', colId: 'profit' }], '#e6f5b8')
    view = withFill(view, [
      { kind: 'cell', loadId: 'L2', colId: 'bol', line: 1 },
      { kind: 'cell', loadId: 'L3', colId: 'bol', line: 1 },
    ], '#a9c9f5')
    expect(fillFor(view, 'L1', 'bol')).toBe('#e6f5b8')
    expect(fillFor(view, 'L9', 'profit')).toBe('#e6f5b8')
    expect(fillFor(view, 'L3', 'bol')).toBe('#a9c9f5')
  })

  it('removes the key on "no fill" instead of storing a default color', () => {
    const painted = withFill(EMPTY_VIEW, [{ kind: 'row', loadId: 'L1' }], '#fff3b0')
    const cleared = withFill(painted, [{ kind: 'row', loadId: 'L1' }], null)
    expect(fillFor(cleared, 'L1', 'bol')).toBeUndefined()
    expect(cleared.fills).toEqual({})
  })

  it('never mutates the view it was given', () => {
    const before = EMPTY_VIEW
    const after = withFill(before, [{ kind: 'row', loadId: 'L1' }], '#fff3b0')
    expect(before.fills).toEqual({})
    expect(after).not.toBe(before)
  })
})

describe('merges', () => {
  it('expands a load exactly when one of its columns is unmerged', () => {
    expect(isExpanded(EMPTY_VIEW, 'L1')).toBe(false)
    const view = withMerge(EMPTY_VIEW, 'L1', ['customer'], true)
    expect(isExpanded(view, 'L1')).toBe(true)
    expect(isUnmerged(view, 'L1', 'customer')).toBe(true)
    expect(isUnmerged(view, 'L1', 'phone')).toBe(false)
    expect(isExpanded(view, 'L2')).toBe(false)
  })

  it('unmerges and merges a range of columns together', () => {
    let view = withMerge(EMPTY_VIEW, 'L1', ['customer', 'phone', 'mc'], true)
    expect(view.merges.L1).toHaveLength(3)
    view = withMerge(view, 'L1', ['phone'], false)
    expect(view.merges.L1).toEqual(['customer', 'mc'])
  })

  it('drops the load from the map when its last column is merged back', () => {
    const view = withMerge(withMerge(EMPTY_VIEW, 'L1', ['customer'], true), 'L1', ['customer'], false)
    expect(view.merges).toEqual({})
    expect(isExpanded(view, 'L1')).toBe(false)
  })

  it('never adds the same column twice', () => {
    const view = withMerge(withMerge(EMPTY_VIEW, 'L1', ['customer'], true), 'L1', ['customer', 'phone'], true)
    expect(view.merges.L1).toEqual(['customer', 'phone'])
  })
})
