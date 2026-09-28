import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ProposalCard from './ProposalCard.vue'
import type { Baseline, Proposal } from '../../types/aiLab'

function baseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    capturedAt: '2026-09-25T00:00:00.000Z',
    requiredEquip: 'DryVan',
    note: null,
    candidates: [
      { driverId: 'd1', driverName: 'Alice', feasible: true, score: 91, deadheadMi: 12, marginCents: 40000, etaMs: 0, blockedReason: null, context: null },
      { driverId: 'd2', driverName: 'Bob', feasible: true, score: 80, deadheadMi: 30, marginCents: 30000, etaMs: 0, blockedReason: null, context: null },
      { driverId: 'd3', driverName: 'Cara', feasible: false, score: null, deadheadMi: 5, marginCents: 0, etaMs: 0, blockedReason: 'HOS exhausted', context: null },
    ],
    feasibleDriverIds: ['d1', 'd2'],
    topFeasibleDriverId: 'd1',
    ...overrides,
  }
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return { driverId: 'd2', reason: 'Closer and available sooner', confidence: 0.72, alternatives: [], ...overrides }
}

describe('ProposalCard', () => {
  it('shows the deterministic top candidate (name, score, deadhead)', () => {
    const wrapper = mount(ProposalCard, { props: { proposal: proposal(), baseline: baseline(), driverNames: { d1: 'Alice', d2: 'Bob' } } })
    const top = wrapper.find('[data-testid="proposal-baseline"]')
    expect(top.text()).toContain('Alice')
    expect(top.text()).toContain('91')
    expect(top.text()).toContain('12 mi')
  })

  it('computes the rank of the pick from the baseline order (1-based)', () => {
    const wrapper = mount(ProposalCard, { props: { proposal: proposal({ driverId: 'd2' }), baseline: baseline(), driverNames: { d2: 'Bob' } } })
    expect(wrapper.find('[data-testid="proposal-rank"]').text()).toContain('ranks #2 of 3')
  })

  it('reports the pick does not appear in the baseline when it is not one of the candidates', () => {
    const wrapper = mount(ProposalCard, { props: { proposal: proposal({ driverId: 'd9' }), baseline: baseline() } })
    expect(wrapper.find('[data-testid="proposal-rank"]').text()).toContain('does not appear')
  })

  it('a null driverId renders "no driver recommended" instead of a rank', () => {
    const wrapper = mount(ProposalCard, { props: { proposal: proposal({ driverId: null, confidence: 0 }), baseline: baseline() } })
    expect(wrapper.find('[data-testid="proposal-driver"]').text()).toBe('no driver recommended')
    expect(wrapper.find('[data-testid="proposal-rank"]').text()).toContain('no driver recommended')
  })

  it('renders "No proposal yet." when there is no proposal at all', () => {
    const wrapper = mount(ProposalCard, { props: { proposal: null, baseline: baseline() } })
    expect(wrapper.find('[data-testid="proposal-none"]').exists()).toBe(true)
  })

  it('renders "No deterministic baseline captured." when there is no baseline', () => {
    const wrapper = mount(ProposalCard, { props: { proposal: proposal(), baseline: null } })
    expect(wrapper.find('[data-testid="baseline-none"]').exists()).toBe(true)
  })

  // dispatch-v2 A/B experiment: the run's prompt version, shown as a plain
  // chip — absent (not blank) when the run predates the registry.
  it('shows the prompt version chip when provided, and omits it otherwise', () => {
    const withVersion = mount(ProposalCard, { props: { proposal: proposal(), baseline: baseline(), promptVersion: 'dispatch-v2' } })
    expect(withVersion.find('[data-testid="proposal-prompt-version"]').text()).toBe('dispatch-v2')

    const withoutVersion = mount(ProposalCard, { props: { proposal: proposal(), baseline: baseline() } })
    expect(withoutVersion.find('[data-testid="proposal-prompt-version"]').exists()).toBe(false)
  })
})
