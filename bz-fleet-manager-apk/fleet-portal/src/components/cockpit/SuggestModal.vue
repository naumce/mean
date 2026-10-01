<script setup lang="ts">
import { computed } from 'vue'
import { formatMiles, formatPct, formatUsd } from '../../lib/money'
import CandidateContextCell from './CandidateContextCell.vue'
import type { ScenarioHint, SuggestResult, SuggestRow } from '../../stores/loadboard'

// ⚡Suggest, in the cockpit: "who should take this load, and why."
//
// The ranking engine has existed since S1 — a transparent weighted score over
// margin, deadhead, HOS slack, appointment risk, home time and lane history —
// but its only UI was on the legacy board, so the most differentiating thing in
// the product could not be reached from the screen a dispatcher actually uses.
//
// The rule that makes this trustworthy: INFEASIBLE DRIVERS ARE SHOWN, NOT
// HIDDEN. A ranking that quietly drops the drivers it rejected is asking to be
// trusted; one that says "Dale — ✗ needs 19h 5m drive; 11h remaining" is
// showing its work. A dispatcher who disagrees can see exactly what the engine
// thought and override it.

const props = withDefaults(
  defineProps<{
    result: SuggestResult | null
    loadReference: string
    lane: string
    revenueCents: number
    loading: boolean
    dispatching: string | null
    /** Task 7's Load.extras.scenario, when this load is one of the 14 named
     *  demo scenarios — null for every ordinary load. Information only, same
     *  as a row's `context` below: it never changes ranking or styling. */
    scenario?: ScenarioHint | null
    tz?: string
    /** Qwen Harness v0.1 (Task 7): whether the AI Lab harness is enabled on
     *  this server (`aiLab.status?.enabled`). This component stays purely
     *  presentational — the parent (CockpitView) owns the aiLab store and
     *  the router, same convention as `dispatch`/`close` below. */
    aiEnabled?: boolean
  }>(),
  { scenario: null, tz: 'America/Chicago', aiEnabled: false },
)
const emit = defineEmits<{
  (e: 'dispatch', payload: { driverId: string; tractorId: string; trailerId: string }): void
  (e: 'close'): void
  (e: 'ask-qwen'): void
}>()

const feasible = computed<SuggestRow[]>(() => props.result?.candidates.filter((c) => c.feasible) ?? [])
const blocked = computed<SuggestRow[]>(() => props.result?.candidates.filter((c) => !c.feasible) ?? [])

/** Score bar width. `score` is null for infeasible rows, which never render one. */
const bar = (score: number | null): string => `${Math.max(2, Math.min(100, score ?? 0))}%`

function dispatch(row: SuggestRow): void {
  const r = props.result
  if (!r?.tractorId || !r?.trailerId) return
  emit('dispatch', { driverId: row.driverId, tractorId: r.tractorId, trailerId: r.trailerId })
}
</script>

