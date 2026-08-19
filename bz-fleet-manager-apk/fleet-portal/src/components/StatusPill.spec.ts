import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StatusPill from './StatusPill.vue'

describe('StatusPill', () => {
  it('renders a formatted label for a snake_case status', () => {
    const wrapper = mount(StatusPill, { props: { status: 'in_progress' } })

    expect(wrapper.text()).toBe('In Progress')
  })

  it('applies an amber color class for pending', () => {
    const wrapper = mount(StatusPill, { props: { status: 'pending' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('amber')]))
  })

  it('applies a blue color class for assigned', () => {
    const wrapper = mount(StatusPill, { props: { status: 'assigned' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('blue')]))
  })

  it('applies a blue color class for in_progress', () => {
    const wrapper = mount(StatusPill, { props: { status: 'in_progress' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('blue')]))
  })

  it('applies an emerald color class for completed', () => {
    const wrapper = mount(StatusPill, { props: { status: 'completed' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('emerald')]))
  })

  it('applies a red color class for rejected', () => {
    const wrapper = mount(StatusPill, { props: { status: 'rejected' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('red')]))
  })

  it('applies a red color class for cancelled', () => {
    const wrapper = mount(StatusPill, { props: { status: 'cancelled' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('red')]))
  })

  it('falls back to a gray color class for an unknown status', () => {
    const wrapper = mount(StatusPill, { props: { status: 'mystery' } })

    expect(wrapper.classes()).toEqual(expect.arrayContaining([expect.stringContaining('gray')]))
  })
})
