import { describe, expect, it } from 'vitest'
import { autoMap, buildRows, missingRequired, normalizeHeader, parseCsv } from './importMapping'

describe('parseCsv', () => {
  it('parses plain rows and trims unquoted cells', () => {
    expect(parseCsv('a, b ,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('honors quotes, escaped quotes, and commas inside quotes', () => {
    expect(parseCsv('"St. Louis, MO","say ""hi""",x')).toEqual([['St. Louis, MO', 'say "hi"', 'x']])
  })

  it('handles CRLF and skips blank lines', () => {
    expect(parseCsv('a,b\r\n\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('normalizeHeader', () => {
  it('lowercases and strips separators', () => {
    expect(normalizeHeader('Pickup Address')).toBe('pickupaddress')
    expect(normalizeHeader('PU_Address')).toBe('puaddress')
    expect(normalizeHeader('Load #')).toBe('load')
  })
})

describe('autoMap', () => {
  it('matches exact keys and known aliases regardless of casing/spacing', () => {
    const mapping = autoMap(['Load #', 'Equipment Type', 'Origin', 'Consignee Address', 'Linehaul'], 'loads')
    expect(mapping).toEqual(['externalId', 'requiredEquip', 'pickupAddress', 'deliveryAddress', 'revenueCents'])
  })

  it('leaves unknown headers unmapped and never claims a field twice', () => {
    const mapping = autoMap(['Load #', 'Load Number', 'Broker Notes'], 'loads')
    expect(mapping).toEqual(['externalId', null, null])
  })

  it('maps driver and hos exports', () => {
    expect(autoMap(['Driver Email', 'Full Name', 'Cell'], 'drivers')).toEqual(['email', 'name', 'phone'])
    expect(autoMap(['email', 'Drive Remaining', 'Shift Remaining', 'Cycle', 'Since Break'], 'hos')).toEqual([
      'email', 'driveRemainingMin', 'windowRemainingMin', 'cycleRemainingMin', 'minutesSinceBreak',
    ])
  })
})

describe('buildRows', () => {
  it('renames mapped columns, drops ignored ones, omits empty cells', () => {
    const rows = buildRows(
      [
        ['L-1', 'DryVan', 'note', ''],
        ['L-2', 'Reefer', '', '52000'],
      ],
      ['externalId', 'requiredEquip', null, 'revenueCents'],
    )
    expect(rows).toEqual([
      { externalId: 'L-1', requiredEquip: 'DryVan' },
      { externalId: 'L-2', requiredEquip: 'Reefer', revenueCents: '52000' },
    ])
  })
})

describe('missingRequired', () => {
  it('reports required fields the mapping does not cover', () => {
    const missing = missingRequired(['externalId', null], 'loads')
    expect(missing.map((f) => f.key)).toEqual(['requiredEquip', 'pickupAddress', 'deliveryAddress'])
  })

  it('is empty when everything required is mapped', () => {
    expect(
      missingRequired(['externalId', 'requiredEquip', 'pickupAddress', 'deliveryAddress'], 'loads'),
    ).toEqual([])
  })
})
