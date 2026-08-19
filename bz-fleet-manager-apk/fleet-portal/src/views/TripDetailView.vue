<script setup lang="ts">
import { computed, onMounted } from 'vue'
import StatusPill from '../components/StatusPill.vue'
import { useDriversStore } from '../stores/drivers'
import { useTripsStore } from '../stores/trips'

const props = defineProps<{ id: string }>()

const tripsStore = useTripsStore()
const driversStore = useDriversStore()

const trip = computed(() => tripsStore.current)

const driverName = computed(() => {
  const driverId = trip.value?.driverId
  if (!driverId) return 'Unassigned'
  const driver = driversStore.items.find((candidate) => candidate.id === driverId)
  return driver?.name ?? 'Unassigned'
})

function proofsForStop(stopId: string) {
  return (trip.value?.proofs ?? []).filter((proof) => proof.stopId === stopId)
}

onMounted(() => {
  tripsStore.get(props.id)
  if (driversStore.items.length === 0) {
    driversStore.list()
  }
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div v-if="tripsStore.loading && !trip" class="text-sm text-gray-500">Loading trip…</div>

    <div v-else-if="tripsStore.error && !trip" class="rounded-lg border border-gray-200 bg-white p-6 text-center">
      <p class="text-sm text-gray-600">{{ tripsStore.error }}</p>
    </div>

    <template v-else-if="trip">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-gray-900">{{ trip.identifier }}</h1>
          <p class="text-sm text-gray-500">Assigned driver: {{ driverName }}</p>
        </div>
        <StatusPill :status="trip.status" />
      </div>

      <div class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold text-gray-700">Stops</h2>
        <ol class="flex flex-col gap-2">
          <li
            v-for="stop in trip.stops"
            :key="stop.id"
            class="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-gray-900">{{ stop.sequence }}. {{ stop.address }}</span>
              <StatusPill v-if="stop.status" :status="stop.status" />
            </div>
            <ul v-if="proofsForStop(stop.id).length > 0" class="flex flex-col gap-1">
              <li v-for="proof in proofsForStop(stop.id)" :key="proof.id" class="flex items-center gap-2 text-sm">
                <span class="text-gray-500">{{ proof.proofType }}</span>
                <a :href="proof.fileUrl" target="_blank" rel="noopener noreferrer" class="text-primary-600 hover:text-primary-700">
                  View proof
                </a>
                <StatusPill :status="proof.status" />
              </li>
            </ul>
          </li>
        </ol>
        <p v-if="trip.stops.length === 0" class="text-sm text-gray-500">No stops recorded for this trip.</p>
      </div>

      <div v-if="trip.checklistItems && trip.checklistItems.length > 0" class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold text-gray-700">Checklist</h2>
        <ul class="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white p-4">
          <li v-for="item in trip.checklistItems" :key="item.id" class="flex items-center gap-2 text-sm text-gray-700">
            <span>{{ item.completed ? '☑' : '☐' }}</span>
            <span>{{ item.label }}</span>
            <span v-if="item.required" class="text-xs uppercase tracking-wide text-gray-400">Required</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
