import { RouterLinkStub, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessagesStore } from '../stores/messages'
import MessagesView from './MessagesView.vue'

vi.mock('../stores/messages', () => ({
  useMessagesStore: vi.fn(),
}))

const mockedUseMessagesStore = vi.mocked(useMessagesStore)

function createMessagesStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    conversations: [],
    currentThread: [],
    currentId: null,
    loading: false,
    error: null,
    listConversations: vi.fn(),
    openThread: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function mountMessagesView() {
  return mount(MessagesView, {
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

function findButtonByText(wrapper: ReturnType<typeof mountMessagesView>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === text)
  if (!button) throw new Error(`No button found with text "${text}"`)
  return button
}

const conversationWithMessage = {
  id: 'c1',
  driverId: 'drv-1',
  driverName: 'Dana Driver',
  lastMessage: { id: 'm1', senderType: 'driver', text: 'On my way', createdAt: '2026-01-01' },
  unread: 2,
}

const conversationWithoutMessage = {
  id: 'c2',
  driverId: 'drv-2',
  driverName: 'Sam Driver',
  lastMessage: null,
  unread: 0,
}

describe('MessagesView', () => {
  beforeEach(() => {
    mockedUseMessagesStore.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads conversations on mount and renders them, handling a null lastMessage safely', () => {
    const store = createMessagesStoreStub({ conversations: [conversationWithMessage, conversationWithoutMessage] })
    mockedUseMessagesStore.mockReturnValue(store as unknown as ReturnType<typeof useMessagesStore>)

    const wrapper = mountMessagesView()

    expect(store.listConversations).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Dana Driver')
    expect(wrapper.text()).toContain('On my way')
    expect(wrapper.text()).toContain('Sam Driver')
    expect(wrapper.text()).toContain('No messages yet.')
    expect(wrapper.text()).toContain('2')
  })

  it('selecting a conversation calls openThread with its id', async () => {
    const store = createMessagesStoreStub({ conversations: [conversationWithMessage] })
    mockedUseMessagesStore.mockReturnValue(store as unknown as ReturnType<typeof useMessagesStore>)
    const wrapper = mountMessagesView()

    await wrapper.find('[data-conversation-row]').trigger('click')

    expect(store.openThread).toHaveBeenCalledWith('c1')
  })

  it('typing a message and clicking Send calls store.send with the conversation id and text', async () => {
    const store = createMessagesStoreStub({
      conversations: [conversationWithMessage],
      currentId: 'c1',
      currentThread: [],
    })
    mockedUseMessagesStore.mockReturnValue(store as unknown as ReturnType<typeof useMessagesStore>)
    const wrapper = mountMessagesView()

    await wrapper.find('#message-composer').setValue('Please confirm delivery')
    expect(findButtonByText(wrapper, 'Send').attributes('type')).toBe('submit')
    await wrapper.find('form').trigger('submit.prevent')
    await Promise.resolve()

    expect(store.send).toHaveBeenCalledWith('c1', 'Please confirm delivery')
  })

  it('shows a placeholder when no conversation is selected', () => {
    const store = createMessagesStoreStub({ conversations: [conversationWithMessage] })
    mockedUseMessagesStore.mockReturnValue(store as unknown as ReturnType<typeof useMessagesStore>)
    const wrapper = mountMessagesView()

    expect(wrapper.text()).toContain('Select a conversation to view messages.')
  })
})
