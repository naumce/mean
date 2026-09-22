import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useApiKeysStore } from './apiKeys'

// Task 5: each store action is a thin call onto exactly one
// /api/dispatcher/night-shift/api-keys route (dispatcherApiKeys.ts) —
// mocked at the shared axios client, same discipline sheet.spec.ts follows.
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedDelete = vi.mocked(api.delete)

const key = { id: 'k1', name: 'Claude Desktop', prefix: 'ns_live_AB', createdAt: '2026-09-22T00:00:00Z', revokedAt: null }

describe('useApiKeysStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedDelete.mockReset()
  })

  it('load() calls GET .../api-keys and stores the list', async () => {
    mockedGet.mockResolvedValueOnce({ data: { keys: [key] } })
    const store = useApiKeysStore()
    await store.load()
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/night-shift/api-keys')
    expect(store.keys).toEqual([key])
  })

  it('load() failure sets an error from the caught exception', async () => {
    mockedGet.mockRejectedValueOnce(new Error('boom'))
    const store = useApiKeysStore()
    await store.load()
    expect(store.error).toBe('boom')
  })

  it('create() posts the name, records the raw key once, and reloads the list', async () => {
    mockedPost.mockResolvedValueOnce({ data: { key: 'ns_live_secret', id: 'k1', prefix: 'ns_live_AB' } })
    mockedGet.mockResolvedValueOnce({ data: { keys: [key] } })
    const store = useApiKeysStore()
    await store.create('Claude Desktop')
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/night-shift/api-keys', { name: 'Claude Desktop' })
    expect(store.justCreatedKey).toBe('ns_live_secret')
    expect(store.keys).toEqual([key])
  })

  it('create() refuses a blank name locally, without a round trip', async () => {
    const store = useApiKeysStore()
    await store.create('   ')
    expect(mockedPost).not.toHaveBeenCalled()
    expect(store.error).toContain('Name the key')
  })

  it('revoke() deletes by id and reloads the list', async () => {
    mockedDelete.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: { keys: [] } })
    const store = useApiKeysStore()
    await store.revoke('k1')
    expect(mockedDelete).toHaveBeenCalledWith('/dispatcher/night-shift/api-keys/k1')
    expect(store.keys).toEqual([])
  })

  it('dismissJustCreated() clears the one-time key from state', async () => {
    mockedPost.mockResolvedValueOnce({ data: { key: 'ns_live_secret', id: 'k1', prefix: 'ns_live_AB' } })
    mockedGet.mockResolvedValueOnce({ data: { keys: [key] } })
    const store = useApiKeysStore()
    await store.create('Claude Desktop')
    store.dismissJustCreated()
    expect(store.justCreatedKey).toBeNull()
  })
})
