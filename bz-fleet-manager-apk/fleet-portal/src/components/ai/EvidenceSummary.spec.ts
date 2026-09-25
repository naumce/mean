import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EvidenceSummary from './EvidenceSummary.vue'
import type { Evidence } from '../../types/aiLab'

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    toolsCalled: [{ name: 'findFeasibleDrivers', count: 1 }, { name: 'getDriverMetrics', count: 2 }],
    candidatesInspected: ['d1', 'd2'],
    feasibilitySeen: [
      { driverId: 'd1', feasible: true, score: 91, blockedReason: null, source: 'baseline' },
      { driverId: 'd3', feasible: false, score: null, blockedReason: 'HOS exhausted', source: 'tool' },
    ],
    metricsInspected: ['d1'],
    historyInspected: ['d1'],
    factsCited: [{ text: 'closer and available sooner', forDriverId: 'd1' }, { text: 'no feasible driver had lower deadhead', forDriverId: null }],
    supportingSteps: [2, 5],
    proposalAttempts: 3,
    ...overrides,
  }
}

describe('EvidenceSummary', () => {
  it('renders all seven list/count fields with their counts', () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence() } })
    expect(wrapper.find('[data-testid="evidence-tools-called"]').text()).toContain('tools called (2)')
    expect(wrapper.find('[data-testid="evidence-candidates-inspected"]').text()).toContain('candidates inspected (2)')
    expect(wrapper.find('[data-testid="evidence-feasibility-seen"]').text()).toContain('feasibility seen (2)')
    expect(wrapper.find('[data-testid="evidence-metrics-inspected"]').text()).toContain('metrics inspected (1)')
    expect(wrapper.find('[data-testid="evidence-history-inspected"]').text()).toContain('history inspected (1)')
    expect(wrapper.find('[data-testid="evidence-facts-cited"]').text()).toContain('facts cited (2)')
    expect(wrapper.find('[data-testid="evidence-supporting-steps"]').text()).toContain('supporting steps (2)')
  })

  // Round 2: a plain line, not a <details> section — one number, nothing to
  // expand.
  it('renders proposalAttempts as one plain line', () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence({ proposalAttempts: 3 }) } })
    expect(wrapper.find('[data-testid="evidence-proposal-attempts"]').text()).toBe('proposal attempts: 3')
  })

  it('renders tools called as name x count', () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence() } })
    expect(wrapper.find('[data-testid="evidence-tools-called"]').text()).toContain('findFeasibleDrivers × 1')
    expect(wrapper.find('[data-testid="evidence-tools-called"]').text()).toContain('getDriverMetrics × 2')
  })

  it('renders feasibility seen with driver name, feasible/blocked, score, blockedReason, and a source badge', () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence(), driverNames: { d1: 'Alice' } } })
    const rows = wrapper.findAll('[data-testid="feasibility-row"]')
    expect(rows[0]?.text()).toContain('Alice')
    expect(rows[0]?.text()).toContain('feasible')
    expect(rows[0]?.text()).toContain('score 91')
    expect(rows[0]?.find('[data-testid="feasibility-source"]').text()).toBe('baseline')

    expect(rows[1]?.text()).toContain('d3') // no name given -> falls back to the id
    expect(rows[1]?.text()).toContain('blocked')
    expect(rows[1]?.text()).toContain('HOS exhausted')
    expect(rows[1]?.find('[data-testid="feasibility-source"]').text()).toBe('tool')
  })

  it('renders facts cited with each fact\'s driver, and without a driver prefix when forDriverId is null', () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence(), driverNames: { d1: 'Alice' } } })
    const facts = wrapper.findAll('[data-testid="fact-cited-row"]')
    expect(facts[0]?.text()).toBe('Alice: closer and available sooner')
    expect(facts[1]?.text()).toBe('no feasible driver had lower deadhead')
  })

  it('clicking a supporting step emits select-step with its seq number', async () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence() } })
    const buttons = wrapper.findAll('[data-testid="supporting-step"]')
    expect(buttons.map((b) => b.text())).toEqual(['#2', '#5'])

    await buttons[1]?.trigger('click')

    expect(wrapper.emitted('select-step')).toEqual([[5]])
  })

  it('facts cited starts expanded (the most observability-relevant field); the others start collapsed', () => {
    const wrapper = mount(EvidenceSummary, { props: { evidence: evidence() } })
    expect((wrapper.find('[data-testid="evidence-facts-cited"]').element as HTMLDetailsElement).open).toBe(true)
    expect((wrapper.find('[data-testid="evidence-tools-called"]').element as HTMLDetailsElement).open).toBe(false)
    expect((wrapper.find('[data-testid="evidence-feasibility-seen"]').element as HTMLDetailsElement).open).toBe(false)
  })

  it('renders "none" for every empty field rather than a blank section', () => {
    const wrapper = mount(EvidenceSummary, {
      props: {
        evidence: {
          toolsCalled: [], candidatesInspected: [], feasibilitySeen: [], metricsInspected: [],
          historyInspected: [], factsCited: [], supportingSteps: [], proposalAttempts: 0,
        },
      },
    })
    expect(wrapper.find('[data-testid="evidence-tools-called"]').text()).toContain('none')
    expect(wrapper.find('[data-testid="evidence-candidates-inspected"]').text()).toContain('none')
    expect(wrapper.find('[data-testid="evidence-feasibility-seen"]').text()).toContain('none')
    expect(wrapper.find('[data-testid="evidence-facts-cited"]').text()).toContain('none')
    expect(wrapper.find('[data-testid="evidence-supporting-steps"]').text()).toContain('none')
    expect(wrapper.find('[data-testid="evidence-proposal-attempts"]').text()).toBe('proposal attempts: 0')
  })
})
