<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import AppButton from '../components/AppButton.vue'
import DataTable from '../components/DataTable.vue'
import FormField from '../components/FormField.vue'
import Modal from '../components/Modal.vue'
import StatusPill from '../components/StatusPill.vue'
import { useDriversStore } from '../stores/drivers'
import { useTripsStore } from '../stores/trips'
import type { Trip } from '../types/dispatcher'

const tripsStore = useTripsStore()
const driversStore = useDriversStore()

// The board is organized into a fixed set of status columns rather than
// whatever statuses happen to be present in the data, so the layout stays
// stable as trips move through the workflow.
const STATUS_COLUMNS = ['pending', 'assigned', 'in_progress', 'completed'] as const

const columns = [
  { key: 'identifier', label: 'Trip' },
  { key: 'driverId', label: 'Driver' },
  { key: 'stops', label: 'Stops' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: '' },
]

function formatStatusLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function driverName(driverId: string | null): string {
  if (!driverId) return 'Unassigned'
  const driver = driversStore.items.find((candidate) => candidate.id === driverId)
  return driver?.name ?? 'Unassigned'
}

const statusFilter = ref('')

const groupedTrips = computed(() =>
  STATUS_COLUMNS.map((status) => ({
    status,
    trips: tripsStore.items.filter((trip) => trip.status === status),
  })),
)

async function handleStatusFilterChange(): Promise<void> {
  await tripsStore.list(statusFilter.value ? { status: statusFilter.value } : undefined)
}

// --- Create trip modal ---

const isCreateModalOpen = ref(false)
const isSubmitting = ref(false)
const formError = ref<string | null>(null)

const form = reactive({ identifier: '' })
const stopRows = ref<{ sequence: number; address: string }[]>([{ sequence: 1, address: '' }])
const checklistRows = ref<{ label: string; required: boolean }[]>([])

function resetCreateForm(): void {
  form.identifier = ''
  stopRows.value = [{ sequence: 1, address: '' }]
  checklistRows.value = []
  formError.value = null
}

function openCreateModal(): void {
  resetCreateForm()
  isCreateModalOpen.value = true
}

function addStopRow(): void {
  stopRows.value.push({ sequence: stopRows.value.length + 1, address: '' })
}

function removeStopRow(index: number): void {
  if (stopRows.value.length <= 1) return
  stopRows.value.splice(index, 1)
}

function addChecklistRow(): void {
  checklistRows.value.push({ label: '', required: false })
}

function removeChecklistRow(index: number): void {
  checklistRows.value.splice(index, 1)
}

async function handleCreateSubmit(): Promise<void> {
  isSubmitting.value = true
  formError.value = null
  try {
    const checklistItems = checklistRows.value
      .filter((row) => row.label.trim() !== '')
      .map((row) => ({ label: row.label, required: row.required }))

    await tripsStore.create({
      identifier: form.identifier,
      stops: stopRows.value.map((row) => ({ sequence: Number(row.sequence), address: row.address })),
      ...(checklistItems.length > 0 ? { checklistItems } : {}),
    })
    isCreateModalOpen.value = false
  } catch {
    formError.value = tripsStore.error
  } finally {
    isSubmitting.value = false
  }
}

// --- Assign modal ---

const isAssignModalOpen = ref(false)
const assigningTrip = ref<Trip | null>(null)
const selectedDriverId = ref('')
const isAssigning = ref(false)
const assignError = ref<string | null>(null)

function openAssignModal(trip: Trip): void {
  assigningTrip.value = trip
  selectedDriverId.value = trip.driverId ?? ''
  assignError.value = null
  isAssignModalOpen.value = true
  if (driversStore.items.length === 0) {
    driversStore.list()
  }
}

async function handleAssignSubmit(): Promise<void> {
  if (!assigningTrip.value || !selectedDriverId.value) return
  isAssigning.value = true
  assignError.value = null
  try {
    await tripsStore.assign(assigningTrip.value.id, selectedDriverId.value)
    isAssignModalOpen.value = false
  } catch {
    assignError.value = tripsStore.error
  } finally {
    isAssigning.value = false
  }
}

