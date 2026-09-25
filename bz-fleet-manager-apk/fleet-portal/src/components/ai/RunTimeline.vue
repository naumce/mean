<script setup lang="ts">
import { computed } from 'vue'
import type { RunStep } from '../../types/aiLab'
import RunStepCard from './RunStepCard.vue'

// AI Lab (Qwen Harness v0.1): the observable loop, rendered as a vertical
// list of RunStepCards in seq order. Sorted defensively — the API is
// documented to answer steps in order already, but this is the one place a
// dispatcher reads the run's history, so it must never depend on the wire
// happening to preserve it.
const props = withDefaults(defineProps<{ steps: RunStep[]; driverNames?: Record<string, string> }>(), {
  driverNames: () => ({}),
})

const sortedSteps = computed(() => [...props.steps].sort((a, b) => a.seq - b.seq))
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="run-timeline">
    <RunStepCard v-for="step in sortedSteps" :key="step.seq" :step="step" :driver-names="driverNames" />
    <div v-if="sortedSteps.length === 0" class="rounded-lg border border-line bg-surface p-4 text-center text-xs text-ink-3" data-testid="run-timeline-empty">
      No steps recorded yet.
    </div>
  </div>
</template>
