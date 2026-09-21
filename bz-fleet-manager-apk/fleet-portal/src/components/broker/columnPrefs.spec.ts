import { beforeEach, describe, expect, it } from 'vitest'
import { clearPrefs, loadPrefs, savePrefs } from './columnPrefs'

describe('columnPrefs', () => {
  beforeEach(() => localStorage.clear())
  it('is null until saved, round-trips, and clears', () => {
    expect(loadPrefs()).toBeNull()
    savePrefs({ visibility: { contact: false }, order: ['bol', 'customer'], sizing: { bol: 90 }, density: 'tight' })
    expect(loadPrefs()).toEqual({ visibility: { contact: false }, order: ['bol', 'customer'], sizing: { bol: 90 }, density: 'tight' })
    clearPrefs()
    expect(loadPrefs()).toBeNull()
  })
  it('ignores garbage in storage instead of throwing', () => {
    localStorage.setItem('brokerBoard.columns.v1', '{not json')
    expect(loadPrefs()).toBeNull()
  })
})
