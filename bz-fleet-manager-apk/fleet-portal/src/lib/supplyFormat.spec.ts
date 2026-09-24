import { describe, expect, it } from 'vitest'
import {
  currentLabel,
  driveRemainingLabel,
  driverLanguages,
  isHosStale,
  projectedAvailabilityLabel,
  statusLabel,
  statusMarkerColor,
} from './supplyFormat'

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

describe('statusLabel', () => {
  it('splits and capitalizes each word', () => {
    expect(statusLabel('AVAILABLE')).toBe('Available')
    expect(statusLabel('AVAILABLE_SOON')).toBe('Available Soon')
    expect(statusLabel('ON_LOAD')).toBe('On Load')
    expect(statusLabel('OFF_DUTY')).toBe('Off Duty')
    expect(statusLabel('UNAVAILABLE')).toBe('Unavailable')
  })
})

describe('statusMarkerColor', () => {
  it('returns one hex colour per status', () => {
    expect(statusMarkerColor('AVAILABLE')).toBe('#10b981')
    expect(statusMarkerColor('UNAVAILABLE')).toBe('#ef4444')
  })
})

describe('driverLanguages', () => {
  it('unions languages with preferredLanguage, deduplicated', () => {
    expect(driverLanguages({ languages: ['en', 'es'], preferredLanguage: 'en' })).toEqual(['en', 'es'])
    expect(driverLanguages({ languages: [], preferredLanguage: 'fr' })).toEqual(['fr'])
  })
})

describe('driveRemainingLabel', () => {
  it('formats minutes as h:mm', () => {
    expect(driveRemainingLabel(495)).toBe('8:15')
    expect(driveRemainingLabel(0)).toBe('0:00')
    expect(driveRemainingLabel(65)).toBe('1:05')
  })
})

// --- currentLabel / nearPlaceText — the four CURRENT-column states --------

describe('currentLabel', () => {
  it('state 1: "at {city}, {state}" when within AT_THRESHOLD_MI, plus the age suffix', () => {
    const current = { lat: 41.65, lng: -83.53, at: NOW - 4 * 60_000, near: { city: 'Toledo', state: 'OH', distanceMi: 2 } }
    expect(currentLabel(current, NOW)).toBe('at Toledo, OH · 4m')
  })

  it('state 2: "near {city}, {state} · {N} mi" beyond the at-threshold', () => {
    const current = { lat: 41.65, lng: -83.53, at: NOW - 4 * 60_000, near: { city: 'Toledo', state: 'OH', distanceMi: 12.4 } }
    expect(currentLabel(current, NOW)).toBe('near Toledo, OH · 12 mi · 4m')
  })

  it('state 3: "ping received" when a ping exists but near is null (>150mi from any gazetteer place)', () => {
    const current = { lat: 0, lng: 0, at: NOW - 4 * 60_000, near: null }
    expect(currentLabel(current, NOW)).toBe('ping received · 4m')
  })

  it('state 4: "no ping" when there is no current ping at all', () => {
    expect(currentLabel(null, NOW)).toBe('no ping')
  })
})

// --- projectedAvailabilityLabel --------------------------------------------

describe('projectedAvailabilityLabel', () => {
  const whenLabel = (ms: number): string => `WHEN(${ms})`

  it('renders "now" when availableAt is in the past', () => {
    const label = projectedAvailabilityLabel({ city: null, state: null }, NOW - 1000, NOW, whenLabel)
    expect(label).toBe('Unknown location · now')
  })

  it('renders "now" when availableAt equals nowMs exactly (the <= boundary)', () => {
    const label = projectedAvailabilityLabel({ city: 'Omaha', state: 'NE' }, NOW, NOW, whenLabel)
    expect(label).toBe('Omaha, NE · now')
  })

  it('falls back to "Unknown location" when neither city nor state is known', () => {
    const label = projectedAvailabilityLabel({ city: null, state: null }, NOW + 1000, NOW, whenLabel)
    expect(label).toBe(`Unknown location · WHEN(${NOW + 1000})`)
  })

  it('renders "{city}, {state}" plus the injected whenLabel for a future time', () => {
    const label = projectedAvailabilityLabel({ city: 'Omaha', state: 'NE' }, NOW + 3_600_000, NOW, whenLabel)
    expect(label).toBe(`Omaha, NE · WHEN(${NOW + 3_600_000})`)
  })

  it('uses whichever of city/state is known when only one is present', () => {
    expect(projectedAvailabilityLabel({ city: 'Omaha', state: null }, NOW + 1000, NOW, whenLabel)).toBe(`Omaha · WHEN(${NOW + 1000})`)
    expect(projectedAvailabilityLabel({ city: null, state: 'NE' }, NOW + 1000, NOW, whenLabel)).toBe(`NE · WHEN(${NOW + 1000})`)
  })
})

// --- isHosStale -------------------------------------------------------------

describe('isHosStale', () => {
  const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000

  it('is not stale exactly at the 8h boundary (> not >=)', () => {
    const updatedAt = new Date(NOW - EIGHT_HOURS_MS).toISOString()
    expect(isHosStale(updatedAt, NOW)).toBe(false)
  })

  it('is stale one ms past the 8h boundary', () => {
    const updatedAt = new Date(NOW - EIGHT_HOURS_MS - 1).toISOString()
    expect(isHosStale(updatedAt, NOW)).toBe(true)
  })

  it('is not stale well within the window', () => {
    expect(isHosStale(new Date(NOW - 60_000).toISOString(), NOW)).toBe(false)
  })

  it('is stale well beyond the window', () => {
    expect(isHosStale(new Date(NOW - 24 * 60 * 60 * 1000).toISOString(), NOW)).toBe(true)
  })
})
