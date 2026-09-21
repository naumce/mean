<script setup lang="ts">
import { computed } from 'vue'
import { backlogUrgency } from '../../lib/board/urgency'
import { equipClass, equipIcon, equipLabel } from '../../lib/cockpit/equipment'
import { fmtDT } from '../../lib/cockpit/format'
import { formatUsd } from '../../lib/money'
import { useCockpitStore } from '../../stores/cockpit'

// Uncovered freight, tightest pickup window first (store getter). Drag and
// ⚡Suggest arrive with S2; S1 cards open the inspect drawer on click.
const props = defineProps<{ nowMs: number }>()
const emit = defineEmits<{ open: [loadId: string]; suggest: [loadId: string] }>()
const ck = useCockpitStore()
const cards = computed(() => ck.backlog.map((l) => ({ l, urgency: backlogUrgency(l.pickupWindowEnd, props.nowMs) })))
const URGENCY_CLASS = { missed: 'bg-red-600 text-white', now: 'bg-red-500/20 text-red-500 border border-red-500/40', soon: 'bg-amber-500/15 text-amber-500 border border-amber-500/40' }
</script>

<template>
  <div class="flex flex-col rounded-xl border border-line bg-surface p-3 shadow-xl">
    <div class="flex items-center justify-between border-b border-line pb-2 text-xs">
      <div class="flex items-center gap-2 font-bold text-ink">
        <span>📦 Unassigned Freight Backlog</span>
        <span class="rounded-full border border-brand/20 bg-brand/10 px-1.5 font-mono text-[10px] text-brand-ink">{{ cards.length }} Open</span>
      </div>
      <div class="font-mono text-[10px] text-ink-3">ORDERED BY EARLIEST APPOINTMENT</div>
    </div>
    <div class="mt-2.5 grid grid-cols-1 gap-2 2xl:grid-cols-2">
      <div v-for="{ l, urgency } in cards" :key="l.id" class="flex items-stretch gap-1.5">
      <!-- ⚡Suggest: "who should take this?" — the ranking engine has existed
           since S1 but had no way in from the cockpit. Its own control rather
           than a click on the card, because opening the load and asking for a
           ranking are two different intentions. -->
      <button
        v-if="l.stopCount > 0"
        type="button"
        class="shrink-0 rounded-lg border border-brand/40 bg-brand/10 px-2 font-mono text-sm text-brand-ink transition hover:bg-brand/25"
        :data-testid="`backlog-suggest-${l.id}`"
        :title="`Rank every driver for ${l.reference}`"
        @click.stop="emit('suggest', l.id)"
      >⚡</button>
      <!-- A blank row started on Their Board has nothing to rank against yet;
           the engine would only refuse it (InvalidStopSet). Say so instead. -->
      <span v-else class="shrink-0 rounded-lg border border-line bg-surface-3 px-2 font-mono text-sm text-ink-3" :data-testid="`backlog-nostops-${l.id}`" title="No stops yet — nothing to rank">·</span>
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-line bg-surface-3 p-2.5 text-left transition hover:border-brand/50"
        :data-bid="l.id"
        :data-urgency="urgency?.level ?? ''"
        @click="emit('open', l.id)"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="shrink-0 rounded border px-2 py-1 font-mono text-xs font-bold" :class="l.hazmatClass ? 'border-amber-500/30 bg-amber-500/10 text-amber-500' : 'border-brand/30 bg-brand/10 text-brand-ink'">{{ l.reference }}</span>
          <div class="min-w-0">
            <div class="flex items-center gap-2 overflow-hidden whitespace-nowrap text-xs font-bold text-ink">
              <template v-if="l.stopCount > 0">{{ l.origin }} ➔ {{ l.destination }}</template>
              <span v-else class="font-normal text-ink-3">no stops yet — finish this row on Their Board</span>
              <span v-if="urgency" class="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="URGENCY_CLASS[urgency.level]">{{ urgency.label }}</span>
              <span v-else-if="l.pickupWindowEnd" class="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-500">Appt {{ fmtDT(Date.parse(l.pickupWindowEnd), ck.tz) }}</span>
              <span v-if="l.hazmatClass" class="rounded border border-red-500/30 bg-red-500/20 px-1.5 py-0.5 font-mono text-[9px] font-bold text-red-500">⚠️ HAZMAT CLASS {{ l.hazmatClass }}<template v-if="l.unNumber"> ({{ l.unNumber }})</template></span>
            </div>
            <div class="mt-0.5 flex items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[10px] text-ink-3">
              <span class="rounded px-1" :class="equipClass(l.requiredEquip)">{{ equipIcon(l.requiredEquip) }} {{ equipLabel(l.requiredEquip) }}</span>
              <span v-if="l.weightLbs || l.commodity">• {{ l.weightLbs ? l.weightLbs.toLocaleString() + ' lbs ' : '' }}{{ l.commodity ?? '' }}</span>
              <span v-if="l.brokerName">• <span class="text-ink-2">{{ l.brokerName }}</span></span>
              <!-- Spec §8.3: a carrier lined up on an open load is not a carrier booked.
                   The row stays in the backlog; the chip tells "no carrier" from
                   "carrier not yet confirmed". -->
              <span v-if="l.carrierId" data-carrier-chip class="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-cyan-600">{{ l.carrierName ?? 'Carrier' }} · pending</span>
              <span>• {{ l.stopCount }} stop{{ l.stopCount === 1 ? '' : 's' }}</span>
            </div>
          </div>
        </div>
        <div class="shrink-0 text-right"><div class="font-mono text-xs font-bold text-emerald-500">{{ formatUsd(l.revenueCents) }}</div></div>
      </button>
      </div>
      <div v-if="!cards.length" class="py-3 font-mono text-[11px] text-ink-3">Board is clean — every load dispatched. 🎉</div>
    </div>
  </div>
</template>
