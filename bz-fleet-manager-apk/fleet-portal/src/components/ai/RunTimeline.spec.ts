import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RunTimeline from './RunTimeline.vue'
import type { RunStep } from '../../types/aiLab'

// One of every RunStepKind (nine total), deliberately fed OUT of seq order —
// RunTimeline must re-sort, not trust the array's own order.
const STEPS: RunStep[] = [
  { seq: 3, kind: 'thinking', name: null, payload: { text: 'weighing candidates' }, atMs: 3000, durationMs: 50 },
  { seq: 0, kind: 'system', name: null, payload: { content: 'You investigate one load per run.' }, atMs: 0, durationMs: null },
  { seq: 7, kind: 'error', name: null, payload: { kind: 'model_error', message: 'Ollama timed out' }, atMs: 7000, durationMs: 200 },
  { seq: 1, kind: 'user', name: null, payload: { content: 'Investigate load L-1' }, atMs: 1000, durationMs: null },
  {
    seq: 4,
    kind: 'tool_call',
    name: 'getDriverHistory',
    payload: { name: 'getDriverHistory', arguments: { driverId: 'd1' } },
    atMs: 4000,
    durationMs: 30,
  },
  {
    seq: 5,
    kind: 'tool_result',
    name: 'getDriverHistory',
    payload: { name: 'getDriverHistory', ok: true, truncated: true, originalSize: 90000, returnedSize: 8192, preview: { note: 'cut' } },
    atMs: 4100,
    durationMs: 5,
  },
  {
    seq: 2,
    kind: 'assistant',
    name: null,
    payload: { content: 'Checking history first.', toolCalls: [{ name: 'getDriverHistory', arguments: {} }], stats: null, doneReason: null },
    atMs: 2000,
    durationMs: 800,
  },
  { seq: 8, kind: 'nudge', name: null, payload: { content: 'finish by calling propose_decision' }, atMs: 8000, durationMs: null },
  {
    seq: 6,
    kind: 'final',
    name: null,
    payload: { proposal: { driverId: 'd1', reason: 'closest feasible driver', confidence: 0.75, alternatives: [] } },
    atMs: 9000,
    durationMs: 10,
  },
]

describe('RunTimeline', () => {
  it('renders all nine step kinds in seq order, labelled by kind', () => {
    const wrapper = mount(RunTimeline, { props: { steps: STEPS, driverNames: { d1: 'Alice' } } })
    const cards = wrapper.findAll('[data-testid^="run-step-"]')
    expect(cards).toHaveLength(9)
    expect(cards.map((c) => c.attributes('data-step-kind'))).toEqual([
      'system', 'user', 'assistant', 'thinking', 'tool_call', 'tool_result', 'final', 'error', 'nudge',
    ])

    const labels = wrapper.findAll('[data-testid="step-kind-label"]').map((s) => s.text())
    expect(labels[0]).toBe('SYSTEM')
    expect(labels).toContain('USER REQUEST')
    expect(labels).toContain('MODEL')
    expect(labels).toContain('THINKING')
    expect(labels).toContain('TOOL REQUEST')
    expect(labels).toContain('TOOL RESULT')
    expect(labels).toContain('FINAL PROPOSAL')
    expect(labels).toContain('ERROR')
    // Fix round 1: nudge gets its own label ("NUDGE"), distinct from a real
    // user turn — "USER REQUEST" must appear exactly once (the `user` step
    // only), not twice.
    expect(labels).toContain('NUDGE')
    expect(labels.filter((l) => l === 'USER REQUEST')).toHaveLength(1)
  })

  it('shows the truncation badge on the truncated tool_result', () => {
    const wrapper = mount(RunTimeline, { props: { steps: STEPS } })
    expect(wrapper.find('[data-testid="tool-result-truncated"]').text()).toBe('truncated 90000→8192 B')
  })

  it('shows the error card distinctly', () => {
    const wrapper = mount(RunTimeline, { props: { steps: STEPS } })
    const errorCard = wrapper.find('[data-step-kind="error"]')
    expect(errorCard.text()).toContain('Ollama timed out')
  })

  it('thinking is collapsed by default', () => {
    const wrapper = mount(RunTimeline, { props: { steps: STEPS } })
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false)
  })

  it('renders the empty state for a run with no steps yet', () => {
    const wrapper = mount(RunTimeline, { props: { steps: [] } })
    expect(wrapper.find('[data-testid="run-timeline-empty"]').exists()).toBe(true)
  })
})
