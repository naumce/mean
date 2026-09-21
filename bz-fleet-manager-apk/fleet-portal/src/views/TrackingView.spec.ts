import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTrackingStore } from '../stores/tracking'
import TrackingView from './TrackingView.vue'

vi.mock('../stores/tracking', () => ({
  useTrackingStore: vi.fn(),
}))

const mockedUseTrackingStore = vi.mocked(useTrackingStore)

function createTrackingStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    locations: [],
    loading: false,
    error: null,
    listLocations: vi.fn(),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    connectRealtime: vi.fn(),
    disconnectRealtime: vi.fn(),
    ...overrides,
  }
}

const sampleLocation = {
  driverId: 'drv-1',
  driverName: 'Dana Driver',
  latitude: 40.7128,
  longitude: -74.006,
  speed: 32,
  createdAt: new Date().toISOString(),
}

describe('TrackingView', () => {
  beforeEach(() => {
    mockedUseTrackingStore.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('starts polling on mount and renders location rows', () => {
    const store = createTrackingStoreStub({ locations: [sampleLocation] })
    mockedUseTrackingStore.mockReturnValue(store as unknown as ReturnType<typeof useTrackingStore>)

    const wrapper = mount(TrackingView)

    expect(store.startPolling).toHaveBeenCalled()
    expect(store.connectRealtime).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Dana Driver')
    expect(wrapper.text()).toContain('32 mph')
    expect(wrapper.text()).toContain('1 active driver')
  })

  it('renders the empty state and pluralizes the count when there are no drivers', () => {
    const store = createTrackingStoreStub()
    mockedUseTrackingStore.mockReturnValue(store as unknown as ReturnType<typeof useTrackingStore>)

    const wrapper = mount(TrackingView)

    expect(wrapper.text()).toContain('No driver locations reported yet.')
    expect(wrapper.text()).toContain('0 active drivers')
  })

  it('stops polling on unmount', () => {
    const store = createTrackingStoreStub()
    mockedUseTrackingStore.mockReturnValue(store as unknown as ReturnType<typeof useTrackingStore>)

    const wrapper = mount(TrackingView)
    wrapper.unmount()

    expect(store.stopPolling).toHaveBeenCalled()
    expect(store.disconnectRealtime).toHaveBeenCalled()
  })
})
