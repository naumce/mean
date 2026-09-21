<script setup lang="ts">
import { computed } from 'vue'
import { clockChip, PILL_CLASSES, type Chip } from '../../lib/cockpit/chips'
import { equipClass, equipIcon } from '../../lib/cockpit/equipment'
import { pillOf, type CockpitLane } from '../../lib/cockpit/lanes'

// Tractor / trailer lane header: unit identity, its compliance clocks, and
// the driver currently paired to it.
const props = withDefaults(defineProps<{ lane: CockpitLane; driverName: string | null; nowMs: number; compact?: boolean }>(), { compact: false })
const pill = computed(() => pillOf(props.lane, props.nowMs))
const unit = computed(() => props.lane.tractor ?? props.lane.trailer!)
const chips = computed<Array<Chip & { key: string }>>(() => [
  { key: 'DOT', ...clockChip('DOT', unit.value.inspectionExpiresAt, props.nowMs) },
  { key: 'REG', ...clockChip('REG', unit.value.registrationExpiresAt, props.nowMs) },
  { key: 'PM', ...clockChip('PM', unit.value.nextServiceAt, props.nowMs) },
])
</script>

<template>
  <div class="flex items-start justify-between gap-2">
    <div class="flex min-w-0 items-center gap-2.5">
      <div v-if="lane.trailer" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-base" :class="equipClass(lane.trailer.type)">{{ equipIcon(lane.trailer.type) }}</div>
      <div v-else class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-blue-500/30 bg-blue-500/10 text-base">🚛</div>
      <div class="min-w-0">
        <div class="whitespace-nowrap text-xs font-bold text-ink">{{ lane.name }} <span class="font-mono text-[10px] font-normal text-ink-3">{{ lane.sub }}</span></div>
        <div v-if="!compact" class="mt-0.5 font-mono text-[10px] text-ink-3">{{ driverName ? `🧑‍✈️ ${driverName}` : lane.trailer ? '— unhooked —' : '— no driver —' }}</div>
        <div v-if="!compact" class="mt-1 flex items-center gap-1.5 whitespace-nowrap font-mono text-[9px]">
          <span v-for="c in chips" :key="c.key" class="rounded border px-1" :class="c.cls" :data-testid="`chip-${c.key}`">{{ c.text }}</span>
        </div>
      </div>
    </div>
    <span class="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="PILL_CLASSES[pill.c]" data-testid="lane-pill">{{ pill.t }}</span>
  </div>
</template>
