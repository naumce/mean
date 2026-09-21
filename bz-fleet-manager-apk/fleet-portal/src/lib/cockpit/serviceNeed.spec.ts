import { describe, expect, it } from 'vitest'
import type { ServiceShop } from '../../stores/fleet'
import { needsService, nearestShop, type ServiceClocks } from './serviceNeed'

const NOW = Date.UTC(2026, 7, 28, 12, 0)
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

const clocks = (over: Partial<ServiceClocks>): ServiceClocks => ({
  inspectionExpiresAt: null,
  registrationExpiresAt: null,
  nextServiceAt: null,
  ...over,
})

describe('needsService', () => {
  it('is true when a clock is already expired', () => {
    expect(needsService(clocks({ nextServiceAt: iso(NOW - DAY) }), NOW)).toBe(true)
  })

  it('is true when a clock is inside the 30-day soon window', () => {
    expect(needsService(clocks({ inspectionExpiresAt: iso(NOW + 10 * DAY) }), NOW)).toBe(true)
  })

  it('is false when every set clock is comfortably in the future', () => {
    expect(needsService(clocks({ nextServiceAt: iso(NOW + 90 * DAY) }), NOW)).toBe(false)
  })

  it('is true when ANY of the three clocks is due, even if the other two are fine', () => {
    expect(
      needsService(
        clocks({ inspectionExpiresAt: iso(NOW + 90 * DAY), registrationExpiresAt: iso(NOW + 90 * DAY), nextServiceAt: iso(NOW - DAY) }),
        NOW,
      ),
    ).toBe(true)
  })

  // The discriminating check this whole module exists to protect: an unset
  // clock is honestly UNKNOWN, never a problem. compliance.ts's own doc
  // draws exactly this line (untracked vs. expired) — this is the same
  // invariant, applied to "does this unit need a shop".
  it('DISCRIMINATION CHECK: a unit with no service clock set at all (all three null/untracked) never needs service', () => {
    expect(needsService(clocks({}), NOW)).toBe(false)
  })

  it('an untracked clock does not count as due even alongside other untracked clocks', () => {
    expect(needsService({ inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null }, NOW)).toBe(false)
  })
})

describe('nearestShop', () => {
  const kc = { lat: 39.0997, lng: -94.5786 } // Kansas City
  const shop = (over: Partial<ServiceShop>): ServiceShop => ({ id: 's1', name: 'Shop', address: '', lat: null, lng: null, phone: null, ...over })

  it('returns the closest geocoded shop by straight-line distance', () => {
    const near = shop({ id: 'near', name: 'Near Shop', lat: 39.2, lng: -94.6 })
    const far = shop({ id: 'far', name: 'Far Shop', lat: 41.88, lng: -87.63 }) // Chicago
    const result = nearestShop(kc, [far, near])
    expect(result?.shop.id).toBe('near')
    expect(result?.miles).toBeGreaterThan(0)
    expect(result!.miles).toBeLessThan(nearestShop(kc, [far])!.miles)
  })

  it('skips ungeocoded shops (null lat/lng) rather than treating them as distance zero', () => {
    const ungeocoded = shop({ id: 'nogeo', lat: null, lng: null })
    const real = shop({ id: 'real', lat: 40, lng: -95 })
    const result = nearestShop(kc, [ungeocoded, real])
    expect(result?.shop.id).toBe('real')
  })

  it('returns null when the org has no geocoded shop at all', () => {
    expect(nearestShop(kc, [shop({ lat: null, lng: null })])).toBeNull()
    expect(nearestShop(kc, [])).toBeNull()
  })
})
