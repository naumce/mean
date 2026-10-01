<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import AgentLoadRow from '../components/agents/AgentLoadRow.vue'
import DispatchAssistantCard from '../components/agents/DispatchAssistantCard.vue'
import NightShiftCard from '../components/agents/NightShiftCard.vue'
import { useAgentsStore } from '../stores/agents'

// AI Agents Surface (Task 4): "What each agent can do right now" — the
// Dispatch Assistant's readiness and Night Shift's mode/activity, plus the
// per-load list the drawer's own summary (Task 5) agrees with, because both
// read the same deriveAgentSummary() output (Task 1). Polled every 15s while
// mounted, same convention DemoView.vue uses for its own store.
const store = useAgentsStore()

const POLL_MS = 15_000
let pollTimerId: number | null = null

onMounted(async () => {
  await store.load()
  pollTimerId = window.setInterval(() => {
    void store.load()
  }, POLL_MS)
})

onUnmounted(() => {
  if (pollTimerId !== null) {
    window.clearInterval(pollTimerId)
    pollTimerId = null
  }
})
</script>

<template>
  <div class="flex flex-col gap-6" data-testid="agents-view">
    <div>
      <h1 class="text-xl font-semibold text-ink">AI Agents</h1>
      <p class="text-sm text-ink-2">What each agent can do right now, and what it is doing.</p>
    </div>

    <p v-if="store.loading && !store.data" class="text-sm text-ink-2" data-testid="agents-loading">Loading…</p>
    <p v-if="store.error" class="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="agents-error">{{ store.error }}</p>

    <template v-if="store.data">
      <div class="grid gap-4 md:grid-cols-2">
        <DispatchAssistantCard
          :headline="store.dispatchStatus?.headline ?? ''"
          :detail="store.dispatchStatus?.detail ?? ''"
        />
        <NightShiftCard
          :headline="store.nightShiftStatus?.headline ?? ''"
          :detail="store.nightShiftStatus?.detail ?? ''"
        />
      </div>

      <template v-if="store.data.nightShift.loads.length > 0">
        <p
          v-if="store.data.nightShift.loads.length < store.data.nightShift.activity.listed"
          class="text-xs text-ink-3"
          data-testid="loads-showing-count"
        >
          Showing {{ store.data.nightShift.loads.length }} of {{ store.data.nightShift.activity.listed }} loads
        </p>
        <div class="rounded-lg border border-line bg-surface">
          <AgentLoadRow v-for="load in store.data.nightShift.loads" :key="load.loadId" :load="load" />
        </div>
      </template>
      <p v-else class="text-sm text-ink-3">No loads are being watched right now.</p>
    </template>
  </div>
</template>
