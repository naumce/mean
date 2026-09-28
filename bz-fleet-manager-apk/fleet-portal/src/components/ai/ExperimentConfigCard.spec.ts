import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ExperimentConfigCard from './ExperimentConfigCard.vue'
import { DEFAULT_HARNESS_CONFIG } from '../../types/aiLab'

describe('ExperimentConfigCard', () => {
  it('lists the given prompt versions and selects the current value', () => {
    const wrapper = mount(ExperimentConfigCard, {
      props: { config: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v1', promptVersions: ['dispatch-v1', 'dispatch-v2'] },
    })
    const options = wrapper.findAll('[data-testid="config-prompt-version"] option').map((o) => (o.element as HTMLOptionElement).value)
    expect(options).toEqual(['dispatch-v1', 'dispatch-v2'])
    expect((wrapper.find('[data-testid="config-prompt-version"]').element as HTMLSelectElement).value).toBe('dispatch-v1')
  })

  // The current value must always be selectable even when `promptVersions`
  // (fed from `status.promptVersions`) hasn't loaded yet or omits it — a
  // <select> whose bound value matches no <option> renders blank.
  it('includes the current prompt version among the options even if the given list omits it', () => {
    const wrapper = mount(ExperimentConfigCard, {
      props: { config: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v9', promptVersions: ['dispatch-v1'] },
    })
    const options = wrapper.findAll('[data-testid="config-prompt-version"] option').map((o) => (o.element as HTMLOptionElement).value)
    expect(options).toContain('dispatch-v9')
  })

  it('is enabled with no runs, and includes the picked prompt version in the save payload', async () => {
    const wrapper = mount(ExperimentConfigCard, {
      props: { config: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v1', promptVersions: ['dispatch-v1', 'dispatch-v2'], runCount: 0 },
    })
    const select = wrapper.find('[data-testid="config-prompt-version"]')
    expect((select.element as HTMLSelectElement).disabled).toBe(false)
    expect(wrapper.find('[data-testid="config-prompt-version-hint"]').exists()).toBe(false)

    await select.setValue('dispatch-v2')
    await wrapper.find('form').trigger('submit.prevent')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ config: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v2' })
  })

  it('is disabled once the experiment has runs, shows the hint, and omits promptVersion from the save payload', async () => {
    const wrapper = mount(ExperimentConfigCard, {
      props: { config: DEFAULT_HARNESS_CONFIG, promptVersion: 'dispatch-v1', promptVersions: ['dispatch-v1', 'dispatch-v2'], runCount: 3 },
    })
    const select = wrapper.find('[data-testid="config-prompt-version"]')
    expect((select.element as HTMLSelectElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="config-prompt-version-hint"]').text()).toBe('fixed once runs exist')

    await wrapper.find('form').trigger('submit.prevent')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ config: DEFAULT_HARNESS_CONFIG })
  })
})
