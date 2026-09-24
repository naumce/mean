import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CandidateContextCell from './CandidateContextCell.vue'
import type { CandidateContext } from '../../stores/loadboard'

function context(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return {
    availability: {
      driverId: 'd1',
      acceptingLoads: true,
      locationSharingEnabled: true,
      locationSharingUpdatedAt: null,
      shareToken: 'tok-1',
      status: 'AVAILABLE',
      availableAt: Date.now() - 1000,
      available: { lat: 41.6, lng: -83.5, city: 'Toledo', state: 'OH' },
      current: null,
      currentAssignment: null,
      source: 'derived',
    },
    estimatedArrivalAtPickupMs: Date.now() + 3_600_000,
    hosRemaining: { driveMin: 495, windowMin: 600, known: true },
    lane: { key: 'lane-1', label: 'Toledo, OH > Detroit, MI' },
    laneRuns: 3,
    onTimeRate: 0.96,
    responseRate: 0.61,
    noResponseIncidents: 0,
    homeTime: { homeBaseCity: 'Grand Rapids', homeBaseState: 'MI', deliveryToHomeMi: 42, withinRelocate: false },
    preferences: {
      maxTripMiles: null,
      willingToDriveNight: true,
      preferredEquipment: ['DryVan'],
      matchesEquipmentPref: true,
      laneAvoided: false,
      regionAvoided: false,
    },
    qualifications: { equipmentTypes: ['DryVan'], endorsements: [], hazmatEndorsed: false },
    ...overrides,
  }
}

describe('CandidateContextCell', () => {
  it('renders the availability status chip and the joined fact line', () => {
    const wrapper = mount(CandidateContextCell, { props: { context: context() } })
    expect(wrapper.find('[data-testid="context-status-chip"]').text()).toBe('Available')
    const facts = wrapper.find('[data-testid="context-facts"]').text()
    expect(facts).toContain('avail Toledo, OH · now')
    expect(facts).toContain('at pickup ≈')
    expect(facts).toContain('HOS 8h 15m drive')
    expect(facts).toContain('lane runs 3')
    expect(facts).toContain('on-time 96%')
    expect(facts).toContain('reply 61%')
    expect(facts).toContain('42 mi to home')
    expect(facts).toContain('equip pref ✓')
  })

  it('shows "HOS not imported" when hos is unknown', () => {
    const wrapper = mount(CandidateContextCell, {
      props: { context: context({ hosRemaining: { driveMin: null, windowMin: null, known: false } }) },
    })
    expect(wrapper.find('[data-testid="context-facts"]').text()).toContain('HOS not imported')
  })

  it('shows "—" placeholders for null on-time/response/home evidence, and omits no-reply at zero', () => {
    const wrapper = mount(CandidateContextCell, {
      props: {
        context: context({
          onTimeRate: null,
          responseRate: null,
          homeTime: { homeBaseCity: null, homeBaseState: null, deliveryToHomeMi: null, withinRelocate: null },
          noResponseIncidents: 0,
        }),
      },
    })
    const facts = wrapper.find('[data-testid="context-facts"]').text()
    expect(facts).toContain('on-time —')
    expect(facts).toContain('reply —')
    expect(facts).toContain('— to home')
    expect(facts).not.toContain('no-reply')
  })

  it('shows "no-reply ×N" only when noResponseIncidents is greater than zero', () => {
    const wrapper = mount(CandidateContextCell, { props: { context: context({ noResponseIncidents: 3 }) } })
    expect(wrapper.find('[data-testid="context-facts"]').text()).toContain('no-reply ×3')
  })

  it('shows the home-time fit chip only when withinRelocate is true', () => {
    const fits = mount(CandidateContextCell, {
      props: { context: context({ homeTime: { homeBaseCity: 'GR', homeBaseState: 'MI', deliveryToHomeMi: 10, withinRelocate: true } }) },
    })
    expect(fits.find('[data-testid="context-home-fit-chip"]').exists()).toBe(true)

    const doesNotFit = mount(CandidateContextCell, { props: { context: context() } }) // withinRelocate: false
    expect(doesNotFit.find('[data-testid="context-home-fit-chip"]').exists()).toBe(false)
  })

  it('shows avoids-lane / avoids-region chips only when true, and hides all preference output when preferences is null', () => {
    const avoids = mount(CandidateContextCell, {
      props: {
        context: context({
          preferences: {
            maxTripMiles: null, willingToDriveNight: true, preferredEquipment: [],
            matchesEquipmentPref: false, laneAvoided: true, regionAvoided: true,
          },
        }),
      },
    })
    expect(avoids.find('[data-testid="context-avoids-lane-chip"]').exists()).toBe(true)
    expect(avoids.find('[data-testid="context-avoids-region-chip"]').exists()).toBe(true)
    expect(avoids.find('[data-testid="context-facts"]').text()).toContain('equip pref ✗')

    const noPrefs = mount(CandidateContextCell, { props: { context: context({ preferences: null }) } })
    expect(noPrefs.find('[data-testid="context-avoids-lane-chip"]').exists()).toBe(false)
    expect(noPrefs.find('[data-testid="context-avoids-region-chip"]').exists()).toBe(false)
    expect(noPrefs.find('[data-testid="context-facts"]').text()).not.toContain('equip pref')
  })

  it('renders a qualification chip per equipment type, and a HAZMAT chip only when endorsed', () => {
    const wrapper = mount(CandidateContextCell, {
      props: {
        context: context({ qualifications: { equipmentTypes: ['DryVan', 'Reefer'], endorsements: ['H'], hazmatEndorsed: true } }),
      },
    })
    expect(wrapper.text()).toContain('DryVan')
    expect(wrapper.text()).toContain('Reefer')
    expect(wrapper.find('[data-testid="context-hazmat-chip"]').exists()).toBe(true)

    const noHazmat = mount(CandidateContextCell, { props: { context: context() } })
    expect(noHazmat.find('[data-testid="context-hazmat-chip"]').exists()).toBe(false)
  })
})