<template>
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" data-testid="suggest-modal" @click.self="emit('close')">
    <div class="w-full max-w-3xl rounded-xl border border-line-strong bg-surface shadow-2xl">
      <div class="flex items-start justify-between border-b border-line px-4 py-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-mono text-sm font-bold text-brand-ink">⚡ SUGGEST</span>
            <span class="font-mono text-xs text-ink-3">{{ loadReference }}</span>
          </div>
          <div class="mt-0.5 text-sm font-bold text-ink">{{ lane }}</div>
          <div class="mt-0.5 font-mono text-[10px] text-ink-3">
            {{ formatUsd(revenueCents) }} · {{ result?.requiredEquip ?? '—' }}
            <template v-if="result?.tractorId"> · pool picked tractor + trailer</template>
          </div>
          <!-- Task 7/10: the demo scenario this load was seeded from, purely
               informational — the hint is the "why", never a ranking input. -->
          <div v-if="scenario" class="mt-1 font-mono text-[10px] font-bold text-amber-700 dark:text-amber-400" :title="scenario.hint" data-testid="suggest-scenario">
            Scenario {{ scenario.code }}: {{ scenario.title }}
          </div>
        </div>
        <div class="flex shrink-0 items-start gap-2">
          <!-- Qwen Harness v0.1 (Task 7): read-only dispatch reasoning, dev
               tower tier only — hidden entirely unless the backend harness
               is enabled, never a disabled-but-visible affordance. -->
          <button
            v-if="aiEnabled"
            type="button"
            class="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold text-ink-2 hover:bg-surface-2"
            data-testid="suggest-ask-qwen"
            @click="emit('ask-qwen')"
          >
            Ask Qwen
          </button>
          <button class="rounded px-2 text-ink-3 hover:text-ink" aria-label="Close" data-testid="suggest-close" @click="emit('close')">✕</button>
        </div>
      </div>

      <div v-if="loading" class="px-4 py-8 text-center font-mono text-xs text-ink-3" data-testid="suggest-loading">
        Ranking every driver…
      </div>

      <!-- The engine could not even pick equipment. Stated, not blank. -->
      <div v-else-if="result?.note" class="px-4 py-6 text-center font-mono text-xs text-amber-700 dark:text-amber-400" data-testid="suggest-note">
        {{ result.note }}
      </div>

      <div v-else-if="result" class="max-h-[60vh] overflow-y-auto px-4 py-3">
        <table class="w-full text-left text-xs">
          <thead class="font-mono text-[10px] uppercase tracking-wide text-ink-3">
            <tr>
              <th class="pb-2 pr-2">#</th>
              <th class="pb-2 pr-2">Driver</th>
              <th class="pb-2 pr-2">Fit</th>
              <th class="pb-2 pr-2 text-right">Deadhead</th>
              <th class="pb-2 pr-2 text-right">Margin</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in feasible" :key="row.driverId" class="border-t border-line" :data-suggest-row="row.driverId">
              <td class="py-2 pr-2 font-mono text-ink-3">{{ i + 1 }}</td>
              <td class="py-2 pr-2">
                <div class="font-bold text-ink">
                  {{ row.driverName ?? row.driverId }}
                  <span
                    v-if="row.warnings.length"
                    class="ml-1 text-amber-700 dark:text-amber-400"
                    :title="row.warnings.join('; ')"
                    data-testid="suggest-warning"
                  >⚠</span>
                </div>
                <!-- Task 6/10: context is information only — it never
                     changes this row's order, score, or feasible styling. -->
                <CandidateContextCell v-if="row.context" :context="row.context" :tz="tz" />
              </td>
              <td class="py-2 pr-2">
                <div class="flex items-center gap-2">
                  <div class="h-1.5 w-20 overflow-hidden rounded bg-surface-3">
                    <div class="h-full rounded bg-brand" :style="{ width: bar(row.score) }" />
                  </div>
                  <span class="font-mono text-[10px] text-ink-3">{{ row.score ?? '—' }}</span>
                </div>
              </td>
              <td class="py-2 pr-2 text-right font-mono text-ink-2">{{ formatMiles(row.deadheadMi) }}</td>
              <td class="py-2 pr-2 text-right font-mono" :class="row.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500'">
                {{ formatUsd(row.marginCents) }} <span class="text-ink-3">({{ formatPct(row.marginPct) }})</span>
              </td>
              <td class="py-2 text-right">
                <button
                  type="button"
                  class="rounded border border-brand bg-brand/20 px-2 py-1 font-mono text-[10px] font-bold text-brand-ink hover:bg-brand/30 disabled:opacity-40"
                  :disabled="!!dispatching"
                  :data-testid="`suggest-dispatch-${row.driverId}`"
                  @click="dispatch(row)"
                >
                  {{ dispatching === row.driverId ? 'Dispatching…' : 'Dispatch' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="!feasible.length" class="py-4 text-center font-mono text-xs text-amber-700 dark:text-amber-400" data-testid="suggest-none-feasible">
          No driver can legally take this load right now — every candidate is blocked below.
        </div>

        <!-- Shown, never hidden. A ranking that drops what it rejected is
             asking to be trusted; this one shows its reasoning and lets the
             dispatcher disagree with it. -->
        <div v-if="blocked.length" class="mt-4 border-t border-line pt-3" data-testid="suggest-blocked">
          <div class="mb-2 font-mono text-[10px] uppercase tracking-wide text-ink-3">
            Cannot take it ({{ blocked.length }}) — reason from the engine
          </div>
          <div
            v-for="row in blocked"
            :key="row.driverId"
            class="flex items-start justify-between gap-3 py-1 opacity-70"
            :data-suggest-blocked-row="row.driverId"
          >
            <div class="min-w-0">
              <span class="font-bold text-ink-2">{{ row.driverName ?? row.driverId }}</span>
              <!-- rankOrgDrivers computes context for every
                   candidate, blocked ones included, precisely so a
                   dispatcher can see what a blocked driver would have
                   brought — same component, same props as a feasible row. -->
              <CandidateContextCell v-if="row.context" :context="row.context" :tz="tz" />
            </div>
            <span class="shrink-0 text-right font-mono text-[10px] text-red-700 dark:text-red-400" data-testid="suggest-blocked-reason">
              ✗ {{ row.blockedReason ?? 'blocked' }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
