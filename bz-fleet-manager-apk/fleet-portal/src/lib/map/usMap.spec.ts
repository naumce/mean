import { describe, expect, it } from 'vitest'
import { inBounds, project, US_OUTLINE } from './usMap'

describe('project', () => {
  it('maps the bounds corners to the padded canvas corners', () => {
    // NW corner (lat max, lng min) -> top-left pad.
    expect(project(50, -125, 800, 400)).toEqual({ x: 16, y: 16 })
    // SE corner (lat min, lng max) -> bottom-right pad.
    expect(project(24, -66, 800, 400)).toEqual({ x: 784, y: 384 })
  })

  it('is monotonic: further east is further right, further north is further up', () => {
    const kc = project(39.0997, -94.5786, 800, 400)
    const nyc = project(40.7128, -74.006, 800, 400)
    expect(nyc.x).toBeGreaterThan(kc.x)
    expect(nyc.y).toBeLessThan(kc.y)
  })
})

describe('inBounds', () => {
  it('accepts the lower 48 and rejects elsewhere', () => {
    expect(inBounds(39.1, -94.6)).toBe(true) // Kansas City
    expect(inBounds(61.2, -149.9)).toBe(false) // Anchorage
    expect(inBounds(41.99, 21.43)).toBe(false) // Skopje
  })
})

describe('US_OUTLINE', () => {
  it('is a closed-ish polygon fully inside the projection bounds', () => {
    expect(US_OUTLINE.length).toBeGreaterThan(30)
    for (const [lat, lng] of US_OUTLINE) {
      expect(inBounds(lat, lng)).toBe(true)
    }
  })
})
