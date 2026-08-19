<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import AppButton from '../components/AppButton.vue'
import DataTable from '../components/DataTable.vue'
import FormField from '../components/FormField.vue'
import Modal from '../components/Modal.vue'
import { useDriversStore } from '../stores/drivers'
import { useVehiclesStore } from '../stores/vehicles'
import type { Vehicle } from '../types/fleet'

const vehiclesStore = useVehiclesStore()
const driversStore = useDriversStore()

const columns = [
  { key: 'plate', label: 'Plate' },
  { key: 'model', label: 'Model' },
  { key: 'driverId', label: 'Assigned driver' },
  { key: 'actions', label: '' },
]

function driverName(driverId: string | null): string {
  if (!driverId) return 'Unassigned'
  const driver = driversStore.items.find((candidate) => candidate.id === driverId)
  return driver?.name ?? 'Unassigned'
}

// --- Create / edit modal ---

const isFormModalOpen = ref(false)
const editingVehicle = ref<Vehicle | null>(null)
const isSubmitting = ref(false)
const formError = ref<string | null>(null)

const form = reactive({
  plate: '',
  model: '',
})

const formModalTitle = computed(() => (editingVehicle.value ? 'Edit vehicle' : 'Add vehicle'))

function resetForm(): void {
  form.plate = ''
  form.model = ''
  formError.value = null
}

function openCreateModal(): void {
  editingVehicle.value = null
  resetForm()
  isFormModalOpen.value = true
}

function openEditModal(vehicle: Vehicle): void {
  editingVehicle.value = vehicle
  form.plate = vehicle.plate
  form.model = vehicle.model ?? ''
  formError.value = null
  isFormModalOpen.value = true
}

async function handleFormSubmit(): Promise<void> {
  isSubmitting.value = true
  formError.value = null
  try {
    if (editingVehicle.value) {
      await vehiclesStore.update(editingVehicle.value.id, {
        plate: form.plate,
        model: form.model || undefined,
      })
    } else {
      await vehiclesStore.create({
        plate: form.plate,
        model: form.model || undefined,
      })
    }
    isFormModalOpen.value = false
  } catch {
    formError.value = vehiclesStore.error
  } finally {
    isSubmitting.value = false
  }
}

// --- Assign modal ---

const isAssignModalOpen = ref(false)
const assigningVehicle = ref<Vehicle | null>(null)
const selectedDriverId = ref('')
const isAssigning = ref(false)
const assignError = ref<string | null>(null)

function openAssignModal(vehicle: Vehicle): void {
  assigningVehicle.value = vehicle
  selectedDriverId.value = vehicle.driverId ?? ''
  assignError.value = null
  isAssignModalOpen.value = true
  if (driversStore.items.length === 0) {
    driversStore.list()
  }
}

async function handleAssignSubmit(): Promise<void> {
  if (!assigningVehicle.value || !selectedDriverId.value) return
  isAssigning.value = true
  assignError.value = null
  try {
    await vehiclesStore.assign(assigningVehicle.value.id, selectedDriverId.value)
    isAssignModalOpen.value = false
  } catch {
    assignError.value = vehiclesStore.error
  } finally {
    isAssigning.value = false
  }
}

onMounted(() => {
  vehiclesStore.list()
  driversStore.list()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-gray-900">Vehicles</h1>
        <p class="text-sm text-gray-500">Manage the vehicles in your fleet.</p>
      </div>
      <AppButton type="button" @click="openCreateModal">Add vehicle</AppButton>
    </div>

    <p v-if="vehiclesStore.error" class="text-sm text-red-600" role="alert">
      {{ vehiclesStore.error }}
    </p>

    <DataTable :columns="columns" :rows="vehiclesStore.items" row-key="id">
      <template #cell-model="{ value }">{{ value || '—' }}</template>
      <template #cell-driverId="{ row }">{{ driverName((row as Vehicle).driverId) }}</template>
      <template #cell-actions="{ row }">
        <div class="flex gap-3">
          <button
            type="button"
            class="text-sm font-medium text-primary-600 hover:text-primary-700"
            @click="openEditModal(row as Vehicle)"
          >
            Edit
          </button>
          <button
            type="button"
            class="text-sm font-medium text-primary-600 hover:text-primary-700"
            @click="openAssignModal(row as Vehicle)"
          >
            Assign
          </button>
        </div>
      </template>
      <template #empty>No vehicles yet — add your first vehicle to get started.</template>
    </DataTable>

    <Modal v-model:open="isFormModalOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-gray-900">{{ formModalTitle }}</h2>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="handleFormSubmit">
        <FormField id="vehicle-plate" label="Plate">
          <input
            id="vehicle-plate"
            v-model="form.plate"
            type="text"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>
        <FormField id="vehicle-model" label="Model">
          <input
            id="vehicle-model"
            v-model="form.model"
            type="text"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>

        <p v-if="formError" class="text-sm text-red-600" role="alert">{{ formError }}</p>

        <div class="mt-2 flex justify-end gap-2">
          <AppButton type="button" variant="ghost" @click="isFormModalOpen = false">Cancel</AppButton>
          <AppButton type="submit" :loading="isSubmitting">{{ editingVehicle ? 'Save' : 'Create vehicle' }}</AppButton>
        </div>
      </form>
    </Modal>

    <Modal v-model:open="isAssignModalOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-gray-900">
          Assign driver — {{ assigningVehicle?.plate }}
        </h2>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="handleAssignSubmit">
        <FormField id="vehicle-driver" label="Driver">
          <select
            id="vehicle-driver"
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
