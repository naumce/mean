import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import InfoTip from './InfoTip.vue'

describe('InfoTip', () => {
  it('renders the explanation as an accessible tooltip', () => {
    const wrapper = mount(InfoTip, { props: { text: 'Revenue per loaded mile.' } })
    const tip = wrapper.find('[role="tooltip"]')
    expect(tip.text()).toBe('Revenue per loaded mile.')
    // Keyboard reachable — hover-only help excludes keyboard users.
    expect(wrapper.attributes('tabindex')).toBe('0')
  })
})
