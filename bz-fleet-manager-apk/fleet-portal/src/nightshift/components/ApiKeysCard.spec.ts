import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import ApiKeysCard from './ApiKeysCard.vue'

// Task 5: the Settings tab's card. Mocked at the shared axios client (not
// the store), same discipline ConnectSheet.spec.ts follows for the sheet's
// own card, so a real useApiKeysStore() drives everything the component
// renders.
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedDelete = vi.mocked(api.delete)

const key = { id: 'k1', name: 'Claude Desktop', prefix: 'ns_live_AB', createdAt: '2026-09-22T00:00:00Z', revokedAt: null }

beforeEach(() => {
  setActivePinia(createPinia())
  mockedGet.mockReset()
  mockedPost.mockReset()
  mockedDelete.mockReset()
  mockedGet.mockResolvedValue({ data: { keys: [] } })
})

describe('ApiKeysCard', () => {
  it('loads and lists existing keys on mount', async () => {
    mockedGet.mockResolvedValueOnce({ data: { keys: [key] } })
    const wrapper = mount(ApiKeysCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="api-key-row-k1"]').text()).toContain('Claude Desktop')
    expect(wrapper.find('[data-testid="no-keys"]').exists()).toBe(false)
  })

  it('shows "No API keys yet." when the org has none', async () => {
    const wrapper = mount(ApiKeysCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="no-keys"]').exists()).toBe(true)
  })

  it('creating a key shows it once with the "copy it now" sentence, then hides after Done', async () => {
    mockedPost.mockResolvedValueOnce({ data: { key: 'ns_live_abc123', id: 'k1', prefix: 'ns_live_ab' } })
    mockedGet.mockResolvedValueOnce({ data: { keys: [] } }).mockResolvedValueOnce({ data: { keys: [key] } })
    const wrapper = mount(ApiKeysCard)
    await flushPromises()

    await wrapper.find('#api-key-name').setValue('Claude Desktop')
    await wrapper.find('[data-testid="create-key-form"]').trigger('submit.prevent')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/night-shift/api-keys', { name: 'Claude Desktop' })
    expect(wrapper.find('[data-testid="new-key-value"]').text()).toBe('ns_live_abc123')
    expect(wrapper.text()).toContain('Copy it now — we do not store it.')

    await wrapper.find('[data-testid="dismiss-key"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="just-created-key"]').exists()).toBe(false)
  })

  it('revoking a key asks for confirmation before calling DELETE', async () => {
    mockedGet.mockResolvedValueOnce({ data: { keys: [key] } }).mockResolvedValueOnce({ data: { keys: [{ ...key, revokedAt: '2026-09-22T01:00:00Z' }] } })
    mockedDelete.mockResolvedValueOnce({ data: {} })
    const wrapper = mount(ApiKeysCard)
    await flushPromises()

    await wrapper.find('[data-testid="revoke-key"]').trigger('click')
    expect(mockedDelete).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="revoke-confirm"]').exists()).toBe(true)

    await wrapper.find('[data-testid="confirm-revoke"]').trigger('click')
    await flushPromises()
    expect(mockedDelete).toHaveBeenCalledWith('/dispatcher/night-shift/api-keys/k1')
  })
})
