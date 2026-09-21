import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useNightShiftStore, type AgentPolicy } from './nightShift'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPut = vi.mocked(api.put)
const mockedDelete = vi.mocked(api.delete)

const standardPolicy: AgentPolicy = {
  id: 'pol-standard',
  name: 'Standard',
  stopMin: 15,
  delayMin: 30,
  darkMin: 20,
  darkAtStopMin: 60,
  offRouteMi: 3.1,
  offRouteMin: 10,
  rungGapMin: 5,
  maxCalls: 2,
  dispatcherEmail: 'dispatch@fleet.test',
  dispatcherPhone: null,
  customerEmailOn: false,
  shadow: true,
  bossCallOn: true,
  quietFrom: null,
  quietTo: null,
}

describe('useNightShiftStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPut.mockReset()
    mockedDelete.mockReset()
  })

  it('starts empty, not loading, no error', () => {
    const store = useNightShiftStore()

    expect(store.policies).toEqual([])
    expect(store.loadsByPolicy).toEqual({})
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('loadPolicies fetches policies and load counts', async () => {
    mockedGet.mockResolvedValueOnce({ data: { policies: [standardPolicy], loadsByPolicy: { 'pol-standard': 3 } } })

    const store = useNightShiftStore()
    await store.loadPolicies()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/night-shift/policies')
    expect(store.policies).toEqual([standardPolicy])
    expect(store.loadsByPolicy).toEqual({ 'pol-standard': 3 })
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('loadPolicies sets an error on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useNightShiftStore()
    await store.loadPolicies()

    expect(store.policies).toEqual([])
    expect(store.error).toBeTruthy()
    expect(store.loading).toBe(false)
  })

  it('savePolicy with no id POSTs a new policy and reloads', async () => {
    const created = { ...standardPolicy, id: 'pol-2', name: 'Hazmat' }
    mockedPost.mockResolvedValueOnce({ data: { policy: created } })
    mockedGet.mockResolvedValueOnce({ data: { policies: [standardPolicy, created], loadsByPolicy: {} } })

    const store = useNightShiftStore()
    const { id: _id, ...body } = standardPolicy
    const result = await store.savePolicy({ ...body, name: 'Hazmat' })

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/night-shift/policies', { ...body, name: 'Hazmat' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/night-shift/policies')
    expect(result).toEqual(created)
    expect(store.policies).toEqual([standardPolicy, created])
  })

  it('savePolicy with an id PUTs the whole policy and reloads', async () => {
    const edited = { ...standardPolicy, stopMin: 25 }
    mockedPut.mockResolvedValueOnce({ data: { policy: edited } })
    mockedGet.mockResolvedValueOnce({ data: { policies: [edited], loadsByPolicy: {} } })

    const store = useNightShiftStore()
    const { id, ...body } = edited
    const result = await store.savePolicy({ id, ...body })

    expect(mockedPut).toHaveBeenCalledWith(`/dispatcher/night-shift/policies/${id}`, body)
    expect(mockedPost).not.toHaveBeenCalled()
    expect(result).toEqual(edited)
    expect(store.policies).toEqual([edited])
  })

  it('savePolicy surfaces an error and does not reload on failure', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'A policy with that name already exists' } } })

    const store = useNightShiftStore()
    const { id: _id, ...body } = standardPolicy
    await expect(store.savePolicy(body)).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
    expect(store.loading).toBe(false)
  })

  it('deletePolicy DELETEs and reloads', async () => {
    mockedDelete.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: { policies: [], loadsByPolicy: {} } })

    const store = useNightShiftStore()
    await store.deletePolicy('pol-2')

    expect(mockedDelete).toHaveBeenCalledWith('/dispatcher/night-shift/policies/pol-2')
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/night-shift/policies')
  })

  it('deletePolicy surfaces the server refusal on failure', async () => {
    mockedDelete.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'The Standard policy cannot be deleted' } } })

    const store = useNightShiftStore()
    await expect(store.deletePolicy('pol-standard')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
  })

  it('agentFor GETs the load agent state', async () => {
    const body = { enabled: true, policy: standardPolicy, pill: 'watching', line: null, timeline: [] }
    mockedGet.mockResolvedValueOnce({ data: body })

    const store = useNightShiftStore()
    const result = await store.agentFor('load-1')

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent')
    expect(result).toEqual(body)
  })

  it('setSwitch POSTs enabled and policyId when given', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 2 } })

    const store = useNightShiftStore()
    const result = await store.setSwitch('load-1', true, 'pol-standard')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent', { enabled: true, policyId: 'pol-standard' })
    expect(result).toEqual({ load: {}, version: 2 })
  })

  it('setSwitch omits policyId when not given', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 3 } })

    const store = useNightShiftStore()
    await store.setSwitch('load-1', false)

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent', { enabled: false })
  })

  it('setSwitch sends baseVersion when given, alongside policyId', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 5 } })

    const store = useNightShiftStore()
    await store.setSwitch('load-1', true, 'pol-standard', 4)

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent', { enabled: true, policyId: 'pol-standard', baseVersion: 4 })
  })

  it('setSwitch omits baseVersion when not given', async () => {
    mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 6 } })

    const store = useNightShiftStore()
    await store.setSwitch('load-1', false, undefined, undefined)

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent', { enabled: false })
  })

  it('setSwitch rejects with the server\'s STALE_VERSION body on a version conflict', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'STALE_VERSION', current: 7 } } })

    const store = useNightShiftStore()
    await expect(store.setSwitch('load-1', true, 'pol-standard', 3)).rejects.toMatchObject({ response: { data: { error: 'STALE_VERSION', current: 7 } } })
  })

  it('timeline reuses agentFor and returns just the timeline', async () => {
    const entries = [{ atMs: 1, kind: 'update', text: 'would say: hi' }]
    mockedGet.mockResolvedValueOnce({ data: { enabled: true, policy: standardPolicy, pill: 'watching', line: null, timeline: entries } })

    const store = useNightShiftStore()
    const result = await store.timeline('load-1')

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent')
    expect(result).toEqual(entries)
  })

  it('command POSTs kind and payload when given', async () => {
    mockedPost.mockResolvedValueOnce({ data: { command: { id: 'cmd-1' } } })

    const store = useNightShiftStore()
    const result = await store.command('load-1', 'reply', { text: 'ok' })

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent/commands', { kind: 'reply', payload: { text: 'ok' } })
    expect(result).toEqual({ command: { id: 'cmd-1' } })
  })

  it('command omits payload when not given', async () => {
    mockedPost.mockResolvedValueOnce({ data: { command: { id: 'cmd-2' } } })

    const store = useNightShiftStore()
    await store.command('load-1', 'stop')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/load-1/agent/commands', { kind: 'stop' })
  })
})
