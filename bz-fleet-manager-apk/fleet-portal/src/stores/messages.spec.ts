import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useMessagesStore } from './messages'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

const sampleConversation = {
  id: 'c1',
  driverId: 'drv-1',
  driverName: 'Dana Driver',
  lastMessage: { id: 'm1', senderType: 'driver', text: 'On my way', createdAt: '2026-01-01' },
  unread: 1,
}

const sampleConversationNoMessage = {
  id: 'c2',
  driverId: 'drv-2',
  driverName: 'Sam Driver',
  lastMessage: null,
  unread: 0,
}

const sampleThread = [
  { id: 'm1', senderType: 'driver', text: 'On my way', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'm2', senderType: 'dispatcher', text: 'Great, thanks', createdAt: '2026-01-01T00:01:00.000Z' },
]

describe('useMessagesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
  })

  it('starts empty, not loading, no error', () => {
    const store = useMessagesStore()

    expect(store.conversations).toEqual([])
    expect(store.currentThread).toEqual([])
    expect(store.currentId).toBeNull()
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('listConversations fetches and populates conversations, including one with a null lastMessage', async () => {
    mockedGet.mockResolvedValueOnce({ data: [sampleConversation, sampleConversationNoMessage] })

    const store = useMessagesStore()
    await store.listConversations()

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/conversations')
    expect(store.conversations).toEqual([sampleConversation, sampleConversationNoMessage])
    expect(store.error).toBeNull()
  })

  it('listConversations sets an error on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useMessagesStore()
    await store.listConversations()

    expect(store.conversations).toEqual([])
    expect(store.error).toBeTruthy()
  })

  it('openThread loads the thread and sets currentId/currentThread', async () => {
    mockedGet.mockResolvedValueOnce({ data: sampleThread })

    const store = useMessagesStore()
    await store.openThread('c1')

    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/conversations/c1/messages')
    expect(store.currentId).toBe('c1')
    expect(store.currentThread).toEqual(sampleThread)
    expect(store.error).toBeNull()
  })

  it('openThread sets an error on failure', async () => {
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })

    const store = useMessagesStore()
    await store.openThread('c1')

    expect(store.currentThread).toEqual([])
    expect(store.error).toBeTruthy()
  })

  it('send posts {text} to the conversation then refreshes the thread', async () => {
    mockedPost.mockResolvedValueOnce({ data: {} })
    mockedGet.mockResolvedValueOnce({ data: sampleThread })

    const store = useMessagesStore()
    await store.send('c1', 'Great, thanks')

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/conversations/c1/messages', { text: 'Great, thanks' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/conversations/c1/messages')
    expect(store.currentThread).toEqual(sampleThread)
  })

  it('send surfaces an error and does not refresh the thread on failure', async () => {
    mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: {} } })

    const store = useMessagesStore()
    await expect(store.send('c1', 'bad')).rejects.toBeTruthy()

    expect(store.error).toBeTruthy()
    expect(mockedGet).not.toHaveBeenCalled()
  })
})
