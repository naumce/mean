import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SuggestModal from './SuggestModal.vue'
import type { CandidateContext, SuggestResult, ScenarioHint } from '../../stores/loadboard'

function sampleContext(): CandidateContext {
  return {
    availability: {
      driverId: 'd1', acceptingLoads: true, locationSharingEnabled: true, locationSharingUpdatedAt: null,
      shareToken: 'tok-1', status: 'AVAILABLE', availableAt: Date.now() - 1000,
      available: { lat: 41.6, lng: -83.5, city: 'Toledo', state: 'OH' },
      current: null, currentAssignment: null, source: 'derived',
    },
    estimatedArrivalAtPickupMs: Date.now() + 3_600_000,
    hosRemaining: { driveMin: 495, windowMin: 600, known: true },
    lane: { key: 'l1', label: 'Toledo, OH > Detroit, MI' },
    laneRuns: 2,
    onTimeRate: 0.9,
    responseRate: 0.8,
    noResponseIncidents: 0,
    homeTime: { homeBaseCity: null, homeBaseState: null, deliveryToHomeMi: null, withinRelocate: null },
    preferences: null,
    qualifications: { equipmentTypes: ['DryVan'], endorsements: [], hazmatEndorsed: false },
  }
}

function result(overrides: Partial<SuggestResult> = {}): SuggestResult {
  return {
    loadId: 'l1', requiredEquip: 'DryVan', tractorId: 't1', trailerId: 'tr1',
    candidates: [
      {
        driverId: 'd1', driverName: 'Milan Petrovski', feasible: true, score: 88,
        deadheadMi: 40, loadedMi: 200, etaMs: Date.now(), marginCents: 50000, marginPct: 0.3, warnings: [],
      },
    ],
    ...overrides,
  }
}

function blockedRow(overrides: Partial<SuggestResult['candidates'][number]> = {}) {
  return {
    driverId: 'd2', driverName: 'Dale Blocked', feasible: false, score: null,
    deadheadMi: 12, loadedMi: 0, etaMs: 0, marginCents: 0, marginPct: 0,
    blockedReason: 'needs 19h 5m drive; 11h remaining', warnings: [],
    ...overrides,
  }
}

const BASE_PROPS = {
  loadReference: 'L-1', lane: 'Toledo ➔ Detroit', revenueCents: 150000, loading: false, dispatching: null,
}

describe('SuggestModal', () => {
  it('renders a CandidateContextCell for a row that carries context', () => {
    const wrapper = mount(SuggestModal, {
      props: { ...BASE_PROPS, result: result({ candidates: [{ ...result().candidates[0]!, context: sampleContext() }] }) },
    })
    expect(wrapper.find('[data-testid="candidate-context"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="context-facts"]').text()).toContain('lane runs 2')
  })

  it('renders a row exactly as before (no context cell) when `context` is absent', () => {
    const wrapper = mount(SuggestModal, { props: { ...BASE_PROPS, result: result() } })
    expect(wrapper.find('[data-suggest-row="d1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="candidate-context"]').exists()).toBe(false)
  })

  it('shows the scenario header with code/title, and the hint as a tooltip, only when scenario is given', () => {
    const scenario: ScenarioHint = { code: 'A', title: 'Reliable driver near an uncovered load', hint: 'Milan is close.' }
    const withScenario = mount(SuggestModal, { props: { ...BASE_PROPS, result: result(), scenario } })
    const header = withScenario.find('[data-testid="suggest-scenario"]')
    expect(header.text()).toBe('Scenario A: Reliable driver near an uncovered load')
    expect(header.attributes('title')).toBe('Milan is close.')

    const withoutScenario = mount(SuggestModal, { props: { ...BASE_PROPS, result: result() } })
    expect(withoutScenario.find('[data-testid="suggest-scenario"]').exists()).toBe(false)
  })

  it('a blocked row with context shows the context line, alongside its ✗ reason', () => {
    const wrapper = mount(SuggestModal, {
      props: { ...BASE_PROPS, result: result({ candidates: [blockedRow({ context: sampleContext() })] }) },
    })
    const row = wrapper.find('[data-suggest-blocked-row="d2"]')
    expect(row.exists()).toBe(true)
    expect(row.find('[data-testid="candidate-context"]').exists()).toBe(true)
    expect(row.find('[data-testid="context-facts"]').text()).toContain('lane runs 2')
    expect(row.find('[data-testid="suggest-blocked-reason"]').text()).toBe('✗ needs 19h 5m drive; 11h remaining')
  })

  it('a blocked row without context is unchanged', () => {
    const wrapper = mount(SuggestModal, { props: { ...BASE_PROPS, result: result({ candidates: [blockedRow()] }) } })
    const row = wrapper.find('[data-suggest-blocked-row="d2"]')
    expect(row.exists()).toBe(true)
    expect(row.find('[data-testid="candidate-context"]').exists()).toBe(false)
    expect(row.find('[data-testid="suggest-blocked-reason"]').text()).toBe('✗ needs 19h 5m drive; 11h remaining')
  })
})
