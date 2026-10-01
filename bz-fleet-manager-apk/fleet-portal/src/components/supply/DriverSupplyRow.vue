<script setup lang="ts">
import { computed } from 'vue'
import { fmtDT } from '../../lib/cockpit/format'
import {
  currentLabel,
  driveRemainingLabel,
  driverLanguages,
  isHosStale,
  projectedAvailabilityLabel,
  STATUS_CHIP_CLASS,
  statusLabel,
} from '../../lib/supplyFormat'
import type { SupplyDriver } from '../../types/supply'

// One <tr> per driver on the Driver Supply table (views/DriverSupplyView.vue)
// — split out per the brief so the view's own template stays a plain
// <table>/<thead>/<tbody> shell. Purely presentational: no store access, no
// fetching: the parent owns selection via the `select` emit.
const props = defineProps<{ driver: SupplyDriver; tz: string }>()
const emit = defineEmits<{ select: [driverId: string] }>()

function select(): void {
  emit('select', props.driver.driverId)
}

const whenLabel = (ms: number): string => fmtDT(ms, props.tz)

const currentText = computed(() => currentLabel(props.driver.current, Date.now()))

const currentLoadText = computed(() => {
  const a = props.driver.currentAssignment
  if (!a) return '—'
  return a.deliveryCity ? `${a.loadRef} → ${a.deliveryCity}` : a.loadRef
})

const deliveryEtaText = computed(() => {
  const a = props.driver.currentAssignment
  return a ? fmtDT(a.deliveryEtaMs, props.tz) : '—'
})

const projectedText = computed(() =>
  projectedAvailabilityLabel(props.driver.available, props.driver.availableAt, Date.now(), whenLabel),
)

const hos = computed(() => props.driver.hos)
const hosStale = computed(() => (hos.value ? isHosStale(hos.value.updatedAt, Date.now()) : false))

const languages = computed(() => driverLanguages(props.driver).join(', '))

const homeBaseText = computed(() => {
  const { homeBaseCity, homeBaseState } = props.driver
  if (!homeBaseCity && !homeBaseState) return '—'
  return [homeBaseCity, homeBaseState].filter(Boolean).join(', ')
})
</script>

<template>
  <tr
    class="cursor-pointer hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    data-testid="driver-row"
    :data-driver-id="driver.driverId"
    tabindex="0"
    role="button"
    :aria-label="`Open ${driver.name}`"
    @click="select"
    @keydown.enter="select"
    @keydown.space.prevent="select"
  >
    <td class="px-3 py-2 font-medium text-ink" data-col="name">{{ driver.name }}</td>

    <td class="px-3 py-2" data-col="status">
      <span
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
        :class="STATUS_CHIP_CLASS[driver.status]"
        :data-status="driver.status"
      >
        {{ statusLabel(driver.status) }}
      </span>
    </td>

    <td class="px-3 py-2 text-ink-2" data-col="current">{{ currentText }}</td>

    <td class="px-3 py-2 text-ink-2" data-col="current-load">{{ currentLoadText }}</td>

    <td class="px-3 py-2 text-ink-2" data-col="delivery-eta">{{ deliveryEtaText }}</td>

    <td class="px-3 py-2 text-ink-2" data-col="projected-availability">{{ projectedText }}</td>

    <td class="px-3 py-2" data-col="hos">
      <template v-if="hos">
        <span class="text-ink-2">{{ driveRemainingLabel(hos.driveRemainingMin) }}</span>
        <span
          v-if="hosStale"
          class="ml-1.5 rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
          data-testid="hos-stale-chip"
        >
          stale
        </span>
      </template>
      <span v-else class="text-ink-3">not imported</span>
    </td>

    <td class="px-3 py-2" data-col="equipment">
      <span v-if="driver.equipmentTypes.length === 0" class="text-ink-3">—</span>
      <span v-else class="flex flex-wrap gap-1">
        <span
          v-for="e in driver.equipmentTypes"
          :key="e"
          class="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2"
        >
          {{ e }}
        </span>
      </span>
    </td>

    <td class="px-3 py-2 text-ink-2" data-col="languages">{{ languages }}</td>

    <td class="px-3 py-2 text-ink-2" data-col="home-base">{{ homeBaseText }}</td>
  </tr>
</template>
