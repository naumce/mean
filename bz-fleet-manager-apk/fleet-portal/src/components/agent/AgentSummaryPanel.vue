<script setup lang="ts">
import { computed } from 'vue'
import type { AgentSummary } from '../../stores/nightShift'

// Task 5 (AI Agents Surface plan): the drawer's "View agent" summary block.
// Every word here comes from the server's `AgentSummary` (fleet-backend's
// lib/agentSummary.ts, shared with the AI Agents overview) — the only copy
// this component adds is the two "nothing to report" fallbacks and the two
// "how sure is this" suffixes on What happens next, both spelled out in the
// plan so they read the same everywhere they appear.
const props = defineProps<{ summary: AgentSummary; shadow: boolean }>()

const MODE_LABELS: Record<AgentSummary['mode'], string> = { off: 'Off', shadow: 'Shadow', live: 'Live' }
const ACTIVITY_LABELS: Record<AgentSummary['activity'], string> = {
  off: 'Off',
  watching: 'Watching',
  waiting_reply: 'Waiting for reply',
  escalated: 'Escalated',
  held: 'Held',
  attention: 'Needs attention',
  delivered: 'Delivered',
}

const noticedText = computed(() => props.summary.noticed ?? 'Nothing unusual right now.')
const recommendsText = computed(() => props.summary.recommends ?? 'No recommendation pending.')
const nextText = computed(() => {
  if (props.summary.nextConfidence === 'inferred') return `${props.summary.next} (inferred from the timeline)`
  if (props.summary.nextConfidence === 'unknown') return `${props.summary.next} (no recent report)`
  return props.summary.next
})
const modeLabel = computed(() => MODE_LABELS[props.summary.mode])
const activityLabel = computed(() => ACTIVITY_LABELS[props.summary.activity])
</script>

<template>
  <section class="space-y-3 border-b border-line px-4 py-3" data-testid="agent-summary-panel">
    <div data-testid="summary-noticed">
      <p class="text-[10px] font-bold uppercase tracking-wider text-ink-3">What it noticed</p>
      <p class="mt-0.5 text-xs text-ink-2">{{ noticedText }}</p>
    </div>

    <div data-testid="summary-recommends">
      <p class="text-[10px] font-bold uppercase tracking-wider text-ink-3">What it recommends</p>
      <p class="mt-0.5 text-xs text-ink-2">{{ recommendsText }}</p>
    </div>

    <div data-testid="summary-done">
      <p class="text-[10px] font-bold uppercase tracking-wider text-ink-3">What it has done</p>
      <ul v-if="summary.done.length" class="mt-0.5 space-y-0.5">
        <li v-for="(line, i) in summary.done" :key="i" class="line-clamp-2 text-xs text-ink-2" :title="line">{{ line }}</li>
      </ul>
      <p v-else class="mt-0.5 text-xs text-ink-2">Nothing sent yet.</p>
      <p v-if="shadow" class="mt-1 text-[11px] italic text-ink-3" data-testid="summary-shadow-note">
        Shadow mode: these were recorded, not sent.
      </p>
    </div>

    <div data-testid="summary-next">
      <p class="text-[10px] font-bold uppercase tracking-wider text-ink-3">What happens next</p>
      <p class="mt-0.5 text-xs text-ink-2">{{ nextText }}</p>
    </div>

    <div class="flex items-center gap-2">
      <span class="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-2" data-testid="summary-mode">{{ modeLabel }}</span>
      <span class="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-2" data-testid="summary-activity">{{ activityLabel }}</span>
    </div>
  </section>
</template>
