import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSimStore } from '../../stores/sim'
import DriverSimulationControls from './DriverSimulationControls.vue'
import type { SimState } from '../../lib/api'

vi.mock('../../stores/sim', () => ({ useSimStore: vi.fn() }))
const mockedUseSimStore = vi.mocked(useSimStore)

function createSimStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    state: { running: false, speed: 1, simMinutesAdvanced: 0, simNowMs: Date.now(), lastTickAt: null, drivers: [] } as SimState,
    busy: false,
    error: null,
    setDriverMode: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

describe('DriverSimulationControls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedUseSimStore.mockReset()
  })

  it("defaults to 'auto' when the driver has no entry in sim.state.drivers", () => {
    const store = createSimStoreStub()
    mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
    const wrapper = mount(DriverSimulationControls, { props: { driverId: 'd1' } })
    expect(wrapper.find('[data-testid="sim-current-mode"]').text()).toBe('Current mode: auto')
    expect((wrapper.find('[data-testid="sim-mode-select"]').element as HTMLSelectElement).value).toBe('auto')
  })

  it('reads the current mode for this driver from sim.state.drivers', () => {
    const store = createSimStoreStub({
      state: {
        running: false, speed: 1, simMinutesAdvanced: 0, simNowMs: Date.now(), lastTickAt: null,
        drivers: [{ driverId: 'd1', mode: 'dark', modeUntil: null, offsetLat: 0, offsetLng: 0, updatedAt: new Date().toISOString() }],
      },
    })
    mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
    const wrapper = mount(DriverSimulationControls, { props: { driverId: 'd1' } })
    expect(wrapper.find('[data-testid="sim-current-mode"]').text()).toBe('Current mode: dark')
  })

  it('shows the offset-mi field only when mode is offroute', async () => {
    const store = createSimStoreStub()
    mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
    const wrapper = mount(DriverSimulationControls, { props: { driverId: 'd1' } })
    expect(wrapper.find('[data-testid="sim-offset-mi"]').exists()).toBe(false)

    await wrapper.find('[data-testid="sim-mode-select"]').setValue('offroute')
    expect(wrapper.find('[data-testid="sim-offset-mi"]').exists()).toBe(true)
  })

  it('saves mode + minutes, omitting offsetMi for a non-offroute mode', async () => {
    const store = createSimStoreStub()
    mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
    const wrapper = mount(DriverSimulationControls, { props: { driverId: 'd1' } })

    await wrapper.find('[data-testid="sim-mode-select"]').setValue('idle')
    await wrapper.find('[data-testid="sim-minutes"]').setValue('30')
    await wrapper.find('[data-testid="sim-mode-save"]').trigger('click')
    await Promise.resolve()

    expect(store.setDriverMode).toHaveBeenCalledWith('d1', { mode: 'idle', minutes: 30 })
    expect(wrapper.find('[data-testid="sim-mode-saved"]').exists()).toBe(true)
  })

  it('includes offsetMi only for offroute', async () => {
    const store = createSimStoreStub()
    mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
    const wrapper = mount(DriverSimulationControls, { props: { driverId: 'd1' } })

    await wrapper.find('[data-testid="sim-mode-select"]').setValue('offroute')
    await wrapper.find('[data-testid="sim-offset-mi"]').setValue('12')
    await wrapper.find('[data-testid="sim-mode-save"]').trigger('click')
    await Promise.resolve()

    expect(store.setDriverMode).toHaveBeenCalledWith('d1', { mode: 'offroute', offsetMi: 12 })
  })

  it('disables Save while busy and surfaces a store error', () => {
    const store = createSimStoreStub({ busy: true, error: 'Unable to update this driver right now.' })
    mockedUseSimStore.mockReturnValue(store as unknown as ReturnType<typeof useSimStore>)
    const wrapper = mount(DriverSimulationControls, { props: { driverId: 'd1' } })
    expect(wrapper.find('[data-testid="sim-mode-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="sim-mode-error"]').text()).toBe('Unable to update this driver right now.')
  })
})
