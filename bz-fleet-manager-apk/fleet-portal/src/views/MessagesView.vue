<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppButton from '../components/AppButton.vue'
import FormField from '../components/FormField.vue'
import { useMessagesStore } from '../stores/messages'
import type { Conversation } from '../types/dispatcher'

const messagesStore = useMessagesStore()

const composerText = ref('')

const selectedConversation = computed<Conversation | null>(
  () => messagesStore.conversations.find((conversation) => conversation.id === messagesStore.currentId) ?? null,
)

async function selectConversation(conversation: Conversation): Promise<void> {
  composerText.value = ''
  await messagesStore.openThread(conversation.id)
}

async function handleSend(): Promise<void> {
  if (!messagesStore.currentId || composerText.value.trim() === '') return
  const text = composerText.value
  composerText.value = ''
  try {
    await messagesStore.send(messagesStore.currentId, text)
  } catch {
    // messagesStore.error already reflects the failure; surfaced via the banner below.
  }
}

onMounted(() => {
  messagesStore.listConversations()
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold text-ink">Messages</h1>
      <p class="text-sm text-ink-2">Message drivers directly and review conversation history.</p>
    </div>

    <p v-if="messagesStore.error" class="text-sm text-red-600 dark:text-red-400" role="alert">
      {{ messagesStore.error }}
    </p>

    <div class="flex h-[32rem] gap-4">
      <div class="flex w-72 flex-shrink-0 flex-col overflow-y-auto rounded-lg border border-line bg-surface">
        <div v-if="messagesStore.conversations.length === 0" class="p-6 text-center text-sm text-ink-3">
          No conversations yet.
        </div>
        <button
          v-for="conversation in messagesStore.conversations"
          :key="conversation.id"
          type="button"
          data-conversation-row
          class="flex flex-col gap-0.5 border-b border-line px-4 py-3 text-left hover:bg-surface-2"
          :class="conversation.id === messagesStore.currentId ? 'bg-brand-wash' : ''"
          @click="selectConversation(conversation)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-medium text-ink">{{ conversation.driverName }}</span>
            <span
              v-if="conversation.unread > 0"
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-600 px-1.5 text-xs font-semibold text-white"
            >
              {{ conversation.unread }}
            </span>
          </div>
          <span class="truncate text-xs text-ink-3">{{ conversation.lastMessage?.text ?? 'No messages yet.' }}</span>
        </button>
      </div>

      <div class="flex flex-1 flex-col rounded-lg border border-line bg-surface">
        <template v-if="selectedConversation">
          <div class="border-b border-line px-4 py-3">
            <span class="text-sm font-semibold text-ink">{{ selectedConversation.driverName }}</span>
          </div>

          <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
            <div
              v-for="message in messagesStore.currentThread"
              :key="message.id"
              class="flex"
              :class="message.senderType === 'dispatcher' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-xs rounded-lg px-3 py-2 text-sm"
                :class="message.senderType === 'dispatcher' ? 'bg-primary-600 text-white' : 'bg-surface-3 text-ink'"
              >
                {{ message.text }}
              </div>
            </div>
            <p v-if="messagesStore.currentThread.length === 0" class="text-center text-sm text-ink-3">
              No messages yet.
            </p>
          </div>

          <form class="flex items-end gap-2 border-t border-line p-3" @submit.prevent="handleSend">
            <FormField id="message-composer" label="Message" class="flex-1">
              <textarea
                id="message-composer"
                v-model="composerText"
                rows="2"
                placeholder="Type a message…"
                class="w-full rounded-md border border-line-strong px-3 py-2 text-sm text-ink focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
              />
            </FormField>
            <AppButton type="submit" :loading="messagesStore.loading">Send</AppButton>
          </form>
        </template>

        <div v-else class="flex flex-1 items-center justify-center text-sm text-ink-3">
          Select a conversation to view messages.
        </div>
      </div>
    </div>
  </div>
</template>
