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
  <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
    <table class="min-w-full divide-y divide-gray-200 text-sm">
      <thead class="sticky top-0 bg-gray-50">
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            class="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody v-if="rows.length > 0" class="divide-y divide-gray-100">
        <tr
          v-for="(row, index) in rows"
          :key="rowKey ? String(row[rowKey]) : index"
          :class="index % 2 === 1 ? 'bg-gray-50' : 'bg-white'"
        >
          <td v-for="column in columns" :key="column.key" class="px-4 py-2 text-gray-700">
            <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">
              {{ row[column.key] }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="rows.length === 0" class="p-6 text-center text-sm text-gray-500">
      <slot name="empty">No data yet.</slot>
    </div>
  </div>
</template>
