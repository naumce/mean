<script setup lang="ts">
import type { UncoveredLoad } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1): pick one uncovered load to run the harness
// against. Purely presentational — the parent (AiExperimentView) owns the
// fetch (aiLab.loadUncoveredLoads) and the actual `startRun` call.
withDefaults(defineProps<{ loads: UncoveredLoad[]; starting?: string | null }>(), { starting: null })
const emit = defineEmits<{ select: [loadId: string] }>()

/** Compact date+time, browser-local — same rationale as RunStepCard's wall
 *  time: this is a picker fact to skim, not an org-tz scheduling commitment. */
function formatWindowBound(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}
function formatWindow(load: UncoveredLoad): string {
  if (!load.pickupWindowStart && !load.pickupWindowEnd) return 'pickup window unknown'
  return `pickup ${formatWindowBound(load.pickupWindowStart)} – ${formatWindowBound(load.pickupWindowEnd)}`
}
</script>

<template>
  <div class="rounded-lg border border-line bg-surface p-3 text-xs" data-testid="run-load-picker">
    <div class="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-3">Run on a load</div>
    <div v-if="loads.length === 0" class="mt-2 text-ink-3" data-testid="run-load-picker-empty">No uncovered loads right now.</div>
    <ul v-else class="mt-2 flex flex-col divide-y divide-line">
      <li v-for="load in loads" :key="load.id" class="flex items-center justify-between gap-2 py-1.5" data-testid="run-load-picker-row" :data-load-id="load.id">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="truncate font-medium text-ink">{{ load.externalId ?? load.id }}</span>
            <span class="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">{{ load.requiredEquip }}</span>
            <span v-if="load.scenario" class="rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-800 dark:text-amber-200" :title="load.scenario.hint">
              {{ load.scenario.code }}: {{ load.scenario.title }}
            </span>
          </div>
          <div class="mt-0.5 flex items-center gap-2 truncate text-ink-3" data-testid="run-load-picker-route">
            <span v-if="load.customerName">{{ load.customerName }} ·</span>
            <span>{{ load.originCity ?? '—' }} → {{ load.destCity ?? '—' }}</span>
            <span>{{ formatWindow(load) }}</span>
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 rounded border border-brand bg-brand/10 px-2 py-1 font-mono text-[10px] font-bold text-brand-ink hover:bg-brand/20 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="starting === load.id"
          data-testid="run-load-picker-start"
          @click="emit('select', load.id)"
        >
          {{ starting === load.id ? 'Starting…' : 'Run' }}
        </button>
      </li>
    </ul>
  </div>
</template>
