<script setup lang="ts">
import { computed } from 'vue'
import { PILL_CLASSES } from '../../lib/cockpit/chips'
import { pillOf, type CockpitLane } from '../../lib/cockpit/lanes'

// A carrier lane's head (spec §8.3): the carrier's name and MC, how many of
// their loads are on the board. No driver, no tractor, no clocks — we do not
// see their truck; we see what Their Board said about the load.
const props = withDefaults(defineProps<{ lane: CockpitLane; nowMs: number; compact?: boolean }>(), { compact: false })
const pill = computed(() => pillOf(props.lane, props.nowMs))
const count = computed(() => `${props.lane.legs.length} ${props.lane.legs.length === 1 ? 'load' : 'loads'}`)
</script>

<template>
  <div class="flex h-full items-center justify-between gap-2 px-2" :data-lane-head="lane.id">
    <div class="flex min-w-0 items-center gap-2">
      <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-base" aria-hidden="true">🚚</div>
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-ink">{{ lane.name }} <span class="font-mono text-[10px] font-normal text-ink-3">{{ lane.sub }}</span></div>
        <div v-if="!compact" class="mt-0.5 font-mono text-[10px] text-ink-3">{{ count }} · their truck</div>
      </div>
    </div>
    <span class="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="PILL_CLASSES[pill.c]" data-testid="lane-pill">{{ pill.t }}</span>
  </div>
</template>
