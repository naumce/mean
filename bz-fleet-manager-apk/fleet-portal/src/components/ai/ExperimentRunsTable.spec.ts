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
    latencyMs: 8200, promptTokens: 512, completionTokens: 128, contextPressure: false, startedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('ExperimentRunsTable', () => {
  it('renders the evaluation columns', () => {
    const wrapper = mount(ExperimentRunsTable, { props: { rows: [row()] } })
    const headers = wrapper.findAll('th').map((h) => h.text())
    expect(headers).toEqual([
      'Load / scenario', 'Status', 'Termination', 'Pick', 'Confidence', 'Deterministic top',
      'Verdict', 'Turns', 'Tool calls', 'Uniq/rep/inv', 'Latency', 'Tokens', 'Ctx',
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

  // Fix round 2: the wire contract has `latencyMs`/`startedAt`/`loadId`
  // nullable (a fresh experiment's still-queued rows) — a null must render as
  // "—", never throw.
  it('renders without throwing when latencyMs/startedAt/loadId/loadRef are null, showing a dash', () => {
    const wrapper = mount(ExperimentRunsTable, {
      props: { rows: [row({ latencyMs: null, startedAt: null, loadId: null, loadRef: null })] },
    })
    const cells = wrapper.findAll('[data-testid="runs-table-row"] td')
    expect(cells[0]?.text()).toContain('—')
    expect(cells[10]?.text()).toBe('—')
  })

  // Fix round 2: `pick: null` (no decision reached yet) and a non-null pick
  // whose own driverId/name are null (a decision naming no driver) are
  // different facts and must render differently.
  it('a pick with driverId: null shows "no driver", distinct from no pick at all ("none")', () => {
    const withNullDriverPick = mount(ExperimentRunsTable, { props: { rows: [row({ pick: { driverId: null, name: null } })] } })
    expect(withNullDriverPick.findAll('[data-testid="runs-table-row"] td')[3]?.text()).toBe('no driver')

    const withNoPick = mount(ExperimentRunsTable, { props: { rows: [row({ pick: null })] } })
    expect(withNoPick.findAll('[data-testid="runs-table-row"] td')[3]?.text()).toBe('none')
  })

  it('a deterministic top with null name/driverId renders a dash instead of throwing', () => {
    const wrapper = mount(ExperimentRunsTable, {
      props: { rows: [row({ deterministicTop: { driverId: null, name: null }, deterministicRankOfPick: null })] },
    })
    expect(wrapper.findAll('[data-testid="runs-table-row"] td')[5]?.text()).toBe('—')
  })

  // I3: a run whose prompt tokens got close enough to numCtx to plausibly
  // have lost history to Ollama's own silent trimming shows a "ctx!" badge;
  // an ordinary run shows a plain dash instead.
  it('shows a "ctx!" badge when contextPressure is true, a dash otherwise', () => {
    const withPressure = mount(ExperimentRunsTable, { props: { rows: [row({ contextPressure: true })] } })
    expect(withPressure.find('[data-testid="ctx-pressure-badge"]').exists()).toBe(true)
    expect(withPressure.find('[data-testid="ctx-pressure-badge"]').text()).toBe('ctx!')

    const withoutPressure = mount(ExperimentRunsTable, { props: { rows: [row({ contextPressure: false })] } })
    expect(withoutPressure.find('[data-testid="ctx-pressure-badge"]').exists()).toBe(false)
    expect(withoutPressure.findAll('[data-testid="runs-table-row"] td').at(-1)?.text()).toBe('—')
  })
})
