<script setup lang="ts">
import { computed, onMounted } from 'vue'
import FleetLane from '../components/board/FleetLane.vue'
import TimeRuler from '../components/board/TimeRuler.vue'
import StatusPill from '../components/StatusPill.vue'
import { useBoardStore } from '../stores/board'
import type { BoardTrip } from '../stores/board'

const board = useBoardStore()

const backlog = computed<BoardTrip[]>(() => board.trips.filter((t) => !t.scheduledStart))
function laneTrips(laneId: string): BoardTrip[] {
  return board.trips.filter((t) => t.driverId === laneId && t.scheduledStart)
}

onMounted(() => board.load())
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Dispatch board</h1>
      <p class="text-sm text-gray-500">Every driver a lane, every trip a slot. The control room.</p>
    </div>

    <p v-if="board.error" class="text-sm text-red-600" role="alert">{{ board.error }}</p>

    <div class="overflow-x-auto rounded-lg border border-gray-200">
      <TimeRuler :config="board.config" />
      <FleetLane
        v-for="lane in board.lanes"
        :key="lane.id"
        :lane="lane"
        :trips="laneTrips(lane.id)"
        :config="board.config"
      />
      <p v-if="board.lanes.length === 0" class="p-6 text-sm text-gray-400">No drivers yet.</p>
    </div>

    <div data-testid="board-backlog" class="rounded-lg border border-dashed border-gray-300 p-3">
      <h2 class="mb-2 text-sm font-semibold text-gray-700">Backlog — unscheduled trips</h2>
      <div class="flex flex-wrap gap-2">
        <div
          v-for="t in backlog"
          :key="t.id"
          :data-trip="t.id"
          class="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
        >
          <span class="font-semibold text-gray-700">{{ t.identifier }}</span>
          <StatusPill :status="t.status" />
          <span class="text-gray-400">{{ t.stopCount }} stops</span>
        </div>
        <p v-if="backlog.length === 0" class="text-sm text-gray-400">Nothing waiting.</p>
      </div>
    </div>
  </div>
</template>
