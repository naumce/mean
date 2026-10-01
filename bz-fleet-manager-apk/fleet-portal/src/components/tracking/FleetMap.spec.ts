import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useThemeStore } from '../../stores/theme'
import FleetMap from './FleetMap.vue'

// LiveMap pulls in mapbox-gl, which needs WebGL; the chooser spec only needs
// to know whether LiveMap was picked, so the module is an empty shell.
vi.mock('mapbox-gl', () => ({ default: {} }))
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllEnvs())

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

  it('redraws the canvas when the theme flips', async () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const theme = useThemeStore()
    theme.setMode('light')
    mount(FleetMap, { props: { locations: [loc] } })
    const before = spy.mock.calls.length
    theme.setMode('dark')
    await nextTick()
    expect(spy.mock.calls.length).toBeGreaterThan(before)
    spy.mockRestore()
  })

  describe('chooser', () => {
    const LiveMapStub = {
      name: 'LiveMap',
      props: ['points', 'shops', 'height'],
      template: '<div data-testid="live-map-stub" />',
    }
    const stale = { ...loc, driverId: 'd2', driverName: undefined, createdAt: new Date(Date.now() - 3_600_000).toISOString() }

    it('renders LiveMap, not the canvas, when a Mapbox token is configured', () => {
      vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.test')
      const wrapper = mount(FleetMap, {
        props: { locations: [loc], shops: [{ name: 'Bay', lat: 35, lng: -90 }, { name: 'Nowhere', lat: null, lng: null }] },
        global: { stubs: { LiveMap: LiveMapStub } },
      })
      expect(wrapper.find('[data-testid="live-map-stub"]').exists()).toBe(true)
      expect(wrapper.find('canvas').exists()).toBe(false)
      expect(wrapper.find('[data-testid="fleet-map"]').exists()).toBe(true)
      expect(wrapper.findComponent(LiveMapStub).props('shops')).toEqual([{ name: 'Bay', lat: 35, lng: -90 }])
    })

    it('maps locations to points: fresh/stale, label fallback, marker colour override', () => {
      vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.test')
      const wrapper = mount(FleetMap, {
        props: { locations: [loc, stale], markerColor: (l) => (l.driverId === 'd1' ? '#123456' : null) },
        global: { stubs: { LiveMap: LiveMapStub } },
      })
      const points = wrapper.findComponent(LiveMapStub).props('points')
      expect(points[0]).toMatchObject({ id: 'd1', label: 'Jake', lat: 39.0997, lng: -94.5786, color: '#123456', stale: false })
      expect(points[1]).toMatchObject({ id: 'd2', label: 'd2', stale: true })
    })

    it('falls back to the canvas when no token is configured', () => {
      vi.stubEnv('VITE_MAPBOX_TOKEN', '')
      const wrapper = mount(FleetMap, { props: { locations: [loc] }, global: { stubs: { LiveMap: LiveMapStub } } })
      expect(wrapper.find('canvas').exists()).toBe(true)
      expect(wrapper.find('[data-testid="live-map-stub"]').exists()).toBe(false)
    })
  })
})
