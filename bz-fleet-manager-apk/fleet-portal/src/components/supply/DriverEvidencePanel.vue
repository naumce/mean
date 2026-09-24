<script setup lang="ts">
import { computed } from 'vue'
import { formatPct } from '../../lib/money'
import type { DriverMetrics } from '../../types/supply'

// Evidence (drawer section 3): every number here comes straight off
// DriverMetrics, no invented labels ("reliable"/"good") anywhere — nulls
// render as "—", never 0 or blank (a null here means "no evidence", which is
// itself a fact worth showing honestly).
const props = defineProps<{ metrics: DriverMetrics | null }>()

const LANE_DISPLAY_LIMIT = 5
const topLanes = computed(() => props.metrics?.laneExperience.slice(0, LANE_DISPLAY_LIMIT) ?? [])

function pct(v: number | null): string {
  return v == null ? '—' : formatPct(v)
}
function minutes(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)} min`
}
function count(v: number | undefined): string {
  return v == null ? '—' : String(v)
}
</script>

<template>
  <section class="border-b border-line px-4 py-3" data-testid="evidence-panel">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-3">Evidence</h3>
    <div v-if="metrics" class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
      <div>Completed loads<div class="font-semibold text-ink" data-testid="metric-completed">{{ count(metrics.completedLoads) }}</div></div>
      <div>On-time rate<div class="font-semibold text-ink" data-testid="metric-on-time-rate">{{ pct(metrics.onTimeRate) }}</div></div>
      <div>Avg delay<div class="font-semibold text-ink" data-testid="metric-avg-delay">{{ minutes(metrics.averageDelayMinutes) }}</div></div>
      <div>Avg detention<div class="font-semibold text-ink" data-testid="metric-avg-detention">{{ minutes(metrics.averageDetentionMinutes) }}</div></div>
      <div>Response rate<div class="font-semibold text-ink" data-testid="metric-response-rate">{{ pct(metrics.responseRate) }}</div></div>
      <div>Avg response time<div class="font-semibold text-ink" data-testid="metric-avg-response">{{ minutes(metrics.averageResponseMinutes) }}</div></div>
      <div>No-response incidents<div class="font-semibold text-ink" data-testid="metric-no-response">{{ count(metrics.noResponseIncidents) }}</div></div>
      <div>Breakdown incidents<div class="font-semibold text-ink" data-testid="metric-breakdown">{{ count(metrics.breakdownIncidents) }}</div></div>
      <div>Accident incidents<div class="font-semibold text-ink" data-testid="metric-accident">{{ count(metrics.accidentIncidents) }}</div></div>
      <div>Loads, last 30 days<div class="font-semibold text-ink" data-testid="metric-last-30-days">{{ count(metrics.loadsLast30Days) }}</div></div>
      <div>Night loads<div class="font-semibold text-ink" data-testid="metric-night-loads">{{ count(metrics.nightLoads) }}</div></div>
    </div>
    <p v-else class="mt-2 text-xs text-ink-3">No metrics yet.</p>

    <div class="mt-3">
      <h4 class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Lane experience</h4>
      <ul v-if="topLanes.length" class="mt-1 flex flex-col gap-1 text-xs" data-testid="lane-experience-list">
        <li v-for="lane in topLanes" :key="lane.laneKey" class="flex justify-between gap-2 text-ink-2">
          <span>{{ lane.originCity ?? '—' }} → {{ lane.destCity ?? '—' }}</span>
          <span class="shrink-0 text-ink-3">{{ lane.runs }} run{{ lane.runs === 1 ? '' : 's' }}</span>
        </li>
      </ul>
      <p v-else class="mt-1 text-xs text-ink-3">No completed lanes yet.</p>
    </div>
  </section>
</template>
