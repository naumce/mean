import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StageCard from './StageCard.vue'
import { DEFAULT_REPLY_TEXT } from '../../stores/demo'
import type { DemoStageAction } from '../../types/demo'

function baseProps(overrides: { narration?: string | null; action?: DemoStageAction | null; busy?: boolean; workerConfigured?: boolean } = {}) {
  return {
    narration: 'Night Shift is watching this load.',
    action: null as DemoStageAction | null,
    busy: false,
    workerConfigured: true,
    ...overrides,
  }
}

describe('StageCard', () => {
  it('renders the narration', () => {
    const wrapper = mount(StageCard, { props: baseProps() })
    expect(wrapper.find('[data-testid="stage-narration"]').text()).toBe('Night Shift is watching this load.')
  })

  it('falls back to a placeholder when there is no narration yet', () => {
    const wrapper = mount(StageCard, { props: baseProps({ narration: null }) })
    expect(wrapper.find('[data-testid="stage-narration"]').text().length).toBeGreaterThan(0)
  })

  // Fix round 1, Critical #2: raw story.log text must never reach this card
  // (only the narration and the button) — a log line can legitimately
  // contain a forbidden presenter word (the engine-fallback line names
  // "deterministic"), which is fine buried in HowItWorksLinks's collapsed
  // Technical log and never fine on the unhidden main screen.
  it('never renders a log line — there is no such prop or slot on this card', () => {
    const wrapper = mount(StageCard, { props: baseProps() })
    expect(wrapper.find('[data-testid="stage-log-line"]').exists()).toBe(false)
  })

  it('shows no button and no textbox when there is no action for the stage', () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: null }) })
    expect(wrapper.find('[data-testid="stage-action-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stage-reply-text"]').exists()).toBe(false)
  })

  it('renders the button label and subline for a plain action', () => {
    const wrapper = mount(StageCard, {
      props: baseProps({ action: { kind: 'customer_update_sent', label: 'Send customer update', subline: 'Demo sink — nothing leaves the system' } }),
    })
    expect(wrapper.find('[data-testid="stage-action-button"]').text()).toBe('Send customer update')
    expect(wrapper.find('[data-testid="stage-action-subline"]').text()).toBe('Demo sink — nothing leaves the system')
  })

  it('emits act with just the kind when clicked (non-reply action)', async () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: { kind: 'ask_ai', label: 'Ask AI for a driver' } }) })
    await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
    expect(wrapper.emitted('act')).toEqual([[{ kind: 'ask_ai' }]])
  })

  it('prefills the reply textbox and emits act with the (editable) text', async () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: { kind: 'driver_reply', label: "Send John's reply" } }) })
    const textarea = wrapper.find('[data-testid="stage-reply-text"]')
    expect((textarea.element as HTMLTextAreaElement).value).toBe(DEFAULT_REPLY_TEXT)

    await textarea.setValue('Actually, five more minutes.')
    await wrapper.find('[data-testid="stage-action-button"]').trigger('click')

    expect(wrapper.emitted('act')).toEqual([[{ kind: 'driver_reply', text: 'Actually, five more minutes.' }]])
  })

  it('resets the reply draft when the stage moves away and back to driver_reply', async () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: { kind: 'driver_reply', label: "Send John's reply" } }) })
    await wrapper.find('[data-testid="stage-reply-text"]').setValue('edited')

    await wrapper.setProps({ action: { kind: 'resolve', label: 'Continue' } })
    await wrapper.setProps({ action: { kind: 'driver_reply', label: "Send John's reply" } })

    expect((wrapper.find('[data-testid="stage-reply-text"]').element as HTMLTextAreaElement).value).toBe(DEFAULT_REPLY_TEXT)
  })

  it('keeps an in-progress edit across a re-render that leaves the stage unchanged (a poll tick)', async () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: { kind: 'driver_reply', label: "Send John's reply" } }) })
    await wrapper.find('[data-testid="stage-reply-text"]').setValue('still typing')

    // Same kind, new object identity (as a fresh poll response would produce).
    await wrapper.setProps({ action: { kind: 'driver_reply', label: "Send John's reply" } })

    expect((wrapper.find('[data-testid="stage-reply-text"]').element as HTMLTextAreaElement).value).toBe('still typing')
  })

  it('disables the button and shows a busy label while busy', () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: { kind: 'resolve', label: 'Continue' }, busy: true }) })
    const button = wrapper.find('[data-testid="stage-action-button"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toBe('Working…')
  })

  it('does not emit when clicked while busy', async () => {
    const wrapper = mount(StageCard, { props: baseProps({ action: { kind: 'resolve', label: 'Continue' }, busy: true }) })
    await wrapper.find('[data-testid="stage-action-button"]').trigger('click')
    expect(wrapper.emitted('act')).toBeUndefined()
  })

  // Fix round 1, Important #4: worker.configured === false means WORKER_URL
  // isn't set on this server — proactively say so instead of only finding
  // out after a 503 from a doomed click.
  describe('the driver-channel banner', () => {
    it('shows when the reply action is up and the worker is not configured', () => {
      const wrapper = mount(StageCard, {
        props: baseProps({ action: { kind: 'driver_reply', label: "Send John's reply" }, workerConfigured: false }),
      })
      expect(wrapper.find('[data-testid="driver-channel-banner"]').text()).toBe(
        'The driver channel is not connected on this server — the reply cannot be sent here.',
      )
    })

    it('stays hidden when the worker is configured', () => {
      const wrapper = mount(StageCard, {
        props: baseProps({ action: { kind: 'driver_reply', label: "Send John's reply" }, workerConfigured: true }),
      })
      expect(wrapper.find('[data-testid="driver-channel-banner"]').exists()).toBe(false)
    })

    it('stays hidden on every other action even when the worker is not configured', () => {
      const wrapper = mount(StageCard, {
        props: baseProps({ action: { kind: 'ask_ai', label: 'Ask AI for a driver' }, workerConfigured: false }),
      })
      expect(wrapper.find('[data-testid="driver-channel-banner"]').exists()).toBe(false)
    })
  })
})
