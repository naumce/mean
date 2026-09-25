import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RunStepCard from './RunStepCard.vue'
import type { RunStep } from '../../types/aiLab'

function step(overrides: Partial<RunStep>): RunStep {
  return { seq: 0, kind: 'user', name: null, payload: { content: 'hi' }, atMs: Date.parse('2026-09-25T12:00:00.000Z'), durationMs: 120, ...overrides }
}

describe('RunStepCard', () => {
  it('renders the wall time and durationMs for every kind', () => {
    const wrapper = mount(RunStepCard, { props: { step: step({ durationMs: 4200 }) } })
    expect(wrapper.find('[data-testid="step-timing"]').text()).toContain('4s')
  })

  it('shows "—" for a null durationMs rather than a blank or zero', () => {
    const wrapper = mount(RunStepCard, { props: { step: step({ durationMs: null }) } })
    expect(wrapper.find('[data-testid="step-timing"]').text()).toContain('—')
  })

  it('user and nudge both render the plain content, but under distinct labels', () => {
    const user = mount(RunStepCard, { props: { step: step({ kind: 'user', payload: { content: 'Investigate load L-1' } }) } })
    expect(user.find('[data-testid="step-content"]').text()).toBe('Investigate load L-1')
    expect(user.find('[data-testid="step-kind-label"]').text()).toBe('USER REQUEST')

    const nudge = mount(RunStepCard, { props: { step: step({ kind: 'nudge', payload: { content: 'finish by calling propose_decision' } }) } })
    expect(nudge.find('[data-testid="step-content"]').text()).toBe('finish by calling propose_decision')
    // Fix round 1: a nudge is the harness's own correction, not a real user
    // turn — it must not read as "USER REQUEST" too.
    expect(nudge.find('[data-testid="step-kind-label"]').text()).toBe('NUDGE')
  })

  it('assistant renders content and lists each tool call as "→ tool request: name"', () => {
    const wrapper = mount(RunStepCard, {
      props: {
        step: step({
          kind: 'assistant',
          payload: { content: 'Checking candidates.', toolCalls: [{ name: 'findFeasibleDrivers', arguments: {} }, { name: 'getDriverMetrics', arguments: {} }], stats: null, doneReason: null },
        }),
      },
    })
    expect(wrapper.find('[data-testid="step-content"]').text()).toBe('Checking candidates.')
    const arrows = wrapper.findAll('[data-testid="step-tool-request-arrow"]')
    expect(arrows.map((a) => a.text())).toEqual(['→ tool request: findFeasibleDrivers', '→ tool request: getDriverMetrics'])
  })

  it('thinking is collapsed by default and expands on click, shown verbatim', async () => {
    const wrapper = mount(RunStepCard, { props: { step: step({ kind: 'thinking', payload: { text: 'weighing candidates...' } }) } })
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false)

    await wrapper.find('[data-testid="thinking-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="thinking-content"]').text()).toBe('weighing candidates...')
  })

  it('tool_call shows the name, a literal "TOOL ARGUMENTS" caption, and a JsonViewer of the arguments', () => {
    const wrapper = mount(RunStepCard, { props: { step: step({ kind: 'tool_call', payload: { name: 'getDriverMetrics', arguments: { driverId: 'd1' } } }) } })
    expect(wrapper.find('[data-testid="tool-call-name"]').text()).toBe('→ getDriverMetrics')
    // Fix round 1: the chain must read USER REQUEST -> MODEL -> TOOL REQUEST
    // -> TOOL ARGUMENTS -> TOOL RESULT -> ... verbatim.
    expect(wrapper.find('[data-testid="tool-arguments-label"]').text()).toBe('TOOL ARGUMENTS')
    expect(wrapper.find('[data-testid="json-viewer"]').text()).toContain('"driverId": "d1"')
  })

  it('tool_result shows ok status and the preview', () => {
    const wrapper = mount(RunStepCard, {
      props: { step: step({ kind: 'tool_result', payload: { name: 'getDriverMetrics', ok: true, preview: { onTimeRate: 0.9 } } }) },
    })
    expect(wrapper.find('[data-testid="tool-result-status"]').text()).toContain('OK')
    expect(wrapper.find('[data-testid="json-viewer"]').text()).toContain('0.9')
    expect(wrapper.find('[data-testid="tool-result-truncated"]').exists()).toBe(false)
  })

  it('tool_result shows the truncation badge with original -> returned bytes when truncated', () => {
    const wrapper = mount(RunStepCard, {
      props: { step: step({ kind: 'tool_result', payload: { name: 'getDriverHistory', ok: true, truncated: true, originalSize: 90000, returnedSize: 8192, preview: { note: 'cut' } } }) },
    })
    expect(wrapper.find('[data-testid="tool-result-truncated"]').text()).toBe('truncated 90000→8192 B')
  })

  it('tool_result shows errors when not ok', () => {
    const wrapper = mount(RunStepCard, {
      props: { step: step({ kind: 'tool_result', payload: { name: 'assignLoad', ok: false, errors: ['unknown tool'] } }) },
    })
    expect(wrapper.find('[data-testid="tool-result-status"]').text()).toContain('ERROR')
    expect(wrapper.find('[data-testid="json-viewer"]').text()).toContain('unknown tool')
  })

  it('final resolves the driver name via driverNames, or "no driver recommended" when null', () => {
    const withDriver = mount(RunStepCard, {
      props: {
        step: step({ kind: 'final', payload: { proposal: { driverId: 'd1', reason: 'closest and feasible', confidence: 0.8, alternatives: [] } } }),
        driverNames: { d1: 'Alice' },
      },
    })
    expect(withDriver.find('[data-testid="final-driver"]').text()).toBe('Alice')

    const noDriver = mount(RunStepCard, {
      props: { step: step({ kind: 'final', payload: { proposal: { driverId: null, reason: 'no feasible driver', confidence: 0, alternatives: [] } } }) },
    })
    expect(noDriver.find('[data-testid="final-driver"]').text()).toBe('no driver recommended')
  })

  it('error renders the kind and message, styled distinctly', () => {
    const wrapper = mount(RunStepCard, { props: { step: step({ kind: 'error', payload: { kind: 'model_error', message: 'Ollama timed out' } }) } })
    expect(wrapper.find('[data-testid="step-error"]').text()).toContain('Ollama timed out')
    expect(wrapper.attributes('data-step-kind')).toBe('error')
  })
})
