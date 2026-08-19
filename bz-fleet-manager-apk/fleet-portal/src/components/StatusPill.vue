<script setup lang="ts">
// Small status badge shared by the trips board, trip detail, and approvals
// screens. Maps a raw status string (e.g. "in_progress") to a color and a
// human-readable label ("In Progress").
const props = defineProps<{ status: string }>()

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  assigned: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-blue-600 text-white',
  completed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-800',
  cancelled: 'bg-red-100 text-red-800',
}

const DEFAULT_STYLE = 'bg-gray-100 text-gray-700'

function formatLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
</script>

<template>
  <span
    class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
    :class="STATUS_STYLES[props.status] ?? DEFAULT_STYLE"
  >
    {{ formatLabel(props.status) }}
  </span>
</template>
