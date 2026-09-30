<script setup lang="ts">
import { computed } from 'vue'
import type { AgentLoadRowData } from '../../types/agents'

// AI Agents Surface (Task 4): one row of the AI Agents page's load list.
// Purely presentational — AgentsView passes it one entry of
// AgentsOverview.nightShift.loads (already carrying the shared
// deriveAgentSummary() output, Task 1/3) verbatim.
const props = defineProps<{ load: AgentLoadRowData }>()

const MODE_LABELS: Record<AgentLoadRowData['mode'], string> = { shadow: 'Shadow', live: 'Live', off: 'Off' }
const ACTIVITY_LABELS: Record<string, string> = {
  watching: 'Watching',
  waiting_reply: 'Waiting for reply',
  escalated: 'Escalated',
  held: 'Held',
  attention: 'Needs attention',
  delivered: 'Delivered',
  off: 'Off',
}

// Global Constraint: "never a raw id" — when the load has no board number,
// order ref or external id (agentsOverview.ts's `displayLoadNo` returns
// null), show a short id fragment instead of the full UUID.
const label = computed(() => props.load.boardLoadNo ?? `Load ${props.load.loadId.slice(0, 8)}`)

const modeLabel = computed(() => MODE_LABELS[props.load.mode] ?? props.load.mode)
const activityLabel = computed(() => ACTIVITY_LABELS[props.load.activity] ?? props.load.activity)

// Global Constraint: "Honest summaries" — the `?` only ever appears when
// `nextConfidence !== 'known'`, and its title says exactly which kind of
// uncertainty this is (never a made-up time).
const uncertaintyTitle = computed(() =>
  props.load.nextConfidence === 'inferred' ? 'Inferred from the timeline' : 'No recent report',
)
</script>

<template>
  <div
    class="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
    :data-testid="`agent-load-row-${load.loadId}`"
  >
    <div class="flex items-center gap-2 text-sm">
      <span class="font-semibold text-ink">{{ label }}</span>
      <span class="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2" data-testid="load-mode">{{ modeLabel }}</span>
      <span class="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2" data-testid="load-activity">{{ activityLabel }}</span>
    </div>
    <div class="flex items-center gap-2 text-sm text-ink-2">
      <span data-testid="load-next">{{ load.next }}</span>
      <span
        v-if="load.nextConfidence !== 'known'"
        class="cursor-help text-ink-3"
        :title="uncertaintyTitle"
        data-testid="uncertainty-marker"
      >?</span>
      <RouterLink
        :to="`/cockpit?load=${load.loadId}`"
        class="font-semibold text-brand-ink hover:underline"
        :data-testid="`view-agent-${load.loadId}`"
      >View agent</RouterLink>
    </div>
  </div>
</template>
