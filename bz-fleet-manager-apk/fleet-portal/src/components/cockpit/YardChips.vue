<script setup lang="ts">
import { equipClass, equipIcon } from '../../lib/cockpit/equipment'
import { hrsLabel, initials } from '../../lib/cockpit/format'
import { useLoadboardStore } from '../../stores/loadboard'

// What is free RIGHT NOW (/dispatcher/yard). Tractor/trailer chips are
// draggable onto a driver's lane to pair them — the drag itself is handled by
// GanttBoard's document-level pointerdown listener via each chip's `data-res`
// ("tractor"/"trailer") + `data-rid` (unit id), not by anything in this file.
const lb = useLoadboardStore()
</script>

<template>
  <div class="rounded-xl border border-line bg-surface p-3 shadow-xl">
    <div class="flex items-center justify-between border-b border-line pb-2 text-xs">
      <div class="font-bold text-ink">🏗 Yard — available now</div>
      <div class="font-mono text-[10px] text-ink-3">BOBTAIL · DROPPED · OPEN</div>
    </div>
    <div v-if="lb.yard" class="mt-2.5 flex flex-col gap-2.5">
      <div>
        <div class="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">🚛 Bobtail tractors <span class="rounded-full bg-surface-3 px-1.5 font-mono text-ink-2">{{ lb.yard.tractors.length }}</span></div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="t in lb.yard.tractors" :key="t.id" class="inline-flex cursor-grab items-center gap-2 rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-[11px] active:cursor-grabbing" data-res="tractor" :data-rid="t.id"><span class="grid h-5 w-5 place-items-center rounded bg-slate-500/30 text-[10px]">🚛</span><span><span class="font-mono font-bold text-ink">#{{ t.unit }}</span> <span class="text-[10px] text-ink-3">{{ t.make ?? '' }}</span></span></span>
          <span v-if="!lb.yard.tractors.length" class="font-mono text-[10px] text-ink-3">none</span>
        </div>
      </div>
      <div>
        <div class="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">🔗 Dropped trailers <span class="rounded-full bg-surface-3 px-1.5 font-mono text-ink-2">{{ lb.yard.trailers.length }}</span></div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="r in lb.yard.trailers" :key="r.id" class="inline-flex cursor-grab items-center gap-2 rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-[11px] active:cursor-grabbing" data-res="trailer" :data-rid="r.id"><span class="grid h-5 w-5 place-items-center rounded text-[10px]" :class="equipClass(r.type)">{{ equipIcon(r.type) }}</span><span><span class="font-mono font-bold text-ink">{{ r.unit }}</span> <span class="text-[10px] text-ink-3">{{ r.type }}{{ r.length ? ' ' + r.length : '' }}</span></span></span>
          <span v-if="!lb.yard.trailers.length" class="font-mono text-[10px] text-ink-3">none</span>
        </div>
      </div>
      <div>
        <div class="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">🧑‍✈️ Open drivers <span class="rounded-full bg-surface-3 px-1.5 font-mono text-ink-2">{{ lb.yard.drivers.length }}</span></div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="d in lb.yard.drivers" :key="d.id" class="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-[11px]" data-res="driver" :data-rid="d.id"><span class="grid h-5 w-5 place-items-center rounded bg-brand text-[10px] font-bold text-white">{{ initials(d.name) }}</span><span><span class="font-bold text-ink">{{ d.name }}</span> <span class="font-mono text-[10px] text-ink-3">DRV {{ hrsLabel(d.hosKnown ? d.driveRemainingMin : null) }}</span></span></span>
          <span v-if="!lb.yard.drivers.length" class="font-mono text-[10px] text-ink-3">none</span>
        </div>
      </div>
    </div>
    <div v-else class="mt-2.5 font-mono text-[11px] text-ink-3">Loading yard…</div>
  </div>
</template>
