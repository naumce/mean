<script setup lang="ts">
import { computed } from 'vue'
import { fmtClock, fmtDayShort } from '../../lib/cockpit/format'
import { formatUsd } from '../../lib/money'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'

// Hover card for a brick — the same facts the drawer shows, at a glance.
const props = defineProps<{ load: BoardLoad | null; anchor: HTMLElement | null; tz: string; nowMs: number }>()
const lb = useLoadboardStore()
const driverName = computed(() => lb.lanes.find((d) => d.id === props.load?.assignment?.driverId)?.name ?? '— open —')
const risk = computed(() => (props.load ? lb.riskByLoadId[props.load.id] ?? null : null))
const pos = computed(() => {
  if (!props.anchor) return { left: '0px', top: '0px' }
  const r = props.anchor.getBoundingClientRect()
  const left = Math.min(r.left, Math.max(8, window.innerWidth - 302))
  const top = r.bottom + 260 > window.innerHeight ? Math.max(8, r.top - 270) : r.bottom + 8
  return { left: `${left}px`, top: `${top}px` }
})
const a = computed(() => props.load?.assignment ?? null)
const rpm = computed(() => (props.load && a.value?.loadedMi ? props.load.revenueCents / a.value.loadedMi / 100 : null))
// Margin + est. cost are the committed rate snapshot verbatim — never derived
// from revenue, and never shown at all when the load was not priced.
const econ = computed(() => a.value?.economics ?? null)
</script>

<template>
  <div v-if="load && anchor" class="pointer-events-none fixed z-[60] w-[290px] rounded-lg border border-line-strong bg-surface font-mono text-xs shadow-2xl" :style="pos" data-testid="popover">
    <div class="flex items-center justify-between border-b border-line px-3 py-2"><span class="font-bold text-ink">{{ load.reference }}</span><span class="rounded border px-1.5 py-0.5 text-[9px] font-black uppercase text-ink-2">{{ a?.status ?? load.status }}</span></div>
    <div class="grid grid-cols-[78px_1fr] gap-x-2 gap-y-1 px-3 py-2 text-[11px]">
      <span class="text-ink-3">Route</span><span class="text-ink">{{ load.origin }} ➔ {{ load.destination }}</span>
      <span class="text-ink-3">Window</span><span class="text-ink">{{ a ? `${fmtDayShort(Date.parse(a.plannedStart), tz)} ${fmtClock(Date.parse(a.plannedStart), tz)} – ${fmtDayShort(Date.parse(a.plannedEnd), tz)} ${fmtClock(Date.parse(a.plannedEnd), tz)}` : 'Unassigned' }}</span>
      <span class="text-ink-3">Equipment</span><span class="text-ink">{{ load.requiredEquip }}</span>
      <span class="text-ink-3">Driver</span><span class="text-ink">{{ driverName }}</span>
      <span class="text-ink-3">Commodity</span><span class="text-ink">{{ load.commodity ?? '—' }}<template v-if="load.weightLbs"> · {{ load.weightLbs.toLocaleString() }} lbs</template></span>
      <template v-if="load.hazmatClass"><span class="text-ink-3">Hazmat</span><span class="font-bold text-haz">⬧ Class {{ load.hazmatClass }} {{ load.unNumber ?? '' }}</span></template>
      <span class="text-ink-3">Stops</span><span class="text-ink">{{ load.stopCount }}</span>
      <span class="text-ink-3">Rate</span><span class="text-ink">{{ formatUsd(load.revenueCents) }}<template v-if="rpm != null"> · ${{ rpm.toFixed(2) }}/mi · {{ Math.round(a!.loadedMi!) }} mi</template></span>
      <template v-if="a"><span class="text-ink-3">Margin</span><span :class="econ ? (econ.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500') : 'text-ink-3'" data-testid="popover-margin">
        <template v-if="econ">{{ formatUsd(econ.marginCents) }} · est. cost {{ formatUsd(econ.estCostCents) }}</template>
        <template v-else>— not priced</template><template v-if="a.deadheadMi"> · {{ Math.round(a.deadheadMi) }} mi deadhead</template></span></template>
      <template v-if="load.brokerName"><span class="text-ink-3">Broker</span><span class="text-ink">{{ load.brokerName }}</span></template>
      <template v-if="load.pickupWindowEnd"><span class="text-ink-3">Pickup by</span><span class="text-ink">{{ fmtDayShort(Date.parse(load.pickupWindowEnd), tz) }} {{ fmtClock(Date.parse(load.pickupWindowEnd), tz) }}</span></template>
      <template v-if="risk"><span class="text-ink-3">Alert</span><span :class="risk === 'block' ? 'text-red-500' : 'text-amber-500'">{{ risk === 'block' ? '⏰ projected to miss its delivery window' : '⚠ tight on its delivery window' }}</span></template>
    </div>
    <div class="border-t border-line px-3 py-1.5 text-[9px] text-ink-3">Click to inspect</div>
  </div>
</template>
