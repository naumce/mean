<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import DataTable from '../components/DataTable.vue'
import FleetMap from '../components/tracking/FleetMap.vue'
import { useTrackingStore } from '../stores/tracking'
import type { DriverLocation } from '../types/dispatcher'

const trackingStore = useTrackingStore()

const columns = [
  { key: 'driverName', label: 'Driver' },
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
  { key: 'speed', label: 'Speed' },
  { key: 'updated', label: 'Updated' },
]

function formatSpeed(speed?: number): string {
  return speed === undefined || speed === null ? '—' : `${speed} mph`
}

function formatUpdatedAgo(createdAt: string): string {
  const elapsedMs = Date.now() - new Date(createdAt).getTime()
  const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`
  const elapsedMinutes = Math.round(elapsedSeconds / 60)
  return `${elapsedMinutes}m ago`
}

const activeDriverCount = computed(() => trackingStore.locations.length)

onMounted(() => {
  trackingStore.startPolling()
  trackingStore.connectRealtime()
})

onBeforeUnmount(() => {
  trackingStore.stopPolling()
  trackingStore.disconnectRealtime()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-gray-900">Live Tracking</h1>
        <p class="text-sm text-gray-500">Latest reported location for each active driver.</p>
      </div>
      <span class="rounded-full bg-primary-50 px-3 py-1 text-sm font-medium text-primary-700">
        {{ activeDriverCount }} active driver{{ activeDriverCount === 1 ? '' : 's' }}
      </span>
    </div>

    <p v-if="trackingStore.error" class="text-sm text-red-600" role="alert">
      {{ trackingStore.error }}
    </p>

    <FleetMap :locations="trackingStore.locations" />

    <DataTable :columns="columns" :rows="trackingStore.locations" row-key="driverId">
      <template #cell-driverName="{ row }">{{ (row as DriverLocation).driverName ?? (row as DriverLocation).driverId }}</template>
      <template #cell-latitude="{ row }">{{ (row as DriverLocation).latitude.toFixed(5) }}</template>
      <template #cell-longitude="{ row }">{{ (row as DriverLocation).longitude.toFixed(5) }}</template>
      <template #cell-speed="{ row }">{{ formatSpeed((row as DriverLocation).speed) }}</template>
      <template #cell-updated="{ row }">{{ formatUpdatedAgo((row as DriverLocation).createdAt) }}</template>
      <template #empty>No driver locations reported yet.</template>
    </DataTable>
  </div>
</template>
