import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ComparisonTable from './ComparisonTable.vue'
import type { ProposalComparisonEntry } from '../../types/aiLab'

function entry(overrides: Partial<ProposalComparisonEntry> = {}): ProposalComparisonEntry {
  return {
    driverId: 'd1', strengths: ['closer', 'strong on-time history'], weaknesses: ['longer deadhead'], unknowns: ['HOS unknown'],
    ...overrides,
  }
}

describe('ComparisonTable', () => {
  it('renders the "Comparison (dispatch-v2)" title', () => {
    const wrapper = mount(ComparisonTable, { props: { comparison: [entry()] } })
    expect(wrapper.text()).toContain('Comparison (dispatch-v2)')
  })

  it('renders one row per finalist, with strengths/weaknesses/unknowns as bullet lists, driver name via driverNames', () => {
    const wrapper = mount(ComparisonTable, {
      props: { comparison: [entry({ driverId: 'd1' }), entry({ driverId: 'd2' })], driverNames: { d1: 'Alice' } },
    })
    const rows = wrapper.findAll('[data-testid="comparison-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('Alice')
    // No entry for d2 in driverNames — falls back to the raw id.
    expect(rows[1]?.text()).toContain('d2')

    const strengthItems = rows[0]
      ?.find('[data-testid="comparison-strengths"]')
      .findAll('li')
      .map((li) => li.text())
    expect(strengthItems).toEqual(['closer', 'strong on-time history'])

    const weaknessItems = rows[0]
      ?.find('[data-testid="comparison-weaknesses"]')
      .findAll('li')
      .map((li) => li.text())
    expect(weaknessItems).toEqual(['longer deadhead'])
  })

  it('highlights the chosen driver\'s row and leaves the others plain', () => {
    const wrapper = mount(ComparisonTable, {
      props: { comparison: [entry({ driverId: 'd1' }), entry({ driverId: 'd2' })], chosenDriverId: 'd2' },
    })
    const rows = wrapper.findAll('[data-testid="comparison-row"]')
    expect(rows[0]?.find('[data-testid="comparison-chosen-badge"]').exists()).toBe(false)
    expect(rows[1]?.find('[data-testid="comparison-chosen-badge"]').exists()).toBe(true)
  })

  it('shows "—" for an empty strengths/weaknesses/unknowns list instead of an empty bullet list', () => {
    const wrapper = mount(ComparisonTable, {
      props: { comparison: [entry({ strengths: [], weaknesses: [], unknowns: [] })] },
    })
    expect(wrapper.find('[data-testid="comparison-strengths"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="comparison-weaknesses"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="comparison-unknowns"]').text()).toBe('—')
  })
})
