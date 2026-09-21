<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useCockpitStore } from '../../stores/cockpit'

// T5 Dwell and Detention, Task 7: the dispatcher-facing read of Task 6's org-
// wide scan (GET /dispatcher/detention, store.loadDetention). Every
// `StopDetention` row is exactly one of: a clean claim, a claim flagged for
// review, or a refusal (`claim: null`) — see api.ts's `StopDetention` doc.
//
// Cockpit review 2026-09-19: only stops with a claim get a row. A stop the
// engine refused to bill (`claim: null`) is not an event a dispatcher acts
// on, so it no longer earns a card — but Global Constraint 1 ("absent must
// never render as measured") still holds: those stops are counted in the
// "checked" figure, never shown as "$0", and when nothing is owed the panel
// collapses to one line that says so and says how many stops it looked at.
//
// Global Constraint 6 ("every claim carries its own evidence") is why
// `reviewReasons`/`noClaimReason` are interpolated verbatim, never
// paraphrased: they are the engine's own explanation of its own figure (or
// its own refusal), and may be quoted straight to a broker — a component
// that reworded them would drift from the rule that produced them the
// moment either changes independently.
const DEFAULT_WINDOW_HOURS = 72
const ck = useCockpitStore()
const owed = computed(() => ck.detention.items.filter((row) => row.claim !== null))

onMounted(() => {
  void ck.loadDetention(DEFAULT_WINDOW_HOURS)
})
</script>

<template>
  <!-- Store-level failure: the fetch itself never landed. This is NEVER
       collapsed into "no detention anywhere" — an empty list and a failed
       fetch mean opposite things (see stores/cockpit.ts's `detention`
       field doc), and only one of them is "nothing owed". -->
  <div v-if="ck.detention.error" class="rounded-xl border border-line bg-surface p-3 font-mono text-[11px] text-red-500 shadow-xl" data-testid="detention-panel">
    <span data-testid="detention-error">Could not load detention — {{ ck.detention.error }}</span>
  </div>

  <div v-else-if="!owed.length" class="flex items-center gap-2 px-1 font-mono text-[10px] text-ink-3" data-testid="detention-panel">
    <span class="font-bold text-ink-2">⏱ Detention</span>
    <span data-testid="detention-empty">nothing owed in the last {{ DEFAULT_WINDOW_HOURS }}h · {{ ck.detention.items.length }} stops checked</span>
  </div>

  <div v-else class="flex flex-col rounded-xl border border-line bg-surface p-3 shadow-xl" data-testid="detention-panel">
    <div class="flex items-center justify-between border-b border-line pb-2 text-xs">
      <div class="flex items-center gap-2 font-bold text-ink">
        <span>⏱ Detention</span>
        <span class="rounded-full border border-brand/20 bg-brand/10 px-1.5 font-mono text-[10px] text-brand-ink">{{ owed.length }} owed · {{ ck.detention.items.length }} checked</span>
      </div>
      <div class="font-mono text-[10px] text-ink-3">LAST {{ DEFAULT_WINDOW_HOURS }}H</div>
    </div>

    <div class="mt-2.5 flex flex-col gap-2" data-testid="detention-list">
      <div
        v-for="row in owed"
        :key="row.stopId"
        class="rounded-lg border border-line bg-surface-3 p-2.5"
        data-testid="detention-row"
        :data-stop="row.stopId"
        :data-state="row.claim!.needsReview ? 'review' : 'claim'"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 truncate text-xs font-bold text-ink">{{ row.loadRef ?? row.loadId }} · {{ row.stopLabel }} <span class="font-mono text-[10px] text-ink-3">({{ row.stopType }})</span></div>
          <div class="shrink-0 font-mono text-[10px] text-ink-3">{{ row.driverName }}</div>
        </div>
        <div class="mt-1 flex items-center gap-2">
          <span class="font-mono text-sm font-bold text-emerald-500" data-testid="detention-billable">{{ row.claim!.billableMin }} min billable</span>
          <span v-if="row.claim!.needsReview" class="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-500" data-testid="detention-review-marker">⚠ NEEDS REVIEW</span>
        </div>
        <div class="mt-1 font-mono text-[10px] text-ink-3" data-testid="detention-evidence">
          {{ row.claim!.evidence.pingCount }} pings · largest gap {{ row.claim!.evidence.maxGapMin }} min · departure {{ row.claim!.evidence.departureObserved ? 'observed' : 'not observed' }}
        </div>
        <!-- Verbatim, per Global Constraint 6 — see the script-block doc. -->
        <ul v-if="row.claim!.needsReview" class="mt-1 list-disc pl-4 font-mono text-[10px] text-amber-500" data-testid="detention-review-reasons">
          <li v-for="reason in row.claim!.reviewReasons" :key="reason">{{ reason }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>
