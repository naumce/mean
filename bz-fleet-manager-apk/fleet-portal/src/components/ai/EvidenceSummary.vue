<script setup lang="ts">
import type { Evidence } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1): all seven `Evidence` fields (fix round 1 — the
// first cut only showed three). Design §2's own description of
// `collectEvidence` calls `factsCited` out specifically as "the facts cited
// (the proposal's reasons verbatim, plus the step numbers whose results
// mention the proposed driver)" — the actual citation trail behind the
// proposal, and the single most "observability"-relevant field here, so it
// starts expanded while the rest start collapsed (compact by default).
// Native <details>/<summary> — no extra per-section boolean state needed,
// same "collapsed until asked for" idea as RunStepCard's thinking toggle.
const props = withDefaults(defineProps<{ evidence: Evidence; driverNames?: Record<string, string> }>(), {
  driverNames: () => ({}),
})
const emit = defineEmits<{ 'select-step': [seq: number] }>()

function driverLabel(driverId: string): string {
  return props.driverNames[driverId] ?? driverId
}
</script>

<template>
  <div class="rounded-lg border border-line bg-surface p-3 font-mono text-[11px] text-ink-2" data-testid="evidence-summary">
    <div class="font-bold uppercase tracking-wide text-ink-3">Evidence</div>

    <details class="mt-2" data-testid="evidence-tools-called">
      <summary class="cursor-pointer select-none text-ink-2">tools called ({{ evidence.toolsCalled.length }})</summary>
      <div class="mt-1 flex flex-col gap-0.5 pl-3">
        <div v-for="t in evidence.toolsCalled" :key="t.name">{{ t.name }} × {{ t.count }}</div>
        <div v-if="!evidence.toolsCalled.length" class="text-ink-3">none</div>
      </div>
    </details>

    <details class="mt-1" data-testid="evidence-candidates-inspected">
      <summary class="cursor-pointer select-none text-ink-2">candidates inspected ({{ evidence.candidatesInspected.length }})</summary>
      <div class="mt-1 pl-3">{{ evidence.candidatesInspected.join(', ') || 'none' }}</div>
    </details>

    <details class="mt-1" data-testid="evidence-feasibility-seen">
      <summary class="cursor-pointer select-none text-ink-2">feasibility seen ({{ evidence.feasibilitySeen.length }})</summary>
      <div class="mt-1 flex flex-col gap-0.5 pl-3">
        <div v-for="(f, i) in evidence.feasibilitySeen" :key="i" class="flex flex-wrap items-center gap-2" data-testid="feasibility-row">
          <span class="text-ink">{{ driverLabel(f.driverId) }}</span>
          <span :class="f.feasible ? 'text-emerald-500' : 'text-red-500'">{{ f.feasible ? 'feasible' : 'blocked' }}</span>
          <span v-if="f.score != null">score {{ f.score }}</span>
          <span v-if="f.blockedReason" class="text-ink-3">{{ f.blockedReason }}</span>
          <span class="rounded bg-surface-3 px-1 text-[10px] uppercase text-ink-3" data-testid="feasibility-source">{{ f.source }}</span>
        </div>
        <div v-if="!evidence.feasibilitySeen.length" class="text-ink-3">none</div>
      </div>
    </details>

    <details class="mt-1" data-testid="evidence-metrics-inspected">
      <summary class="cursor-pointer select-none text-ink-2">metrics inspected ({{ evidence.metricsInspected.length }})</summary>
      <div class="mt-1 pl-3">{{ evidence.metricsInspected.join(', ') || 'none' }}</div>
    </details>

    <details class="mt-1" data-testid="evidence-history-inspected">
      <summary class="cursor-pointer select-none text-ink-2">history inspected ({{ evidence.historyInspected.length }})</summary>
      <div class="mt-1 pl-3">{{ evidence.historyInspected.join(', ') || 'none' }}</div>
    </details>

    <details class="mt-1" open data-testid="evidence-facts-cited">
      <summary class="cursor-pointer select-none text-ink-2">facts cited ({{ evidence.factsCited.length }})</summary>
      <div class="mt-1 flex flex-col gap-0.5 pl-3">
        <div v-for="(fact, i) in evidence.factsCited" :key="i" data-testid="fact-cited-row">
          <span v-if="fact.forDriverId" class="text-ink">{{ driverLabel(fact.forDriverId) }}: </span>{{ fact.text }}
        </div>
        <div v-if="!evidence.factsCited.length" class="text-ink-3">none</div>
      </div>
    </details>

    <details class="mt-1" data-testid="evidence-supporting-steps">
      <summary class="cursor-pointer select-none text-ink-2">supporting steps ({{ evidence.supportingSteps.length }})</summary>
      <div class="mt-1 flex flex-wrap gap-1 pl-3">
        <button
          v-for="seq in evidence.supportingSteps"
          :key="seq"
          type="button"
          class="rounded border border-line px-1.5 py-0.5 hover:bg-surface-2"
          data-testid="supporting-step"
          @click="emit('select-step', seq)"
        >
          #{{ seq }}
        </button>
        <span v-if="!evidence.supportingSteps.length" class="text-ink-3">none</span>
      </div>
    </details>
  </div>
</template>
