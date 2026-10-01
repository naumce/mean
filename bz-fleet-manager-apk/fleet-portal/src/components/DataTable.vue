<script setup lang="ts" generic="T extends Record<string, unknown>">
// Generic, prop-driven table used across the fleet screens. Consumers
// customize individual cells via scoped slots named `cell-<column.key>`
// (falling back to the raw value) and can override the empty state via the
// `empty` slot.
defineProps<{
  columns: { key: string; label: string }[]
  rows: T[]
  rowKey?: keyof T
}>()
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-line bg-surface">
    <table class="min-w-full divide-y divide-line text-sm">
      <thead class="sticky top-0 bg-surface-2">
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            class="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-3"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody v-if="rows.length > 0" class="divide-y divide-line">
        <tr
          v-for="(row, index) in rows"
          :key="rowKey ? String(row[rowKey]) : index"
          :class="index % 2 === 1 ? 'bg-surface-2' : 'bg-surface'"
        >
          <td v-for="column in columns" :key="column.key" class="px-4 py-2 text-ink-2">
            <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">
              {{ row[column.key] }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="rows.length === 0" class="p-6 text-center text-sm text-ink-3">
      <slot name="empty">No data yet.</slot>
    </div>
  </div>
</template>
