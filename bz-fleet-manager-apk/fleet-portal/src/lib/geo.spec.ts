import { describe, expect, it } from 'vitest'
import { haversineMi } from './geo'

describe('haversineMi', () => {
  it('measures known city pairs within great-circle tolerance', () => {
    // Kansas City -> St. Louis ≈ 238 great-circle miles.
    const kcStl = haversineMi(39.0997, -94.5786, 38.627, -90.1994)
    expect(kcStl).toBeGreaterThan(225)
    expect(kcStl).toBeLessThan(250)
    expect(haversineMi(39.1, -94.6, 39.1, -94.6)).toBe(0)
  })
})
