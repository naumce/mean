<script setup lang="ts">
import { computed } from 'vue'
import StatusPill from '../StatusPill.vue'
import type { BoardConfig } from '../../lib/board/geometry'
import { brickWidth, timeToX } from '../../lib/board/geometry'
import type { BoardTrip } from '../../stores/board'

const props = defineProps<{ trip: BoardTrip; config: BoardConfig }>()

const style = computed(() => {
  if (!props.trip.scheduledStart || !props.trip.scheduledEnd) return {}
  const start = new Date(props.trip.scheduledStart)
  const end = new Date(props.trip.scheduledEnd)
  return {
    left: `${Math.round(timeToX(start, props.config))}px`,
    width: `${Math.round(brickWidth(start, end, props.config))}px`,
  }
})
</script>

<template>
  <div
    :data-trip="trip.id"
    class="absolute top-1 h-12 overflow-hidden rounded-md border border-primary-600 bg-primary-50 px-2 py-1 text-xs shadow-sm"
    :style="style"
  >
    <div class="flex items-center gap-1">
      <span class="font-semibold text-primary-700">{{ trip.identifier }}</span>
      <StatusPill :status="trip.status" />
    </div>
    <div class="text-gray-500">{{ trip.stopCount }} stops</div>
  </div>
</template>
