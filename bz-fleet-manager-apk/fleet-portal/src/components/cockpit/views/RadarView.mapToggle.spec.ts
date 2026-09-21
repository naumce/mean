import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A minimal mapbox-gl fake — this spec only cares which component RadarView
// renders (schematic vs FleetMap) based on VITE_MAPBOX_TOKEN, not what
// FleetMap does with the map. FleetMap.spec.ts covers that in depth.
vi.mock('mapbox-gl', () => {
  class FakeMap {
    // T2 "Map as Navigation", Task 9: FleetMap's sync() reads the current
    // zoom (mapData.ts's clusterDriverActivity) — a real mapboxgl.Map always
    // has one, so this minimal fake needs a stub too, even though this spec
    // never asserts on clustering itself (see the file header).
    getZoom(): number {
      return 3
    }
    on(evt: string, cb: () => void): this {
      if (evt === 'load') cb()
      return this
    }
    addSource(): { setData: () => void } {
      return { setData: () => {} }
    }
    getSource(): { setData: () => void } {
      return { setData: () => {} }
    }
    addLayer(): void {}
    fitBounds(): void {}
    remove(): void {}
  }
  class FakeMarker {
    setLngLat(): this {
      return this
    }
    addTo(): this {
      return this
    }
    remove(): this {
      return this
    }
    getElement(): HTMLElement {
      return document.createElement('div')
    }
  }
  class FakeBounds {
    extend(): this {
      return this
    }
  }
  return { default: { Map: FakeMap, Marker: FakeMarker, LngLatBounds: FakeBounds } }
})

vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useLoadboardStore } from '../../../stores/loadboard'
import { useTrackingStore } from '../../../stores/tracking'
import FleetMap from './FleetMap.vue'
import RadarView from './RadarView.vue'

const NOW = Date.UTC(2026, 7, 28, 19, 32)

describe('RadarView / FleetMap switch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useLoadboardStore().lanes = []
    useLoadboardStore().loads = []
    useTrackingStore().locations = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders the schematic SVG when VITE_MAPBOX_TOKEN is unset', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '')
    const w = mount(RadarView, { props: { nowMs: NOW } })
    expect(w.find('svg').exists()).toBe(true)
    expect(w.findComponent(FleetMap).exists()).toBe(false)
  })

  it('renders FleetMap instead of the schematic when VITE_MAPBOX_TOKEN is a non-empty public token', async () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.testtoken')
    const w = mount(RadarView, { props: { nowMs: NOW } })
    // FleetMap is loaded via defineAsyncComponent (see RadarView.vue) so the
    // mapbox-gl chunk isn't fetched for the common case (no token) — give
    // the dynamic import() a tick to resolve before asserting on it.
    await flushPromises()
    expect(w.find('svg').exists()).toBe(false)
    expect(w.findComponent(FleetMap).exists()).toBe(true)
  })

  it('falls back to the schematic when VITE_MAPBOX_TOKEN is a secret (sk.*) token', () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'sk.shouldNeverBeUsed')
    const w = mount(RadarView, { props: { nowMs: NOW } })
    expect(w.find('svg').exists()).toBe(true)
    expect(w.findComponent(FleetMap).exists()).toBe(false)
  })
})
