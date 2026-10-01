<script setup lang="ts">
import type { ProposalComparisonEntry } from '../../types/aiLab'

// dispatch-v2 A/B experiment: the model's own strengths/weaknesses/unknowns
// per finalist (Proposal.comparison, present only for dispatch-v2 runs) —
// mounted under ProposalCard in AiRunView.vue when that field exists. Never
// declares a finalist "better"/"correct" (same neutrality rule as
// ProposalCard's rank line): the chosen row is marked as a fact ("this is
// what got picked"), not a judgement on the comparison itself.
const props = withDefaults(
  defineProps<{ comparison: ProposalComparisonEntry[]; chosenDriverId?: string | null; driverNames?: Record<string, string> }>(),
  { chosenDriverId: null, driverNames: () => ({}) },
)

function driverLabel(driverId: string): string {
  return props.driverNames[driverId] ?? driverId
}
</script>

<template>
  <div class="rounded-lg border border-line bg-surface p-3 text-xs" data-testid="comparison-table">
    <div class="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-3">Comparison (dispatch-v2)</div>
    <div class="mt-2 overflow-x-auto">
      <table class="min-w-full divide-y divide-line text-[11px]">
        <thead class="text-[10px] uppercase tracking-wide text-ink-3">
          <tr>
            <th class="px-2 py-1 text-left font-medium">Driver</th>
            <th class="px-2 py-1 text-left font-medium">Strengths</th>
            <th class="px-2 py-1 text-left font-medium">Weaknesses</th>
            <th class="px-2 py-1 text-left font-medium">Unknowns</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          <tr
            v-for="entry in comparison"
            :key="entry.driverId"
            data-testid="comparison-row"
            :data-driver-id="entry.driverId"
            :class="entry.driverId === chosenDriverId ? 'bg-emerald-50' : undefined"
          >
            <td class="px-2 py-2 align-top font-medium text-ink">
              {{ driverLabel(entry.driverId) }}
              <span
                v-if="entry.driverId === chosenDriverId"
                class="ml-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200"
                data-testid="comparison-chosen-badge"
              >chosen</span>
            </td>
            <td class="px-2 py-2 align-top text-ink-2" data-testid="comparison-strengths">
              <ul v-if="entry.strengths.length" class="list-disc pl-3">
                <li v-for="(s, i) in entry.strengths" :key="i">{{ s }}</li>
              </ul>
              <span v-else>—</span>
            </td>
            <td class="px-2 py-2 align-top text-ink-2" data-testid="comparison-weaknesses">
              <ul v-if="entry.weaknesses.length" class="list-disc pl-3">
                <li v-for="(w, i) in entry.weaknesses" :key="i">{{ w }}</li>
              </ul>
              <span v-else>—</span>
            </td>
            <td class="px-2 py-2 align-top text-ink-2" data-testid="comparison-unknowns">
              <ul v-if="entry.unknowns.length" class="list-disc pl-3">
                <li v-for="(u, i) in entry.unknowns" :key="i">{{ u }}</li>
              </ul>
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
