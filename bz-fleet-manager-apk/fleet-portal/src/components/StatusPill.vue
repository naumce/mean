<script setup lang="ts">
// Small status badge shared by the trips board, trip detail, and approvals
// screens. Maps a raw status string (e.g. "in_progress") to a color and a
// human-readable label ("In Progress").
const props = defineProps<{ status: string }>()

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  assigned: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  in_progress: 'bg-blue-600 text-white',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
}

const DEFAULT_STYLE = 'bg-surface-3 text-ink-2'

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
