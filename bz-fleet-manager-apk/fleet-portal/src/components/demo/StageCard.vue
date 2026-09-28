<script setup lang="ts">
import { ref, watch } from 'vue'
import { DEFAULT_REPLY_TEXT } from '../../stores/demo'
import type { DemoActionKind, DemoStageAction } from '../../types/demo'

// Demo Mode (2026-09-28 plan, Task 2; fix round 1): the big center card —
// the current stage's plain-language narration and the ONE action button
// the brief calls for. Narration + action only: raw `story.log` text must
// never reach this card (fix round 1, Critical #2) — the collapsed
// "Technical log" in HowItWorksLinks is the only place that surfaces it,
// since a log line can legitimately contain a forbidden presenter word (e.g.
// the engine-fallback line names "deterministic") that is fine buried in a
// developer-facing expander and never fine on the unhidden main screen.
//
// Presentational + its own local textbox state only; DemoView owns every
// store call, dispatched off the `act` event so a poll tick replacing
// `action` mid-edit never stomps on text the presenter is still typing (see
// the watch() below — it only resets the draft when the STAGE changes, not
// on every poll of the same stage).
const props = defineProps<{
  narration: string | null
  action: DemoStageAction | null
  busy: boolean
  /** fix round 1, Important #4: worker.configured === false means WORKER_URL
   *  isn't set on this server — the driver-reply proxy has nothing to reach.
   *  Only shown alongside the driver_reply action itself. */
  workerConfigured: boolean
}>()
const emit = defineEmits<{ act: [payload: { kind: DemoActionKind; text?: string }] }>()

const replyText = ref(DEFAULT_REPLY_TEXT)
watch(
  () => props.action?.kind,
  (kind, previousKind) => {
    if (kind === 'driver_reply' && previousKind !== 'driver_reply') replyText.value = DEFAULT_REPLY_TEXT
  },
)

function onAct(): void {
  if (!props.action || props.busy || props.action.disabled) return
  if (props.action.kind === 'driver_reply') {
    emit('act', { kind: 'driver_reply', text: replyText.value })
    return
  }
  emit('act', { kind: props.action.kind })
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6" data-testid="stage-card">
    <p class="text-lg font-semibold leading-snug text-ink" data-testid="stage-narration">
      {{ narration ?? 'Getting the story ready…' }}
    </p>

    <p
      v-if="action?.kind === 'driver_reply' && !workerConfigured"
      class="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-600"
      data-testid="driver-channel-banner"
    >
      The driver channel is not connected on this server — the reply cannot be sent here.
    </p>

    <div v-if="action" class="flex flex-col items-start gap-2">
      <textarea
        v-if="action.kind === 'driver_reply'"
        v-model="replyText"
        rows="2"
        class="w-full max-w-md rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
        data-testid="stage-reply-text"
      />
      <button
        type="button"
        class="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="busy || action.disabled"
        data-testid="stage-action-button"
        @click="onAct"
      >
        {{ busy ? 'Working…' : action.label }}
      </button>
      <p v-if="action.subline" class="text-xs text-ink-3" data-testid="stage-action-subline">{{ action.subline }}</p>
    </div>
  </div>
</template>
