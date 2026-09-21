import { describe, expect, it } from 'vitest'
import { trendArrow, trendDelta, trendPctLabel } from './trend'

describe('trendDelta', () => {
  it('computes direction and fractional change', () => {
    expect(trendDelta(120, 100)).toEqual({ dir: 'up', pct: 0.2 })
    expect(trendDelta(80, 100)).toEqual({ dir: 'down', pct: -0.2 })
    expect(trendDelta(100, 100)).toEqual({ dir: 'flat', pct: 0 })
  })

  it('has no percentage without a baseline', () => {
    expect(trendDelta(50, 0)).toEqual({ dir: 'up', pct: null })
    expect(trendDelta(0, 0)).toEqual({ dir: 'flat', pct: null })
  })
})

describe('labels', () => {
  it('renders arrows and percent text', () => {
    expect(trendArrow(trendDelta(120, 100))).toBe('↑')
    expect(trendArrow(trendDelta(80, 100))).toBe('↓')
    expect(trendPctLabel(trendDelta(120, 100))).toBe('20%')
    expect(trendPctLabel(trendDelta(50, 0))).toBe('new')
  })
})
