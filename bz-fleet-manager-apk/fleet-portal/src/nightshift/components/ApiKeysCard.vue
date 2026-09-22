<script setup lang="ts">
// The Settings tab's "API keys" card (Task 5, spec §10/§12): issues and
// revokes the `nightshift`-role OrgApiKey rows that the MCP server
// (night-shift-mcp/) and any other machine caller authenticate with. Never
// touches the sheet's own binding or the older webhook ingest key
// (dispatcherIntegrations.ts) — a different credential, a different card.
import { onMounted, ref } from 'vue'
import AppButton from '../../components/AppButton.vue'
import { useApiKeysStore } from '../stores/apiKeys'

const store = useApiKeysStore()
const newKeyName = ref('')
const copied = ref(false)
const revokeTargetId = ref<string | null>(null)

onMounted(() => store.load())

async function onCreate(): Promise<void> {
  copied.value = false
  await store.create(newKeyName.value)
  if (store.justCreatedKey) newKeyName.value = ''
}

async function onCopy(): Promise<void> {
  if (!store.justCreatedKey) return
  try {
    await navigator.clipboard.writeText(store.justCreatedKey)
    copied.value = true
  } catch {
    // Clipboard access can be denied (permissions, insecure context, a test
    // environment with no navigator.clipboard at all) — the key is still on
    // screen to select by hand, so this is not worth surfacing as an error.
  }
}

function onDismissKey(): void {
  store.dismissJustCreated()
  copied.value = false
}

function askRevoke(id: string): void {
  revokeTargetId.value = id
}

async function onConfirmRevoke(): Promise<void> {
  if (!revokeTargetId.value) return
  await store.revoke(revokeTargetId.value)
  revokeTargetId.value = null
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5" data-testid="api-keys-card">
    <div>
      <h2 class="text-sm font-semibold text-ink">API keys</h2>
      <p class="mt-1 text-sm text-ink-2">
        Let Claude, Cursor, or another MCP-capable tool watch loads and drive the agent on your behalf, using the
        <a class="text-brand underline" href="https://www.npmjs.com/package/night-shift-mcp" target="_blank" rel="noreferrer">night-shift-mcp</a>
        server. A key can never go live or edit a policy's shadow setting — that stays a click on this page.
      </p>
    </div>

    <p v-if="store.error" class="text-sm text-red-600" role="alert" data-testid="api-keys-error">{{ store.error }}</p>

    <!-- The key, shown once -->
    <div v-if="store.justCreatedKey" class="flex flex-col gap-2 rounded-lg border border-brand/40 bg-brand/5 p-3" data-testid="just-created-key">
      <p class="text-sm font-medium text-ink">Copy it now — we do not store it.</p>
      <div class="flex items-center gap-2">
        <code class="flex-1 overflow-x-auto rounded bg-surface-2 px-2 py-1 text-xs" data-testid="new-key-value">{{ store.justCreatedKey }}</code>
        <AppButton type="button" variant="ghost" data-testid="copy-key" @click="onCopy">{{ copied ? 'Copied' : 'Copy' }}</AppButton>
      </div>
      <AppButton type="button" variant="ghost" class="self-start" data-testid="dismiss-key" @click="onDismissKey">Done</AppButton>
    </div>

    <!-- Create -->
    <form class="flex items-end gap-2" data-testid="create-key-form" @submit.prevent="onCreate">
      <div class="flex flex-1 flex-col gap-1">
        <label for="api-key-name" class="text-xs font-medium text-ink-2">Name</label>
        <input
          id="api-key-name"
          v-model="newKeyName"
          type="text"
          placeholder="Claude Desktop"
          class="rounded-md border border-line px-2 py-1.5 text-sm"
        />
      </div>
      <AppButton type="submit" :loading="store.loading" data-testid="create-key">New key</AppButton>
    </form>

    <!-- List -->
    <ul class="flex flex-col divide-y divide-line" data-testid="api-key-list">
      <li v-if="store.keys.length === 0 && !store.loading" class="py-2 text-sm text-ink-3" data-testid="no-keys">
        No API keys yet.
      </li>
      <li
        v-for="k in store.keys"
        :key="k.id"
        class="flex items-center justify-between gap-3 py-2"
        :data-testid="`api-key-row-${k.id}`"
      >
        <div class="flex flex-col">
          <span class="text-sm font-medium text-ink">{{ k.name }}</span>
          <span class="text-xs text-ink-3">{{ k.prefix }}… · created {{ formatDate(k.createdAt) }}</span>
        </div>
        <span v-if="k.revokedAt" class="text-xs text-ink-3" data-testid="revoked-label">Revoked</span>
        <AppButton v-else type="button" variant="danger" data-testid="revoke-key" @click="askRevoke(k.id)">Revoke</AppButton>
      </li>
    </ul>

    <!-- Revoke confirmation (Modal is overkill here — no other item on this
         card competes for attention, so an inline confirm keeps the row's
         own context in view). -->
    <div v-if="revokeTargetId" class="flex items-center justify-between rounded-lg border border-line bg-surface-2 p-3" data-testid="revoke-confirm">
      <p class="text-sm text-ink">Revoke this key? Anything using it stops working immediately.</p>
      <div class="flex gap-2">
        <AppButton type="button" variant="ghost" @click="revokeTargetId = null">Cancel</AppButton>
        <AppButton type="button" variant="danger" data-testid="confirm-revoke" @click="onConfirmRevoke">Revoke</AppButton>
      </div>
    </div>
  </div>
</template>
