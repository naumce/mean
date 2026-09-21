import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FleetMap from './FleetMap.vue'

// jsdom has no 2d context — the component must render (and survive redraws)
// with getContext() returning null; the drawing math itself is covered by
// lib/map/usMap.spec.ts.
const loc = {
  driverId: 'd1', driverName: 'Jake', latitude: 39.0997, longitude: -94.5786,
  createdAt: new Date().toISOString(),
}

describe('FleetMap', () => {
  it('renders the canvas and legend without a drawing context', () => {
    const wrapper = mount(FleetMap, { props: { locations: [loc] } })
    expect(wrapper.find('[data-testid="fleet-map"]').exists()).toBe(true)
    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(wrapper.find('[data-testid="map-empty"]').exists()).toBe(false)
  })

  it('shows the live-hint empty state with no positions', () => {
    const wrapper = mount(FleetMap, { props: { locations: [] } })
    expect(wrapper.find('[data-testid="map-empty"]').text()).toContain('appear here live')
  })

  it('survives a locations update (redraw path) without a context', async () => {
    const wrapper = mount(FleetMap, { props: { locations: [] } })
    await wrapper.setProps({ locations: [loc] })
    expect(wrapper.find('[data-testid="map-empty"]').exists()).toBe(false)
  })
})
