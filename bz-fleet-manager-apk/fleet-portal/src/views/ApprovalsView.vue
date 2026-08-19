<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppButton from '../components/AppButton.vue'
import DataTable from '../components/DataTable.vue'
import FormField from '../components/FormField.vue'
import Modal from '../components/Modal.vue'
import StatusPill from '../components/StatusPill.vue'
import { useApprovalsStore } from '../stores/approvals'
import type { SignsProof, Trip } from '../types/dispatcher'

const approvalsStore = useApprovalsStore()

const tripColumns = [
  { key: 'identifier', label: 'Trip' },
  { key: 'stops', label: 'Stops' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: '' },
]

async function handleApproveTrip(trip: Trip): Promise<void> {
  try {
    await approvalsStore.approveTrip(trip.id)
  } catch {
    // approvalsStore.error already reflects the failure; surfaced via the banner below.
  }
}

async function handleApproveProof(proof: SignsProof): Promise<void> {
  try {
    await approvalsStore.approveProof(proof.id)
  } catch {
    // approvalsStore.error already reflects the failure; surfaced via the banner below.
  }
}

// --- Reject reason modal, shared between trips and signs-proof ---

type RejectTarget = { kind: 'trip' | 'proof'; id: string; label: string }

const isRejectModalOpen = ref(false)
const rejectTarget = ref<RejectTarget | null>(null)
const rejectReason = ref('')
const isRejecting = ref(false)
const rejectError = ref<string | null>(null)

function openRejectModal(target: RejectTarget): void {
  rejectTarget.value = target
  rejectReason.value = ''
  rejectError.value = null
  isRejectModalOpen.value = true
}

async function handleRejectSubmit(): Promise<void> {
  if (!rejectTarget.value) return
  isRejecting.value = true
  rejectError.value = null
  try {
    if (rejectTarget.value.kind === 'trip') {
      await approvalsStore.rejectTrip(rejectTarget.value.id, rejectReason.value)
    } else {
      await approvalsStore.rejectProof(rejectTarget.value.id, rejectReason.value)
    }
    isRejectModalOpen.value = false
  } catch {
    rejectError.value = approvalsStore.error
  } finally {
    isRejecting.value = false
  }
}

onMounted(() => {
  approvalsStore.listTrips()
  approvalsStore.listSignsProof()
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Approvals</h1>
      <p class="text-sm text-gray-500">Review trips and driver-submitted signs-proof awaiting your decision.</p>
    </div>

    <p v-if="approvalsStore.error" class="text-sm text-red-600" role="alert">
      {{ approvalsStore.error }}
    </p>

    <div class="flex flex-col gap-2">
      <h2 class="text-sm font-semibold text-gray-700">Trips awaiting approval</h2>
      <DataTable :columns="tripColumns" :rows="approvalsStore.pendingTrips" row-key="id">
        <template #cell-stops="{ row }">{{ (row as Trip).stops.length }}</template>
        <template #cell-status="{ row }">
          <StatusPill :status="(row as Trip).status" />
        </template>
        <template #cell-actions="{ row }">
          <div class="flex gap-3">
            <button
              type="button"
              class="text-sm font-medium text-primary-600 hover:text-primary-700"
              @click="handleApproveTrip(row as Trip)"
            >
              Approve
            </button>
            <button
              type="button"
              class="text-sm font-medium text-red-600 hover:text-red-700"
              @click="openRejectModal({ kind: 'trip', id: (row as Trip).id, label: (row as Trip).identifier })"
            >
              Reject
            </button>
          </div>
        </template>
        <template #empty>No trips are awaiting approval.</template>
      </DataTable>
    </div>

    <div class="flex flex-col gap-2">
      <h2 class="text-sm font-semibold text-gray-700">Signs-proof pending</h2>
      <div v-if="approvalsStore.pendingProofs.length === 0" class="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No signs-proof is awaiting approval.
      </div>
      <ul v-else class="flex flex-col gap-2">
        <li
          v-for="proof in approvalsStore.pendingProofs"
          :key="proof.id"
          class="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4"
        >
          <div class="flex flex-col gap-1 text-sm">
            <span class="font-medium text-gray-900">{{ proof.proofType }}</span>
            <span class="text-gray-500">Trip {{ proof.tripId }}<template v-if="proof.stopId"> · Stop {{ proof.stopId }}</template></span>
            <a :href="proof.fileUrl" target="_blank" rel="noopener noreferrer" class="text-primary-600 hover:text-primary-700">
              View proof
            </a>
          </div>
          <div class="flex gap-3">
            <button
              type="button"
              class="text-sm font-medium text-primary-600 hover:text-primary-700"
              @click="handleApproveProof(proof)"
            >
              Approve
            </button>
            <button
              type="button"
              class="text-sm font-medium text-red-600 hover:text-red-700"
              @click="openRejectModal({ kind: 'proof', id: proof.id, label: proof.proofType })"
            >
              Reject
            </button>
          </div>
        </li>
      </ul>
    </div>

    <Modal v-model:open="isRejectModalOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-gray-900">Reject {{ rejectTarget?.label }}</h2>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="handleRejectSubmit">
        <FormField id="reject-reason" label="Reason">
          <textarea
            id="reject-reason"
            v-model="rejectReason"
            required
            rows="3"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </FormField>

        <p v-if="rejectError" class="text-sm text-red-600" role="alert">{{ rejectError }}</p>

        <div class="mt-2 flex justify-end gap-2">
          <AppButton type="button" variant="ghost" @click="isRejectModalOpen = false">Cancel</AppButton>
          <AppButton type="submit" variant="danger" :loading="isRejecting">Reject</AppButton>
        </div>
      </form>
    </Modal>
  </div>
</template>
