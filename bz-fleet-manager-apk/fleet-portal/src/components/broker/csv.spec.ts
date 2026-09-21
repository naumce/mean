import { describe, expect, it } from 'vitest'
import { boardCsv, toCsv } from './csv'

describe('toCsv', () => {
  it('writes a header and its rows', () => {
    expect(toCsv(['BOL#', 'RATE'], [['0500001', '$4,000.00']])).toBe('BOL#,RATE\r\n0500001,"$4,000.00"')
  })

  it('quotes a cell that holds a comma, a quote or a newline', () => {
    expect(toCsv(['UPDATE'], [['DELIVERED, POD sent']])).toContain('"DELIVERED, POD sent"')
    expect(toCsv(['UPDATE'], [['he said "ok"']])).toContain('"he said ""ok"""')
    expect(toCsv(['UPDATE'], [['PU 07/13\nDEL 07/15']])).toContain('"PU 07/13\nDEL 07/15"')
  })

  it('leaves an ordinary cell alone', () => {
    expect(toCsv(['CUSTOMER'], [['ACME FOODS']])).toBe('CUSTOMER\r\nACME FOODS')
  })
})

describe('boardCsv', () => {
  it('writes the carrier line under its customer line, the way the board reads', () => {
    const csv = boardCsv(
      [{ label: 'CUSTOMER' }, { label: 'RATE' }],
      [
        { top: ['ACME', '$4,000.00'], bottom: ['BLUE ROAD', ''] },
        { top: ['BETA', '$2,000.00'], bottom: null },
      ],
    )
    expect(csv.split('\r\n')).toEqual([
      'CUSTOMER,RATE',
      'ACME,"$4,000.00"',
      'BLUE ROAD,',
      'BETA,"$2,000.00"',
    ])
  })

  it('writes a header even when nothing survived the filters', () => {
    expect(boardCsv([{ label: 'BOL#' }], [])).toBe('BOL#')
  })
})
