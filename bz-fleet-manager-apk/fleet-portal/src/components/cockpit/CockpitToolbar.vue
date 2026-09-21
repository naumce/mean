<script setup lang="ts">
import { computed } from 'vue'
import { equipIcon } from '../../lib/cockpit/equipment'
import { useCarriersStore } from '../../stores/carriers'
import { useCockpitStore, type BrickFilter } from '../../stores/cockpit'
import { useFleetStore } from '../../stores/fleet'
import { useLoadboardStore } from '../../stores/loadboard'

const emit = defineEmits<{ jumpNow: []; openFleet: [] }>()
const ck = useCockpitStore()
const lb = useLoadboardStore()
const carriers = useCarriersStore()
const fleet = useFleetStore()
// The one compliance signal that cannot live on a lane: expired clocks on
// equipment nobody is paired with. Paired equipment already shows its own
// DOT/REG/PM chips on the driver row (LaneHeadDriver), so this chip only
// appears when something expired is sitting outside every lane.
const expiredOffBoard = computed(() => fleet.digest?.expiredCount ?? 0)
const equips = computed(() => Array.from(new Set(lb.loads.map((l) => l.requiredEquip))).sort())
// T1 Carrier Layer, Task 8: the filter's server-side ?carrierId= narrows the
// whole board — lanes/tractors/trailers (dispatcherLoadboard.ts) AND the
// Yard panel's draggable chips (dispatcherYard.ts, a separate endpoint) —
// so selecting here must trigger a real reload of both, not just a
// client-side re-filter like the equipment select above.
async function onCarrierChange(value: string): Promise<void> {
  carriers.select(value === '' ? null : value)
  await Promise.all([lb.load(), lb.loadYard()])
}
const chips: Array<{ key: BrickFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'in_progress', label: 'Rolling' },
  { key: 'haz', label: '☣ Hazmat' },
  { key: 'conflict', label: '⚠ Conflicts' },
  { key: 'tendered', label: '⏳ Tendered' },
]
const conflictCount = computed(() => ck.conflictLoadIds.size)
const BTN = 'rounded-lg border px-2 py-1 hover:border-line-strong'
const chipCls = (k: BrickFilter): string =>
  ck.filter === k
    ? `rounded-full border px-2.5 py-0.5 font-bold text-white ${k === 'haz' ? 'border-haz bg-haz' : k === 'conflict' ? 'border-conflict bg-conflict' : k === 'tendered' ? 'border-s-tendered bg-s-tendered' : 'border-brand bg-brand'}`
    : 'rounded-full border border-line bg-surface-3 px-2.5 py-0.5 text-ink-2 hover:border-line-strong'
</script>

<template>
  <section class="flex flex-wrap items-center gap-2 border-b border-line bg-surface/60 px-4 py-1.5 font-mono text-[11px]">
    <select class="rounded-lg border border-line bg-surface-3 px-2 py-1 text-[11px] text-ink-2 outline-none" :value="ck.equip" data-testid="equip-select" @change="ck.setEquip(($event.target as HTMLSelectElement).value)">
      <option value="all">All equipment</option>
      <option v-for="e in equips" :key="e" :value="e">{{ equipIcon(e) }} {{ e }}</option>
    </select>
    <select
      v-if="carriers.list.length > 1"
      class="rounded-lg border border-line bg-surface-3 px-2 py-1 text-[11px] text-ink-2 outline-none"
      :value="carriers.selectedCarrierId ?? ''"
      data-testid="carrier-select"
      @change="onCarrierChange(($event.target as HTMLSelectElement).value)"
    >
      <option value="">All carriers</option>
      <option v-for="c in carriers.list" :key="c.id" :value="c.id">{{ c.name }}</option>
    </select>
    <button type="button" :class="[BTN, 'border-line bg-surface-3 text-ink-2']" data-testid="now-btn" @click="emit('jumpNow')">⏱ Jump to NOW</button>
    <button v-if="expiredOffBoard" type="button" :class="[BTN, 'border-amber-500/40 bg-amber-500/10 font-bold text-amber-500']" title="Expired inspection / registration / service clocks — open Fleet" data-testid="insp-chip" @click="emit('openFleet')">🔧 {{ expiredOffBoard }} expired</button>
    <div class="flex-1" />
    <div class="flex items-center gap-1.5">
      <button v-for="c in chips" :key="c.key" type="button" :class="chipCls(c.key)" :data-filter="c.key" @click="ck.setFilter(c.key)">
        {{ c.label }}<span v-if="c.key === 'conflict' && conflictCount" class="ml-1 text-red-300">({{ conflictCount }})</span>
      </button>
    </div>
  </section>
</template>
