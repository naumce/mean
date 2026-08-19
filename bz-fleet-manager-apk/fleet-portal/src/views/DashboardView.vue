<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { OverviewCounts } from '../types/dispatcher'

const counts = ref<OverviewCounts | null>(null)
const errorMessage = ref<string | null>(null)
const isLoading = ref(true)

function formatStatusLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

async function loadOverview(): Promise<void> {
  isLoading.value = true
  errorMessage.value = null
  try {
    const { data } = await api.get<OverviewCounts>('/dispatcher/overview')
    counts.value = data
  } catch (error) {
    errorMessage.value = extractApiErrorMessage(error, 'Unable to load the trip overview right now.')
  } finally {
    isLoading.value = false
  }
}

onMounted(loadOverview)
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Dashboard</h1>
      <p class="text-sm text-gray-500">Trip status at a glance.</p>
    </div>

    <div v-if="isLoading" class="text-sm text-gray-500">Loading overview…</div>

    <div v-else-if="errorMessage" class="rounded-lg border border-gray-200 bg-white p-6 text-center">
      <p class="text-sm text-gray-600">{{ errorMessage }}</p>
      <button
        type="button"
        class="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
        @click="loadOverview"
      >
        Retry
      </button>
    </div>

    <div v-else-if="counts && Object.keys(counts).length > 0" class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      <div
        v-for="(count, status) in counts"
        :key="status"
        class="rounded-lg border border-gray-200 bg-white p-4"
      >
        <p class="text-sm font-medium text-gray-500">{{ formatStatusLabel(status) }}</p>
        <p class="mt-1 text-2xl font-semibold text-gray-900">{{ count }}</p>
      </div>
    </div>

    <div v-else class="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
      No trips yet — status counts will appear here once trips are created.
    </div>
  </div>
</template>
