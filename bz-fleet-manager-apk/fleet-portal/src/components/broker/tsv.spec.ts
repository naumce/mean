import { describe, expect, it } from 'vitest'
import { fromTsv, planPaste, toTsv } from './tsv'

describe('toTsv', () => {
  it('writes what a spreadsheet reads', () => {
    expect(toTsv([['ACME', '$4,000.00'], ['BETA', '$2,500.00']])).toBe('ACME\t$4,000.00\nBETA\t$2,500.00')
  })

  it('flattens a cell that contains a tab or a newline', () => {
    // Their UPDATE cell really does hold newlines; pasted back, one would
    // become an extra row and everything below it would shift a line.
    expect(toTsv([['DELIVERED\n07/15', 'x\ty']])).toBe('DELIVERED 07/15\tx y')
  })
})

describe('fromTsv', () => {
  it('reads a block back', () => {
    expect(fromTsv('ACME\t4000\nBETA\t2500')).toEqual([['ACME', '4000'], ['BETA', '2500']])
  })

  it('ignores the trailing newline Excel and Sheets add', () => {
    expect(fromTsv('ACME\t4000\n')).toEqual([['ACME', '4000']])
    expect(fromTsv('ACME\t4000\r\nBETA\t2500\r\n')).toEqual([['ACME', '4000'], ['BETA', '2500']])
  })

  it('reads one cell, and nothing at all', () => {
    expect(fromTsv('ACME')).toEqual([['ACME']])
    expect(fromTsv('')).toEqual([])
    expect(fromTsv('\n')).toEqual([])
  })

  it('keeps empty cells, which are how a paste clears one', () => {
    expect(fromTsv('ACME\t\t4000')).toEqual([['ACME', '', '4000']])
  })
})

describe('planPaste', () => {
  it('lays the block down from the anchor', () => {
    const plan = planPaste([['a', 'b'], ['c', 'd']], { r: 1, c: 2 }, { rows: 5, cols: 6 })
    expect(plan.targets).toEqual([
      { r: 1, c: 2, value: 'a' }, { r: 1, c: 3, value: 'b' },
      { r: 2, c: 2, value: 'c' }, { r: 2, c: 3, value: 'd' },
    ])
    expect(plan.clipped).toBe(false)
  })

  it('stops at the last row and column rather than growing the board', () => {
    // Pasting 30 rows onto the last row of a board must not invent 29 loads
    // nobody asked for; the grid says it was clipped.
    const plan = planPaste([['a', 'b'], ['c', 'd']], { r: 1, c: 1 }, { rows: 2, cols: 2 })
    expect(plan.targets).toEqual([{ r: 1, c: 1, value: 'a' }])
    expect(plan.clipped).toBe(true)
  })

  it('has nothing to do with an empty clipboard', () => {
    expect(planPaste([], { r: 0, c: 0 }, { rows: 3, cols: 3 })).toEqual({ targets: [], clipped: false })
  })
})
