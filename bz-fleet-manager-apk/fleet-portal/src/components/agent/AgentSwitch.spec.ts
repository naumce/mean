import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import type { AgentPolicy } from '../../stores/nightShift'
import AgentSwitch from './AgentSwitch.vue'

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const standard: AgentPolicy = {
  id: 'pol-standard', name: 'Standard', stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60, offRouteMi: 3.1,
  offRouteMin: 10, rungGapMin: 5, maxCalls: 2, dispatcherEmail: 'd@fleet.test', dispatcherPhone: null,
  customerEmailOn: false, shadow: true, bossCallOn: true, quietFrom: null, quietTo: null,
}
const hazmat: AgentPolicy = { ...standard, id: 'pol-hazmat', name: 'Hazmat' }

describe('AgentSwitch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedGet.mockResolvedValue({ data: { policies: [standard, hazmat], loadsByPolicy: {} } })
  })

  it('loads the policy list on mount for the picker', async () => {
    mount(AgentSwitch, { props: { load: { id: 'l1', version: 2, agentEnabled: false, agentPolicyId: null } } })
    await flushPromises()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/night-shift/policies')
  })

  it('turning on opens a policy picker defaulting to Standard, and confirming POSTs and emits change', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 3 } })
    const w = mount(AgentSwitch, { props: { load: { id: 'l1', version: 2, agentEnabled: false, agentPolicyId: null } } })
    await flushPromises()

    await w.get('[data-agent-switch]').trigger('click')
    expect(w.find('[data-agent-policy-picker]').exists()).toBe(true)
    expect((w.get('[data-policy-select]').element as HTMLSelectElement).value).toBe('pol-standard')

    await w.get('[data-agent-policy-picker] [data-confirm]').trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/l1/agent', { enabled: true, policyId: 'pol-standard', baseVersion: 2 })
    expect(w.emitted('change')).toEqual([[{ enabled: true, policyId: 'pol-standard' }]])
    expect(w.find('[data-agent-policy-picker]').exists()).toBe(false)
  })

  it('cancelling the picker does not switch anything on', async () => {
    const w = mount(AgentSwitch, { props: { load: { id: 'l1', version: 2, agentEnabled: false, agentPolicyId: null } } })
    await flushPromises()
    await w.get('[data-agent-switch]').trigger('click')
    await w.get('[data-agent-policy-picker] [data-cancel]').trigger('click')
    expect(mockedPost).not.toHaveBeenCalled()
    expect(w.find('[data-agent-policy-picker]').exists()).toBe(false)
  })

  it('turning off asks "Stop watching this load?" and confirming POSTs enabled: false', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 4 } })
    const w = mount(AgentSwitch, { props: { load: { id: 'l1', version: 3, agentEnabled: true, agentPolicyId: 'pol-standard' } } })
    await flushPromises()

    await w.get('[data-agent-switch]').trigger('click')
    expect(w.find('[data-agent-off-confirm]').text()).toContain('Stop watching this load?')

    await w.get('[data-agent-off-confirm] [data-confirm]').trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/l1/agent', { enabled: false, baseVersion: 3 })
    expect(w.emitted('change')).toEqual([[{ enabled: false }]])
  })

  it('cancelling the stop confirm leaves the load watched', async () => {
    const w = mount(AgentSwitch, { props: { load: { id: 'l1', version: 3, agentEnabled: true, agentPolicyId: 'pol-standard' } } })
    await flushPromises()
    await w.get('[data-agent-switch]').trigger('click')
    await w.get('[data-agent-off-confirm] [data-cancel]').trigger('click')
    expect(mockedPost).not.toHaveBeenCalled()
    expect(w.find('[data-agent-off-confirm]').exists()).toBe(false)
  })

  it('Task 11: disabledReason overrides the default title when disabled', async () => {
    const w = mount(AgentSwitch, {
      props: {
        load: { id: 'l1', version: 2, agentEnabled: false, agentPolicyId: null },
        disabled: true,
        disabledReason: 'Change it in the Night Shift column of your sheet',
      },
    })
    await flushPromises()
    expect(w.get('[data-agent-switch]').attributes('title')).toBe('Change it in the Night Shift column of your sheet')
  })

  it('a load someone else holds disables the switch and clicking it does nothing', async () => {
    const w = mount(AgentSwitch, { props: { load: { id: 'l1', version: 2, agentEnabled: false, agentPolicyId: null }, disabled: true } })
    await flushPromises()
    const btn = w.get('[data-agent-switch]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('Someone else is editing this load')
    await btn.trigger('click')
    expect(w.find('[data-agent-policy-picker]').exists()).toBe(false)
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('on a 409 STALE_VERSION it shows the load moved and emits stale, without emitting change', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'STALE_VERSION', current: 9 } } })
    const w = mount(AgentSwitch, { props: { load: { id: 'l1', version: 2, agentEnabled: false, agentPolicyId: null } } })
    await flushPromises()

    await w.get('[data-agent-switch]').trigger('click')
    await w.get('[data-agent-policy-picker] [data-confirm]').trigger('click')
    await flushPromises()

    expect(w.emitted('stale')).toBeTruthy()
    expect(w.emitted('change')).toBeUndefined()
    expect(w.get('[data-agent-switch-error]').text()).toContain('changed elsewhere')
  })
})
