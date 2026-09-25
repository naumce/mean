<script setup lang="ts">
import { computed } from 'vue'
import { deterministicTopCandidate, rankOfDriver } from '../../lib/aiLabFormat'
import { formatMiles, formatPct } from '../../lib/money'
import type { Baseline, Proposal } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1): Qwen's proposal beside the deterministic
// engine's own top feasible candidate, plus where Qwen's pick ranks in that
// same baseline order — the ENGINE vs QWEN comparison the design doc's
// evaluation methodology is built on. This never declares either one
// "correct" (design §6) — it states the rank as a fact and leaves the
// judgement to the dispatcher recording a verdict.
const props = withDefaults(
  defineProps<{ proposal: Proposal | null; baseline: Baseline | null; driverNames?: Record<string, string> }>(),
  { driverNames: () => ({}) },
)

function driverLabel(driverId: string | null): string {
  if (!driverId) return 'no driver recommended'
  return props.driverNames[driverId] ?? driverId
}

const topCandidate = computed(() => deterministicTopCandidate(props.baseline))
const rank = computed(() => rankOfDriver(props.baseline, props.proposal?.driverId ?? null))
</script>

<template>
  <div class="rounded-lg border border-line bg-surface p-3 text-xs" data-testid="proposal-card">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div data-testid="proposal-qwen">
        <div class="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-3">Qwen proposes</div>
        <div v-if="proposal" class="mt-1 flex flex-col gap-1">
          <div class="font-bold text-ink" data-testid="proposal-driver">{{ driverLabel(proposal.driverId) }}</div>
          <div class="font-mono text-[11px] text-ink-2">confidence {{ formatPct(proposal.confidence) }}</div>
          <div class="text-ink-2">{{ proposal.reason }}</div>
          <div v-if="proposal.alternatives.length" class="mt-1 flex flex-col gap-0.5" data-testid="proposal-alternatives">
            <div class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Alternatives</div>
            <div v-for="(alt, i) in proposal.alternatives" :key="i" class="text-ink-3">{{ driverLabel(alt.driverId) }} — {{ alt.reason }}</div>
          </div>
        </div>
        <div v-else class="mt-1 text-ink-3" data-testid="proposal-none">No proposal yet.</div>
      </div>

      <div data-testid="proposal-baseline">
        <div class="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-3">Deterministic top</div>
        <div v-if="topCandidate" class="mt-1 flex flex-col gap-1">
          <div class="font-bold text-ink">{{ topCandidate.driverName }}</div>
          <div class="font-mono text-[11px] text-ink-2">score {{ topCandidate.score ?? '—' }} · {{ formatMiles(topCandidate.deadheadMi) }} deadhead</div>
        </div>
        <div v-else class="mt-1 text-ink-3" data-testid="baseline-none">No deterministic baseline captured.</div>
      </div>
    </div>

    <div class="mt-3 border-t border-line pt-2 font-mono text-[11px] text-ink-2" data-testid="proposal-rank">
      <template v-if="!proposal?.driverId">Qwen's pick: no driver recommended.</template>
      <template v-else-if="rank != null">Qwen's pick ranks #{{ rank }} of {{ baseline?.candidates.length }} in the deterministic order.</template>
      <template v-else>Qwen's pick does not appear in the deterministic baseline.</template>
    </div>
  </div>
</template>
