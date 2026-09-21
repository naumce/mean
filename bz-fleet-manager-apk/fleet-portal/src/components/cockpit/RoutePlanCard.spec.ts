import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RoutePlanCard from './RoutePlanCard.vue'
import type { RouteCard } from '../../lib/cockpit/routeCard'

// The panel a dispatcher reads before telling a driver where to stop. Every
// test guards a case where showing a confident value in place of a missing one
// turns into a wrong instruction over the phone.

const card = (over: Partial<RouteCard> = {}): RouteCard => ({
  loadId: 'l1',
  loadRef: 'W-0042',
  origin: 'Omaha, NE',
  destination: 'Springfield, MO',
  status: 'in_progress',
  onRoad: true,
  totalMi: 780,
  drivenMi: 342,
  remainingMi: 438,
  progressPct: 44,
  equipment: 'dry_van',
  weightLbs: 42_000,
  hazmat: null,
  revenueCents: 245_000,
  ratePerMiCents: 314,
  breaks: null,
  fuel: null,
  detention: [],
  ...over,
})

const mountIt = (c: RouteCard) => mount(RoutePlanCard, { props: { card: c } })

describe('RoutePlanCard', () => {
  it('states the lane, the distance and how far in', () => {
    const w = mountIt(card())
    expect(w.text()).toContain('Omaha, NE')
    expect(w.text()).toContain('Springfield, MO')
    expect(w.find('[data-testid="route-progress"]').text()).toMatch(/342.*780/)
  })

  it('claims a truck-legal road ONLY for real provider geometry', () => {
    // The strongest claim the product makes. Asserted over a drawn arc it
    // becomes the fastest way to lose a freight audience.
    expect(mountIt(card({ onRoad: true })).find('[data-testid="route-onroad"]').exists()).toBe(true)
    const arc = mountIt(card({ onRoad: false }))
    expect(arc.find('[data-testid="route-onroad"]').exists()).toBe(false)
    expect(arc.find('[data-testid="route-arc"]').text()).toMatch(/estimate/i)
  })

  it('says distance is unknown rather than showing a zero-mile run', () => {
    const w = mountIt(card({ totalMi: null, drivenMi: null, remainingMi: null, progressPct: null, ratePerMiCents: null }))
    expect(w.find('[data-testid="route-progress"]').text()).toMatch(/unknown|—/i)
    expect(w.text()).not.toMatch(/\b0 mi\b/)
  })

  it('distinguishes a break plan NOT FETCHED from one the engine could not make', () => {
    expect(mountIt(card({ breaks: null })).find('[data-testid="route-breaks-absent"]').text()).toMatch(/not loaded/i)
    const unknown = mountIt(card({ breaks: { known: false, lines: [] } }))
    expect(unknown.find('[data-testid="route-breaks-unknown"]').text()).toMatch(/unknown/i)
  })

  it('says plainly when no break is required, rather than showing an empty list', () => {
    const w = mountIt(card({ breaks: { known: true, lines: [] } }))
    expect(w.find('[data-testid="route-breaks-none"]').exists()).toBe(true)
  })

  it('names the rest stop for each break, and admits where it has no data', () => {
    const w = mountIt(
      card({
        breaks: {
          known: true,
          lines: [
            { atMs: 1, precision: 'routed', hasCoverage: true, best: { name: 'Iowa 80', kind: 'truck_stop', detourMi: 3, spaces: 900 } },
            { atMs: 2, precision: 'estimated', hasCoverage: false, best: null },
          ],
        },
      }),
    )
    expect(w.text()).toContain('Iowa 80')
    // "No coverage" must never read as "nowhere to stop" — that is the version
    // of this screen that strands a driver.
    expect(w.find('[data-testid="route-break-nocoverage"]').text()).toMatch(/no rest data/i)
  })

  it('rounds the detour instead of printing the raw float', () => {
    // Live finding: the card read "+1.1486727122268334 mi". This is a number a
    // dispatcher says out loud to a driver.
    const w = mountIt(
      card({
        breaks: {
          known: true,
          lines: [
            { atMs: 1, precision: 'routed', hasCoverage: true, best: { name: "Love's", kind: 'truck_stop', detourMi: 1.1486727122268334, spaces: null } },
            { atMs: 2, precision: 'routed', hasCoverage: true, best: { name: 'I-35', kind: 'rest_area', detourMi: 14.318537780532452, spaces: null } },
          ],
        },
      }),
    )
    expect(w.text()).toContain('+1.1 mi')
    // Past ten miles the fraction stops carrying information.
    expect(w.text()).toContain('+14 mi')
    expect(w.text()).not.toMatch(/\d\.\d{3}/)
  })

  it('separates "no data here" from "nothing within range"', () => {
    // Two different problems with two different fixes. Telling a dispatcher
    // there is no rest data for an area the registry covers perfectly well
    // sends them off to import data they already have.
    const line = (hasCoverage: boolean) => ({
      known: true,
      lines: [{ atMs: 1, precision: 'routed' as const, hasCoverage, best: null }],
    })
    const noData = mountIt(card({ breaks: line(false) }))
    expect(noData.find('[data-testid="route-break-nocoverage"]').exists()).toBe(true)
    expect(noData.find('[data-testid="route-break-nooption"]').exists()).toBe(false)

    const covered = mountIt(card({ breaks: line(true) }))
    expect(covered.find('[data-testid="route-break-nooption"]').text()).toMatch(/within range/i)
    expect(covered.find('[data-testid="route-break-nocoverage"]').exists()).toBe(false)
  })

  it('shows the fuel buy when there is one, and its absence honestly', () => {
    expect(mountIt(card({ fuel: null })).find('[data-testid="route-fuel-absent"]').exists()).toBe(true)
    const w = mountIt(
      card({
        fuel: {
          known: true,
          burn: { deadheadGal: 12, loadedGal: 108, totalGal: 120, mpgUsed: 6.5 },
          advice: { atSequence: 1, atLabel: 'Springfield, MO', state: 'MO', gallons: 120, centsPerGal: 342, vsLabel: 'Omaha, NE', vsCentsPerGal: 373, savingCents: 3_720 },
          ifta: { byState: [], unattributedGal: 0, complete: true },
        },
      }),
    )
    expect(w.find('[data-testid="route-fuel-advice"]').text()).toContain('Springfield, MO')
    expect(w.find('[data-testid="route-fuel-advice"]').text()).toMatch(/37/)
  })

  it('reports mpg as unknown rather than as zero when none is on file', () => {
    const w = mountIt(
      card({
        fuel: { known: false, burn: { deadheadGal: 0, loadedGal: 0, totalGal: 0, mpgUsed: null }, advice: null, ifta: { byState: [], unattributedGal: 0, complete: true } },
      }),
    )
    expect(w.find('[data-testid="route-fuel-unknown"]').exists()).toBe(true)
  })

  it('blames the missing FUEL PRICES, not the truck, when only prices are absent', () => {
    // Live finding: the card read "No mpg on file" for a truck whose carrier
    // has mpg 7.1 on file. The plan came back not-known because the org has no
    // fuel prices at all — a different gap, owned by a different person. The
    // card sent a dispatcher to chase the wrong fix.
    const w = mountIt(
      card({
        fuel: {
          known: false,
          burn: { deadheadGal: 10, loadedGal: 50, totalGal: 60, mpgUsed: 7.1 },
          advice: null,
          ifta: { byState: [], unattributedGal: 0, complete: true },
        },
      }),
    )
    expect(w.find('[data-testid="route-fuel-unknown"]').exists()).toBe(false)
    expect(w.find('[data-testid="route-fuel-noprices"]').text()).toMatch(/no fuel prices/i)
    // And the burn it CAN compute is still shown — 60 gal at 7.1 mpg is a
    // fact, and withholding it because prices are missing helps nobody.
    expect(w.text()).toContain('7.1')
    expect(w.text()).toContain('60')
  })

  it('does not claim "nothing cheaper" when it never compared anything', () => {
    // "Nothing cheaper found" is a FINDING. With no prices on file the engine
    // made no finding, and reporting one would be an invention.
    const w = mountIt(
      card({
        fuel: { known: false, burn: { deadheadGal: 0, loadedGal: 60, totalGal: 60, mpgUsed: 7.1 }, advice: null, ifta: { byState: [], unattributedGal: 0, complete: true } },
      }),
    )
    expect(w.find('[data-testid="route-fuel-noadvice"]').exists()).toBe(false)
  })

  it('emits close so the map can drop its focus', () => {
    const w = mountIt(card())
    w.find('[data-testid="route-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
})
