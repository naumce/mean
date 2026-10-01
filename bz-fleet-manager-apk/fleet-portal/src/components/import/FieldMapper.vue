<script setup lang="ts">
import { computed } from 'vue'
import type { ColumnMapping } from '../../lib/importMapping'
import { FIELD_CATALOG, missingRequired } from '../../lib/importMapping'
import type { ImportEntity } from '../../stores/importer'

// One row per CSV column: their header + a sample value on the left, a select
// of our fields on the right. Pre-filled by autoMap; the dispatcher confirms.
const props = defineProps<{
  entity: ImportEntity
  headers: string[]
  samples: string[]
  mapping: ColumnMapping
}>()

const emit = defineEmits<{ (e: 'update', mapping: ColumnMapping): void }>()

const fields = computed(() => FIELD_CATALOG[props.entity])
const missing = computed(() => missingRequired(props.mapping, props.entity))

function onPick(columnIndex: number, value: string): void {
  const next = props.mapping.map((current, i) => {
    if (i === columnIndex) return value === '' ? null : value
    // A field can back only one column — picking it here releases it elsewhere.
    if (value !== '' && current === value) return null
    return current
  })
  emit('update', next)
}
</script>

<template>
  <div class="rounded-lg border border-line" data-testid="field-mapper">
    <div class="border-b border-line bg-surface-2 px-4 py-2 text-sm font-medium text-ink-2">
      Map your columns
    </div>

    <div class="divide-y divide-line">
      <div
        v-for="(header, i) in headers"
        :key="`${i}-${header}`"
        class="flex items-center gap-4 px-4 py-2"
        :data-map-row="i"
      >
        <div class="w-1/2 min-w-0">
          <p class="truncate text-sm font-medium text-ink">{{ header }}</p>
          <p class="truncate text-xs text-ink-3">e.g. {{ samples[i] || '—' }}</p>
        </div>
        <select
          class="w-1/2 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
          :value="mapping[i] ?? ''"
          :data-map-select="i"
          @change="onPick(i, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">— ignore —</option>
          <option v-for="f in fields" :key="f.key" :value="f.key">
            {{ f.label }}{{ f.required ? ' *' : '' }}
          </option>
        </select>
      </div>
    </div>

    <p
      v-if="missing.length"
      class="border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
      data-testid="missing-required"
    >
      Still unmapped (required): {{ missing.map((f) => f.label).join(', ') }}
    </p>
  </div>
</template>
