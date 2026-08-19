import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { Conversation, Message } from '../types/dispatcher'

interface MessagesState {
  conversations: Conversation[]
  currentThread: Message[]
  currentId: string | null
  loading: boolean
  error: string | null
}

export const useMessagesStore = defineStore('messages', {
  state: (): MessagesState => ({
    conversations: [],
    currentThread: [],
    currentId: null,
    loading: false,
    error: null,
  }),

  actions: {
    async listConversations(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<Conversation[]>('/dispatcher/conversations')
        this.conversations = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load conversations right now.')
      } finally {
        this.loading = false
      }
    },

    async openThread(conversationId: string): Promise<void> {
      this.currentId = conversationId
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<Message[]>(`/dispatcher/conversations/${conversationId}/messages`)
        this.currentThread = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load this conversation right now.')
      } finally {
        this.loading = false
      }
    },

    async send(conversationId: string, text: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/conversations/${conversationId}/messages`, { text })
        await this.openThread(conversationId)
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to send the message right now.')
        this.loading = false
        throw error
      }
    },
  },
})
