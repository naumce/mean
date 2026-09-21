<script setup lang="ts">
import type { BoardConfig } from '../../lib/board/geometry'
import type { BoardLane, BoardTrip } from '../../stores/board'
import TripBrick from './TripBrick.vue'

defineProps<{ lane: BoardLane; trips: BoardTrip[]; config: BoardConfig }>()
</script>

<template>
  <div :data-lane="lane.id" class="flex border-b border-gray-200">
    <div class="w-40 shrink-0 border-r border-gray-200 px-3 py-2 text-sm font-medium text-gray-700">
      {{ lane.name }}
    </div>
    <div class="relative h-14 flex-1" :style="{ width: `${config.boardWidthPx}px` }">
      <TripBrick v-for="t in trips" :key="t.id" :trip="t" :config="config" />
    </div>
  </div>
</template>
