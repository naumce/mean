<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import AppButton from '../components/AppButton.vue'
import DataTable from '../components/DataTable.vue'
import FormField from '../components/FormField.vue'
import Modal from '../components/Modal.vue'
import { useDriversStore } from '../stores/drivers'
import type { Driver } from '../types/fleet'

const driversStore = useDriversStore()

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: '' },
]

const isModalOpen = ref(false)
const editingDriver = ref<Driver | null>(null)
const isSubmitting = ref(false)
const formError = ref<string | null>(null)

const form = reactive({
  name: '',
  email: '',
  phone: '',
  password: '',
})

const modalTitle = computed(() => (editingDriver.value ? 'Edit driver' : 'Add driver'))

function resetForm(): void {
  form.name = ''
  form.email = ''
  form.phone = ''
  form.password = ''
  formError.value = null
}

function openCreateModal(): void {
  editingDriver.value = null
  resetForm()
  isModalOpen.value = true
}

function openEditModal(driver: Driver): void {
  editingDriver.value = driver
  form.name = driver.name
  form.email = driver.email
  form.phone = driver.phone ?? ''
  form.password = ''
  formError.value = null
  isModalOpen.value = true
}

async function handleSubmit(): Promise<void> {
  isSubmitting.value = true
  formError.value = null
  try {
    if (editingDriver.value) {
      await driversStore.update(editingDriver.value.id, {
        name: form.name,
        phone: form.phone || undefined,
      })
    } else {
      await driversStore.create({
        name: form.name,
        email: form.email,
        phone: form.phone || undefined,
        password: form.password,
      })
    }
    isModalOpen.value = false
  } catch {
    formError.value = driversStore.error
  } finally {
    isSubmitting.value = false
  }
}

onMounted(() => {
  driversStore.list()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-gray-900">Drivers</h1>
        <p class="text-sm text-gray-500">Manage the drivers in your fleet.</p>
      </div>
      <AppButton type="button" @click="openCreateModal">Add driver</AppButton>
    </div>

    <p v-if="driversStore.error" class="text-sm text-red-600" role="alert">
      {{ driversStore.error }}
    </p>

    <DataTable :columns="columns" :rows="driversStore.items" row-key="id">
      <template #cell-phone="{ value }">{{ value || '—' }}</template>
      <template #cell-actions="{ row }">
        <button
          type="button"
          class="text-sm font-medium text-primary-600 hover:text-primary-700"
          @click="openEditModal(row as Driver)"
        >
          Edit
        </button>
      </template>
      <template #empty>No drivers yet — add your first driver to get started.</template>
    </DataTable>

    <Modal v-model:open="isModalOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-gray-900">{{ modalTitle }}</h2>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
        <FormField id="driver-name" label="Name">
          <input
            id="driver-name"
            v-model="form.name"
            type="text"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>
        <FormField id="driver-email" label="Email">
          <input
            id="driver-email"
            v-model="form.email"
            type="email"
            required
            :disabled="!!editingDriver"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600 disabled:bg-gray-100 disabled:text-gray-500"
          />
        </FormField>
        <FormField id="driver-phone" label="Phone">
          <input
            id="driver-phone"
            v-model="form.phone"
            type="tel"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>
        <FormField v-if="!editingDriver" id="driver-password" label="Password">
          <input
            id="driver-password"
            v-model="form.password"
            type="password"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>

        <p v-if="formError" class="text-sm text-red-600" role="alert">{{ formError }}</p>

        <div class="mt-2 flex justify-end gap-2">
          <AppButton type="button" variant="ghost" @click="isModalOpen = false">Cancel</AppButton>
          <AppButton type="submit" :loading="isSubmitting">{{ editingDriver ? 'Save' : 'Create driver' }}</AppButton>
        </div>
      </form>
    </Modal>
  </div>
</template>
