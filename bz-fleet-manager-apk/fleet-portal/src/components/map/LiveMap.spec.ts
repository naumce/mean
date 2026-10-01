import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// mapbox-gl needs WebGL, so it is mocked with just the surface LiveMap uses,
// recording constructor options and every mutation for assertions.
const mocks = vi.hoisted(() => {
  class FakeMarker {
    el: HTMLElement
    ll: [number, number] | null = null
    removed = false
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element
      mocks.markers.push(this)
    }
    setLngLat(ll: [number, number]): this {
      if (!Array.isArray(ll) || !ll.every((n) => Number.isFinite(n))) throw new Error('bad LngLat')
      this.ll = ll
      return this
    }
    getLngLat(): [number, number] | null {
      return this.ll
    }
    addTo(): this {
      return this
    }
    remove(): this {
      this.removed = true
      return this
    }
  }
  class FakePopup {
    text = ''
    shown = false
    setText(t: string): this {
      this.text = t
      return this
    }
    setLngLat(): this {
      return this
    }
    addTo(): this {
      this.shown = true
      return this
    }
    remove(): this {
      this.shown = false
      return this
    }
  }
  class FakeBounds {
    points: [number, number][] = []
    extend(p: [number, number]): this {
      this.points.push(p)
      return this
    }
  }
  class FakeMap {
    opts: Record<string, unknown>
    styles: string[] = []
    fit: { bounds: FakeBounds; opts: Record<string, unknown> } | null = null
    jump: Record<string, unknown> | null = null
    removed = false
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      mocks.maps.push(this)
    }
    styleOpts: unknown[] = []
    zoom = 3
    handlers: Record<string, Array<() => void>> = {}
    setStyle(s: string, o?: unknown): void {
      this.styles.push(s)
      this.styleOpts.push(o)
    }
    getZoom(): number {
      return this.zoom
    }
    on(ev: string, fn: () => void): void {
      ;(this.handlers[ev] ??= []).push(fn)
    }
    fire(ev: string): void {
      for (const fn of this.handlers[ev] ?? []) fn()
    }
    fitBounds(bounds: FakeBounds, opts: Record<string, unknown>): void {
      this.fit = { bounds, opts }
    }
    jumpTo(o: Record<string, unknown>): void {
      this.jump = o
    }
    remove(): void {
      this.removed = true
    }
  }
  return {
    FakeMap,
    FakeMarker,
    FakePopup,
    FakeBounds,
    maps: [] as InstanceType<typeof FakeMap>[],
    markers: [] as InstanceType<typeof FakeMarker>[],
  }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: mocks.FakeMap, Marker: mocks.FakeMarker, Popup: mocks.FakePopup, LngLatBounds: mocks.FakeBounds },
}))

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useThemeStore } from '../../stores/theme'
import LiveMap from './LiveMap.vue'

const a = { id: 'a', label: 'Jake', lat: 39, lng: -94 }
const b = { id: 'b', label: 'Ana', lat: 41, lng: -87, stale: true, color: '#ff0000' }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.test')
  mocks.maps.length = 0
  mocks.markers.length = 0
})
afterEach(() => vi.unstubAllEnvs())

const live = () => mocks.markers.filter((m) => !m.removed)

describe('LiveMap', () => {
  it('creates one marker per point and fits bounds with padding 40, maxZoom 7', () => {
    mount(LiveMap, { props: { points: [a, b] } })
    expect(live()).toHaveLength(2)
    const fit = mocks.maps[0].fit!
    expect(fit.bounds.points).toEqual([[-94, 39], [-87, 41]])
    expect(fit.opts).toMatchObject({ padding: 40, maxZoom: 7 })
  })

  it('defaults to the US centre at zoom 3 with no points, and honours height', () => {
    const w = mount(LiveMap, { props: { points: [] } })
    expect(mocks.maps[0].opts).toMatchObject({ center: [-96, 38], zoom: 3 })
    expect(live()).toHaveLength(0)
    expect(w.find('[data-testid="live-map"] > div').attributes('style')).toContain('380px')
  })

  it('adds and removes markers as points come and go, moving survivors in place', async () => {
    const w = mount(LiveMap, { props: { points: [a, b] } })
    const first = mocks.markers[0]
    await w.setProps({ points: [{ ...a, lat: 40 }] })
    expect(live()).toHaveLength(1)
    expect(live()[0]).toBe(first)
    expect(first.ll).toEqual([-94, 40])
    expect(mocks.markers).toHaveLength(2) // nothing recreated
  })

  it('does not refit when only coordinates change', async () => {
    const w = mount(LiveMap, { props: { points: [a] } })
    mocks.maps[0].fit = null
    await w.setProps({ points: [{ ...a, lat: 40 }] })
    expect(mocks.maps[0].fit).toBeNull()
  })

  it('dims stale markers and applies the caller colour', () => {
    mount(LiveMap, { props: { points: [a, b] } })
    const dotOf = (i: number) => mocks.markers[i].el.firstElementChild as HTMLElement
    expect(dotOf(0).style.opacity).toBe('1')
    expect(dotOf(1).style.opacity).toBe('0.6')
    expect(dotOf(1).style.background).toContain('255, 0, 0')
    expect(mocks.markers[0].el.textContent).toBe('Jake')
  })

  it('draws shops as extra markers', () => {
    mount(LiveMap, { props: { points: [a], shops: [{ name: 'Bay 4', lat: 35, lng: -90 }] } })
    expect(live()).toHaveLength(2)
  })

  it('swaps the basemap style when the theme flips, keeping the markers', async () => {
    const theme = useThemeStore()
    theme.setMode('dark')
    mount(LiveMap, { props: { points: [a] } })
    expect(mocks.maps[0].opts.style).toBe('mapbox://styles/mapbox/dark-v11')
    theme.setMode('light')
    await nextTick()
    expect(mocks.maps[0].styles).toEqual(['mapbox://styles/mapbox/light-v11'])
    expect(mocks.maps[0].styleOpts).toEqual([{ diff: false }])
    expect(live()).toHaveLength(1)
  })

  it('shows labels only from zoom 5.5 up', async () => {
    const w = mount(LiveMap, { props: { points: [a] } })
    const inner = () => w.find('[data-testid="live-map"] > div')
    expect(inner().classes()).not.toContain('lm-labels-on')
    mocks.maps[0].zoom = 6
    mocks.maps[0].fire('zoomend')
    await nextTick()
    expect(inner().classes()).toContain('lm-labels-on')
    mocks.maps[0].zoom = 3
    mocks.maps[0].fire('zoomend')
    await nextTick()
    expect(inner().classes()).not.toContain('lm-labels-on')
  })

  it('drops its own border when embedded', () => {
    expect(mount(LiveMap, { props: { points: [], bordered: false } }).find('[data-testid="live-map"]').classes()).not.toContain('border')
    expect(mount(LiveMap, { props: { points: [] } }).find('[data-testid="live-map"]').classes()).toContain('border')
  })

  it('removes the map on unmount', () => {
    const w = mount(LiveMap, { props: { points: [a] } })
    w.unmount()
    expect(mocks.maps[0].removed).toBe(true)
    expect(live()).toHaveLength(0)
  })
})
