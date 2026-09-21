<script setup lang="ts">
import { computed } from 'vue'
import { EQUIP_CLASSES, EQUIP_TYPES, equipIcon } from '../../lib/cockpit/equipment'
import { useLoadboardStore } from '../../stores/loadboard'

// Cockpit review 2026-09-19: the legend explains what is on the board, not
// everything the board could ever draw. Equipment swatches follow the
// loads in view; the map's mandatory-break pin belongs to the radar's own
// legend, not here.
const lb = useLoadboardStore()
const equipInView = computed(() => {
  const present = new Set(lb.loads.map((l) => l.requiredEquip))
  return EQUIP_TYPES.filter((t) => present.has(t))
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-4 px-1 font-mono text-[10px] text-ink-3">
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-4 rounded-sm border border-s-assigned/60 bg-s-assigned/15" />Assigned</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-4 rounded-sm border border-s-progress/70 bg-s-progress/15" />Rolling</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-4 rounded-sm border border-s-completed/50 bg-s-completed/15" />Delivered</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-4 rounded-sm border border-dashed border-s-tendered/70 bg-s-tendered/15" />Tendered</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-4 rounded-sm border border-conflict bg-conflict/20" />Conflict</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-4 rounded-sm border border-dashed border-amber-500" />Equip / hazmat / reg flag</span>
    <span class="flex items-center gap-1.5"><span class="ck-dh inline-block h-[2px] w-4" />Deadhead</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-1 w-3 bg-emerald-400" /><span class="inline-block h-1 w-3 bg-amber-400" /><span class="inline-block h-1 w-3 bg-ink-3/40" />Milestones done / current / pending</span>
    <span class="flex items-center gap-1.5"><span class="ck-hatch inline-block h-2.5 w-4 rounded-sm border border-line" />Empty drive</span>
    <span v-if="equipInView.length" class="h-3 w-px bg-line-strong" />
    <span v-for="t in equipInView" :key="t" class="flex items-center gap-1"><span class="rounded px-1" :class="EQUIP_CLASSES[t]">{{ equipIcon(t) }}</span>{{ t }}</span>
  </div>
</template>
