<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatDurationMs, formatWallTime, STEP_KIND_LABELS } from '../../lib/aiLabFormat'
import type {
  AssistantPayload,
  ContentPayload,
  ErrorPayload,
  FinalPayload,
  RunStep,
  ThinkingPayload,
  ToolCallPayload,
  ToolResultPayload,
} from '../../types/aiLab'
import JsonViewer from './JsonViewer.vue'

// AI Lab (Qwen Harness v0.1): one entry in the run timeline. Labelled by
// kind (task-7 brief's chain: USER REQUEST -> MODEL -> TOOL REQUEST -> TOOL
// RESULT -> ... -> FINAL PROPOSAL), every card showing its wall time and
// durationMs regardless of kind. Thinking is shown verbatim, never
// interpreted — it is not part of the decision and this card does not
// pretend otherwise.
const props = withDefaults(defineProps<{ step: RunStep; driverNames?: Record<string, string> }>(), {
  driverNames: () => ({}),
})

const label = computed(() => STEP_KIND_LABELS[props.step.kind])

// The payload's real shape is keyed by `step.kind`, a sibling field — not a
// literal tag inside the payload itself — so TS cannot narrow it from the
// template's v-if chain alone. Each computed below is only ever read from
// the template branch that already checked `step.kind`.
const contentPayload = computed(() => props.step.payload as ContentPayload)
const thinkingPayload = computed(() => props.step.payload as ThinkingPayload)
const assistantPayload = computed(() => props.step.payload as AssistantPayload)
const toolCallPayload = computed(() => props.step.payload as ToolCallPayload)
const toolResultPayload = computed(() => props.step.payload as ToolResultPayload)
const finalPayload = computed(() => props.step.payload as FinalPayload)
const errorPayload = computed(() => props.step.payload as ErrorPayload)

const thinkingOpen = ref(false)

function driverLabel(driverId: string | null): string {
  if (!driverId) return 'no driver recommended'
  return props.driverNames[driverId] ?? driverId
}

const cardClass = computed(() => {
  if (props.step.kind === 'error') return 'border-red-300 bg-red-50 dark:bg-red-950/20'
  if (props.step.kind === 'nudge') return 'border-amber-300 bg-amber-50 dark:bg-amber-950/20'
  return 'border-line bg-surface'
})
const labelClass = computed(() => {
  if (props.step.kind === 'error') return 'text-red-600'
  if (props.step.kind === 'nudge') return 'text-amber-600'
  return 'text-ink-3'
})
</script>

<template>
  <div class="rounded-lg border p-3 text-xs" :class="cardClass" :data-testid="`run-step-${step.seq}`" :data-step-kind="step.kind">
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-[10px] font-bold uppercase tracking-wider" :class="labelClass" data-testid="step-kind-label">{{ label }}</span>
      <span class="font-mono text-[10px] text-ink-3" data-testid="step-timing">
        {{ formatWallTime(step.atMs) }} · {{ formatDurationMs(step.durationMs) }}
      </span>
    </div>

    <div v-if="step.kind === 'system' || step.kind === 'user' || step.kind === 'nudge'" class="mt-2 whitespace-pre-wrap text-ink-2" data-testid="step-content">
      {{ contentPayload.content }}
    </div>

    <div v-else-if="step.kind === 'assistant'" class="mt-2 flex flex-col gap-1.5">
      <div v-if="assistantPayload.content" class="whitespace-pre-wrap text-ink-2" data-testid="step-content">{{ assistantPayload.content }}</div>
      <div v-for="(call, i) in assistantPayload.toolCalls" :key="i" class="font-mono text-[11px] font-semibold text-brand-ink" data-testid="step-tool-request-arrow">
        → tool request: {{ call.name }}
      </div>
    </div>

    <div v-else-if="step.kind === 'thinking'" class="mt-2">
      <button
        type="button"
        class="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-ink-3 hover:bg-surface-2"
        data-testid="thinking-toggle"
        @click="thinkingOpen = !thinkingOpen"
      >
        {{ thinkingOpen ? 'Hide thinking' : 'Show thinking' }}
      </button>
      <div v-if="thinkingOpen" class="mt-1.5 whitespace-pre-wrap rounded bg-surface-3 p-2 text-[11px] text-ink-3" data-testid="thinking-content">
        {{ thinkingPayload.text }}
      </div>
    </div>

    <div v-else-if="step.kind === 'tool_call'" class="mt-2 flex flex-col gap-1.5">
      <div class="font-mono text-[11px] font-bold text-ink" data-testid="tool-call-name">→ {{ toolCallPayload.name }}</div>
      <!-- Fix round 1: literal caption so the rendered chain reads USER
           REQUEST -> MODEL -> TOOL REQUEST -> TOOL ARGUMENTS -> TOOL RESULT
           -> ... verbatim, not just "request implies arguments follow". -->
      <div class="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-3" data-testid="tool-arguments-label">TOOL ARGUMENTS</div>
      <JsonViewer :value="toolCallPayload.arguments" />
    </div>

    <div v-else-if="step.kind === 'tool_result'" class="mt-2 flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[10px] font-bold" :class="toolResultPayload.ok ? 'text-emerald-500' : 'text-red-500'" data-testid="tool-result-status">
          {{ toolResultPayload.ok ? 'OK' : 'ERROR' }} · {{ toolResultPayload.name }}
        </span>
        <span
          v-if="toolResultPayload.truncated"
          class="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-800"
          data-testid="tool-result-truncated"
        >
          truncated {{ toolResultPayload.originalSize }}→{{ toolResultPayload.returnedSize }} B
        </span>
      </div>
      <JsonViewer :value="toolResultPayload.ok ? toolResultPayload.preview : (toolResultPayload.errors ?? toolResultPayload.error)" />
    </div>

    <div v-else-if="step.kind === 'final'" class="mt-2 flex flex-col gap-1" data-testid="step-final">
      <div class="font-bold text-ink" data-testid="final-driver">{{ driverLabel(finalPayload.proposal.driverId) }}</div>
      <div class="text-ink-2">{{ finalPayload.proposal.reason }}</div>
      <div class="font-mono text-[10px] text-ink-3">confidence {{ finalPayload.proposal.confidence }}</div>
    </div>

    <div v-else-if="step.kind === 'error'" class="mt-2" data-testid="step-error">
      <span class="font-mono text-[10px] font-bold text-red-600">{{ errorPayload.kind }}</span>
      <div class="text-red-700 dark:text-red-400">{{ errorPayload.message }}</div>
    </div>
  </div>
</template>
