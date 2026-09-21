import { describe, expect, it } from 'vitest'
import type { BoardLoad } from '../../lib/api'
import { BLANK, groupKeys, groupRows, moneyOf, type GroupField } from './grouping'

const load = (id: string, customer: string, ship: string, rate: string, sold: string, profit: string, carrier = ''): BoardLoad =>
  ({ id, line: 1, top: { customer, shipDate: ship, rate, soldRate: sold, profit }, bottom: carrier ? { customer: carrier } : null, pill: { state: 'none', text: null }, agentLine: null, status: 'open', boardLine: 1, version: 0 })

const byCustomer: GroupField = { id: 'customer', label: 'CUSTOMER', read: (l) => l.top.customer ?? '' }
const byShip: GroupField = { id: 'shipDate', label: 'SHIP DATE', read: (l) => l.top.shipDate ?? '' }
const byCarrier: GroupField = { id: 'carrier', label: 'CARRIER', read: (l) => l.bottom?.customer ?? '' }

const loads = [
  load('a', 'ACME', '7/13/2026', '$4,000.00', '$3,600.00', '$400.00', 'BLUE'),
  load('b', 'BETA', '7/13/2026', '$2,000.00', '$1,500.00', '$500.00'),
  load('c', 'ACME', '7/14/2026', '$1,000.00', '$900.00', '$100.00', 'BLUE'),
]

describe('moneyOf', () => {
  it('reads their sheet, and treats anything that is not money as nothing', () => {
    expect(moneyOf('$4,000.00')).toBe(4000)
    expect(moneyOf('2500')).toBe(2500)
    expect(moneyOf('-$300.50')).toBe(-300.5)
    expect(moneyOf('')).toBe(0)
    expect(moneyOf('call john')).toBe(0)
    expect(moneyOf(undefined)).toBe(0)
  })
})

describe('groupRows', () => {
  it('leaves the board alone when nothing is grouped', () => {
    const items = groupRows(loads, [], {})
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.kind === 'load')).toBe(true)
  })

  it('groups by one field, totals the money, and counts the loads', () => {
    const items = groupRows(loads, [byCustomer], {})
    const groups = items.filter((i) => i.kind === 'group')
    expect(groups.map((g) => (g.kind === 'group' ? g.value : ''))).toEqual(['ACME', 'BETA'])
    const acme = groups[0]
    expect(acme.kind === 'group' && acme.count).toBe(2)
    expect(acme.kind === 'group' && acme.totals).toEqual({ rate: 5000, sold: 4500, profit: 500 })
    // The loads follow their own group header, in the order they came in.
    expect(items.map((i) => (i.kind === 'load' ? i.load.id : `[${i.value}]`))).toEqual(['[ACME]', 'a', 'c', '[BETA]', 'b'])
  })

  it('nests groups, and keeps each level totalled', () => {
    const items = groupRows(loads, [byShip, byCustomer], {})
    expect(items.map((i) => (i.kind === 'group' ? `${i.level}:${i.value}` : i.load.id))).toEqual([
      '0:7/13/2026', '1:ACME', 'a', '1:BETA', 'b',
      '0:7/14/2026', '1:ACME', 'c',
    ])
  })

  it('collapses one group without touching the same value under another parent', () => {
    const items = groupRows(loads, [byShip, byCustomer], {})
    const acmeUnder13 = items.find((i) => i.kind === 'group' && i.level === 1 && i.value === 'ACME')
    const key = acmeUnder13?.kind === 'group' ? acmeUnder13.key : ''
    const collapsed = groupRows(loads, [byShip, byCustomer], { [key]: true })
    expect(collapsed.map((i) => (i.kind === 'group' ? `${i.level}:${i.value}` : i.load.id))).toEqual([
      '0:7/13/2026', '1:ACME', '1:BETA', 'b',
      '0:7/14/2026', '1:ACME', 'c',
    ])
  })

  it('reads the carrier off the second line', () => {
    const items = groupRows(loads, [byCarrier], {})
    expect(items.filter((i) => i.kind === 'group').map((g) => (g.kind === 'group' ? g.value : ''))).toEqual(['BLUE', BLANK])
  })

  it('sinks the blank group to the bottom and sorts the rest naturally', () => {
    const numbered = [load('x', 'Load 10', '', '', '', ''), load('y', '', '', '', '', ''), load('z', 'Load 2', '', '', '', '')]
    const values = groupRows(numbered, [byCustomer], {}).filter((i) => i.kind === 'group').map((g) => (g.kind === 'group' ? g.value : ''))
    expect(values).toEqual(['Load 2', 'Load 10', BLANK])
  })

  it('keeps the index of each load in the ungrouped order, so a selection still points somewhere', () => {
    const items = groupRows(loads, [byCustomer], {})
    const ids = items.filter((i) => i.kind === 'load').map((i) => (i.kind === 'load' ? [i.load.id, i.index] : []))
    expect(ids).toEqual([['a', 0], ['c', 2], ['b', 1]])
  })

  it('hands back every group key for collapse-all', () => {
    expect(groupKeys(groupRows(loads, [byShip, byCustomer], {}))).toHaveLength(5)
  })
})
