import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ExperimentRunsTable from './ExperimentRunsTable.vue'
import type { EvaluationRow } from '../../types/aiLab'

function row(overrides: Partial<EvaluationRow> = {}): EvaluationRow {
  return {
    runId: 'run-1', loadId: 'l1', loadRef: 'L-1', scenario: { code: 'A', title: 'Reliable driver near an uncovered load', hint: 'Milan is close.' },
    status: 'proposed', terminationReason: 'proposed',
    deterministicTop: { driverId: 'd1', name: 'Alice' }, deterministicRankOfPick: 2,
    pick: { driverId: 'd2', name: 'Bob' }, confidence: 0.72,
    humanVerdict: null, humanDriverId: null, matchesDeterministicTop: false,
    turns: 4, toolCalls: 6, uniqueTools: 3, repeatedCalls: 0, invalidCalls: 1,
    latencyMs: 8200, promptTokens: 512, completionTokens: 128, startedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('ExperimentRunsTable', () => {
  it('renders the evaluation columns', () => {
    const wrapper = mount(ExperimentRunsTable, { props: { rows: [row()] } })
    const headers = wrapper.findAll('th').map((h) => h.text())
    expect(headers).toEqual([
      'Load / scenario', 'Status', 'Termination', 'Pick', 'Confidence', 'Deterministic top',
      'Verdict', 'Turns', 'Tool calls', 'Uniq/rep/inv', 'Latency', 'Tokens',
    ])
  })

  it('renders one row per run with the expected cell values', () => {
    const wrapper = mount(ExperimentRunsTable, { props: { rows: [row()] } })
    const cells = wrapper.findAll('[data-testid="runs-table-row"] td')
    expect(cells[0]?.text()).toContain('L-1')
    expect(cells[0]?.text()).toContain('A: Reliable driver near an uncovered load')
    expect(cells[2]?.text()).toBe('proposed')
    expect(cells[3]?.text()).toBe('Bob')
    expect(cells[4]?.text()).toBe('72%')
    expect(cells[5]?.text()).toContain('Alice')
    expect(cells[5]?.text()).toContain('#2')
    expect(cells[6]?.text()).toBe('pending')
    expect(cells[7]?.text()).toBe('4')
    expect(cells[9]?.text()).toBe('3/0/1')
    expect(cells[11]?.text()).toBe('512/128')
  })

  it('clicking a row emits select with the runId', async () => {
    const wrapper = mount(ExperimentRunsTable, { props: { rows: [row({ runId: 'run-7' })] } })
    await wrapper.find('[data-testid="runs-table-row"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['run-7']])
  })

  it('renders the empty state when there are no rows', () => {
    const wrapper = mount(ExperimentRunsTable, { props: { rows: [] } })
    expect(wrapper.find('[data-testid="runs-table-empty"]').exists()).toBe(true)
  })
})