onMounted(() => {
  tripsStore.list()
  driversStore.list()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-gray-900">Trips</h1>
        <p class="text-sm text-gray-500">Dispatch and track trips across your fleet.</p>
      </div>
      <div class="flex items-center gap-3">
        <select
          v-model="statusFilter"
          class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          @change="handleStatusFilterChange"
        >
          <option value="">All statuses</option>
          <option v-for="status in STATUS_COLUMNS" :key="status" :value="status">
            {{ formatStatusLabel(status) }}
          </option>
        </select>
        <AppButton type="button" @click="openCreateModal">Create trip</AppButton>
      </div>
    </div>

    <p v-if="tripsStore.error" class="text-sm text-red-600" role="alert">
      {{ tripsStore.error }}
    </p>

    <div v-for="group in groupedTrips" :key="group.status" class="flex flex-col gap-2" :data-status-group="group.status">
      <h2 class="text-sm font-semibold text-gray-700">{{ formatStatusLabel(group.status) }}</h2>
      <DataTable :columns="columns" :rows="group.trips" row-key="id">
        <template #cell-identifier="{ row }">
          <RouterLink
            :to="{ name: 'trip-detail', params: { id: (row as Trip).id } }"
            class="font-medium text-primary-600 hover:text-primary-700"
          >
            {{ (row as Trip).identifier }}
          </RouterLink>
        </template>
        <template #cell-driverId="{ row }">{{ driverName((row as Trip).driverId) }}</template>
        <template #cell-stops="{ row }">{{ (row as Trip).stops?.length ?? 0 }}</template>
        <template #cell-status="{ row }">
          <StatusPill :status="(row as Trip).status" />
        </template>
        <template #cell-actions="{ row }">
          <button
            type="button"
            class="text-sm font-medium text-primary-600 hover:text-primary-700"
            @click="openAssignModal(row as Trip)"
          >
            Assign
          </button>
        </template>
        <template #empty>No {{ formatStatusLabel(group.status).toLowerCase() }} trips.</template>
      </DataTable>
    </div>

    <Modal v-model:open="isCreateModalOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-gray-900">Create trip</h2>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="handleCreateSubmit">
        <FormField id="trip-identifier" label="Identifier">
          <input
            id="trip-identifier"
            v-model="form.identifier"
            type="text"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-gray-700">Stops</span>
            <button type="button" class="text-sm font-medium text-primary-600 hover:text-primary-700" @click="addStopRow">
              Add stop
            </button>
          </div>
          <div
            v-for="(stop, index) in stopRows"
            :key="index"
            data-stop-row
            class="flex items-end gap-2"
          >
            <FormField :id="`trip-stop-sequence-${index}`" label="Seq" class="w-16">
              <input
                :id="`trip-stop-sequence-${index}`"
                v-model.number="stop.sequence"
                type="number"
                min="1"
                required
                class="w-16 rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
              />
            </FormField>
            <FormField :id="`trip-stop-address-${index}`" label="Address" class="flex-1">
              <input
                :id="`trip-stop-address-${index}`"
                v-model="stop.address"
                type="text"
                required
                class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
              />
            </FormField>
            <button
              type="button"
              class="mb-2 text-sm font-medium text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="stopRows.length <= 1"
              @click="removeStopRow(index)"
            >
              Remove
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-gray-700">Checklist items (optional)</span>
            <button
              type="button"
              class="text-sm font-medium text-primary-600 hover:text-primary-700"
              @click="addChecklistRow"
            >
              Add checklist item
            </button>
          </div>
          <div
            v-for="(item, index) in checklistRows"
            :key="index"
            data-checklist-row
            class="flex items-center gap-2"
          >
            <input
              :id="`trip-checklist-label-${index}`"
              v-model="item.label"
              type="text"
              placeholder="Label"
              class="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
            />
            <label class="flex items-center gap-1 text-sm text-gray-700">
              <input :id="`trip-checklist-required-${index}`" v-model="item.required" type="checkbox" />
              Required
            </label>
            <button
              type="button"
              class="text-sm font-medium text-red-600 hover:text-red-700"
              @click="removeChecklistRow(index)"
            >
              Remove
            </button>
          </div>
        </div>

        <p v-if="formError" class="text-sm text-red-600" role="alert">{{ formError }}</p>

        <div class="mt-2 flex justify-end gap-2">
          <AppButton type="button" variant="ghost" @click="isCreateModalOpen = false">Cancel</AppButton>
          <AppButton type="submit" :loading="isSubmitting">Create trip</AppButton>
        </div>
      </form>
    </Modal>

    <Modal v-model:open="isAssignModalOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-gray-900">
          Assign driver — {{ assigningTrip?.identifier }}
        </h2>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="handleAssignSubmit">
        <FormField id="trip-driver" label="Driver">
          <select
            id="trip-driver"
            v-model="selectedDriverId"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          >
            <option value="" disabled>Select a driver</option>
            <option v-for="driver in driversStore.items" :key="driver.id" :value="driver.id">
              {{ driver.name }}
            </option>
          </select>
        </FormField>

        <p v-if="assignError" class="text-sm text-red-600" role="alert">{{ assignError }}</p>

        <div class="mt-2 flex justify-end gap-2">
          <AppButton type="button" variant="ghost" @click="isAssignModalOpen = false">Cancel</AppButton>
          <AppButton type="submit" :loading="isAssigning">Assign</AppButton>
        </div>
      </form>
    </Modal>
  </div>
</template>
