<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DriverDrawer from '../components/supply/DriverDrawer.vue'
import DriverSupplyRow from '../components/supply/DriverSupplyRow.vue'
import FleetMap from '../components/tracking/FleetMap.vue'
import SimControls from '../components/sim/SimControls.vue'
import { statusLabel, statusMarkerColor } from '../lib/supplyFormat'
import { useAuthStore } from '../stores/auth'
import { useDriverSupplyStore } from '../stores/driverSupply'
import { useSimStore } from '../stores/sim'
import type { DriverLocation } from '../types/dispatcher'
import type { AvailabilityStatus } from '../types/supply'

// Driver Supply (AI Dispatch Foundation, Task 9): every driver's status,
// location, load, HOS, equipment and preferences, on a map and in rows — the
// map + filter-bar + table shell described in the brief; the drawer (row
// click) is Task 10's page but this view mounts it (its own visibility is
// driven entirely by the store's selectedDriverId, see DriverDrawer.vue).
const store = useDriverSupplyStore()
const auth = useAuthStore()
const sim = useSimStore()

// Simulation controls sit behind a collapsed disclosure; a running sim opens it
// automatically until the user makes their own choice by clicking.
const simChoice = ref<boolean | null>(null)
const simOpen = computed(() => simChoice.value ?? sim.state?.running === true)

// Task 10: a sim tick moves trucks/loads server-side without this view's own
// 30s poll knowing to hurry up — reload the moment one lands.
watch(
  () => sim.lastTickAt,
  () => {
    void store.load()
  },
)

const tz = computed(() => auth.org?.timezone ?? 'America/Chicago')

const STATUS_OPTIONS: AvailabilityStatus[] = ['AVAILABLE', 'AVAILABLE_SOON', 'ON_LOAD', 'OFF_DUTY', 'UNAVAILABLE']

function toggleStatus(status: AvailabilityStatus): void {
  const current = store.filters.statuses
  const next = current.includes(status) ? current.filter((s) => s !== status) : [...current, status]
  store.setFilters({ statuses: next })
}

/** Coloured by availability status, looked up straight off the live
 *  `availability` record (not the filtered `rows`) — a driver hidden by the
 *  current filters must still show its real status colour on the map,
 *  which is never filtered (brief: "every driver with locationSharingEnabled"). */
function markerColor(location: DriverLocation): string | null {
  const a = store.availability[location.driverId]
  return a ? statusMarkerColor(a.status) : null
}

function onEquipmentChange(event: Event): void {
  store.setFilters({ equipment: (event.target as HTMLSelectElement).value || null })
}
function onLanguageChange(event: Event): void {
  store.setFilters({ language: (event.target as HTMLSelectElement).value || null })
}
function onStateChange(event: Event): void {
  store.setFilters({ state: (event.target as HTMLSelectElement).value || null })
}
function onAcceptingOnlyChange(event: Event): void {
  store.setFilters({ acceptingOnly: (event.target as HTMLInputElement).checked })
}

onMounted(() => {
  store.load()
  store.startPolling()
  store.connectRealtime()
})
onBeforeUnmount(() => {
  store.stopPolling()
  store.disconnectRealtime()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-ink">Driver Supply</h1>
      <p class="text-sm text-ink-2">
        Every driver's status, location, load, HOS, equipment and home base — updated live.
      </p>
    </div>

    <p v-if="store.error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ store.error }}</p>

    <div v-if="sim.available !== false" data-testid="sim-section">
      <button
        type="button"
        class="flex items-center gap-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
        :aria-expanded="simOpen"
        data-testid="sim-disclosure"
        @click="simChoice = !simOpen"
      >
        <span aria-hidden="true">{{ simOpen ? '▾' : '▸' }}</span>
        Simulation controls
      </button>
      <div v-show="simOpen" class="mt-2" data-testid="sim-body"><SimControls /></div>
    </div>

    <FleetMap :locations="store.mapLocations" :marker-color="markerColor" />

    <div class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3" data-testid="supply-filters">
      <div class="flex flex-wrap gap-1">
        <button
          v-for="s in STATUS_OPTIONS"
          :key="s"
          type="button"
          class="rounded-full border px-2.5 py-1 text-xs font-semibold"
          :class="store.filters.statuses.includes(s) ? 'border-brand bg-brand/10 text-brand-ink' : 'border-line text-ink-2 hover:bg-surface-2'"
          :data-testid="`filter-status-${s}`"
          @click="toggleStatus(s)"
        >
          {{ statusLabel(s) }}
        </button>
      </div>

      <select
        data-testid="filter-equipment"
        aria-label="Filter by equipment"
        class="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink"
        @change="onEquipmentChange"
      >
        <option value="">All equipment</option>
        <option v-for="e in store.filterOptions.equipment" :key="e" :value="e">{{ e }}</option>
      </select>

      <select
        data-testid="filter-language"
        aria-label="Filter by language"
        class="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink"
        @change="onLanguageChange"
      >
        <option value="">All languages</option>
        <option v-for="l in store.filterOptions.languages" :key="l" :value="l">{{ l }}</option>
      </select>

      <select
        data-testid="filter-state"
        aria-label="Filter by home base state"
        class="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink"
        @change="onStateChange"
      >
        <option value="">All states</option>
        <option v-for="s in store.filterOptions.states" :key="s" :value="s">{{ s }}</option>
      </select>

      <label class="flex items-center gap-1.5 text-xs text-ink-2">
        <input type="checkbox" data-testid="filter-accepting-only" @change="onAcceptingOnlyChange" />
        Accepting loads only
      </label>
    </div>

    <div class="overflow-x-auto rounded-lg border border-line bg-surface">
      <table class="min-w-full divide-y divide-line text-sm" data-testid="supply-table">
        <thead class="bg-surface-2 text-xs uppercase tracking-wide text-ink-3">
          <tr>
            <th class="px-3 py-2 text-left font-medium">Name</th>
            <th class="px-3 py-2 text-left font-medium">Status</th>
            <th class="px-3 py-2 text-left font-medium">Current</th>
            <th class="px-3 py-2 text-left font-medium">Current load</th>
            <th class="px-3 py-2 text-left font-medium">Delivery ETA</th>
            <th class="px-3 py-2 text-left font-medium">Projected availability</th>
            <th class="px-3 py-2 text-left font-medium">HOS</th>
            <th class="px-3 py-2 text-left font-medium">Equipment</th>
            <th class="px-3 py-2 text-left font-medium">Languages</th>
            <th class="px-3 py-2 text-left font-medium">Home base</th>
          </tr>
        </thead>
        <tbody v-if="store.rows.length > 0" class="divide-y divide-line">
          <DriverSupplyRow
            v-for="driver in store.rows"
            :key="driver.driverId"
            :driver="driver"
            :tz="tz"
            @select="store.select($event)"
          />
        </tbody>
      </table>
      <div v-if="store.drivers.length === 0" class="p-6 text-center text-sm text-ink-3" data-testid="supply-empty">
        No drivers yet — add drivers to see them here.
      </div>
      <div v-else-if="store.rows.length === 0" class="p-6 text-center text-sm text-ink-3" data-testid="supply-empty">
        No drivers match these filters.
      </div>
    </div>

    <DriverDrawer />
  </div>
</template>
