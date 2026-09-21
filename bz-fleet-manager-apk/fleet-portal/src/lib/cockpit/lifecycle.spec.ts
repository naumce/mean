import { describe, expect, it } from 'vitest'
import { progressShare, stepIndex, stepSegs, STEPS8 } from './lifecycle'

describe('lifecycle derivation', () => {
  it('four-segment step bar by status', () => {
    expect(stepSegs('completed')).toEqual(['done', 'done', 'done', 'done'])
    expect(stepSegs('in_progress')).toEqual(['done', 'done', 'current', 'pending'])
    expect(stepSegs('assigned')).toEqual(['done', 'current', 'pending', 'pending'])
    expect(stepSegs('tendered')).toEqual(['current', 'pending', 'pending', 'pending'])
    expect(stepSegs(undefined)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('eight-step index', () => {
    const t0 = 1_000_000
    expect(STEPS8).toHaveLength(8)
    expect(stepIndex('tendered', t0, t0)).toBe(0)
    expect(stepIndex('assigned', t0 + 3_600_000, t0)).toBe(1) // dispatched, not yet at pickup
    expect(stepIndex('assigned', t0 - 1, t0)).toBe(2) // start passed -> at pickup
    expect(stepIndex('in_progress', t0, t0)).toBe(4)
    expect(stepIndex('completed', t0, t0)).toBe(6)
    expect(stepIndex('completed', t0, t0, true)).toBe(7)
  })

  it('progress share of the planned window', () => {
    expect(progressShare('in_progress', 0, 100, 38)).toBeCloseTo(0.38)
    expect(progressShare('in_progress', 0, 100, 500)).toBe(1)
    expect(progressShare('in_progress', 0, 0, 5)).toBe(1)
    expect(progressShare('completed', 0, 100, 10)).toBe(1)
    expect(progressShare('assigned', 0, 100, 50)).toBe(0)
  })
})
