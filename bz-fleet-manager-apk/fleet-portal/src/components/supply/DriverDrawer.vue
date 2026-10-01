<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDriverSupplyStore } from '../../stores/driverSupply'
import { useSimStore } from '../../stores/sim'
import { driverLanguages, STATUS_CHIP_CLASS, statusLabel } from '../../lib/supplyFormat'
import DriverAvailabilityControls from './DriverAvailabilityControls.vue'
import DriverEvidencePanel from './DriverEvidencePanel.vue'
import DriverHistoryList from './DriverHistoryList.vue'
import DriverPreferencesForm from './DriverPreferencesForm.vue'
import DriverSimulationControls from './DriverSimulationControls.vue'

// Driver Supply's detail drawer — mirrors components/agent/AgentDrawer.vue's
// open/close contract (§6 of the portal inspection): always mounted by the
// view, visibility driven purely by an id being non-null. The id here is
// driverSupply.ts's OWN `selectedDriverId` state rather than a prop, because
// (unlike AgentDrawer, mounted independently by two different boards with
// two different local id refs) there is exactly one Driver Supply store and
// one view — reading it directly avoids prop-drilling the id and the
// selected row through the view for no benefit.
const store = useDriverSupplyStore()
const sim = useSimStore()

const open = computed(() => store.selectedDriverId !== null)
const driver = computed(() => store.drivers.find((d) => d.driverId === store.selectedDriverId) ?? null)

function close(): void {
  store.closeDrawer()
}

const linkCopied = ref(false)
const driverLink = computed(() => {
  const token = driver.value?.shareToken
  return token ? `${window.location.origin}/driver/${token}` : null
})
async function copyLink(): Promise<void> {
  const link = driverLink.value
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    linkCopied.value = true
  } catch {
    linkCopied.value = false
  }
}
</script>

<template>
  <div
    v-if="open && driver"
    class="fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col overflow-y-auto border-l border-line bg-surface shadow-2xl"
    data-testid="driver-drawer"
  >
    <div class="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <b class="text-sm text-ink" data-testid="drawer-name">{{ driver.name }}</b>
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
            :class="STATUS_CHIP_CLASS[driver.status]"
          >
            {{ statusLabel(driver.status) }}
          </span>
        </div>
        <p class="mt-1 text-xs text-ink-2" data-testid="drawer-phone">{{ driver.phone ?? '—' }}</p>
        <p class="text-xs text-ink-3" data-testid="drawer-languages">{{ driverLanguages(driver).join(', ') }}</p>
        <p class="text-xs text-ink-3" data-testid="drawer-home-base">
          {{ driver.homeBaseCity || driver.homeBaseState ? [driver.homeBaseCity, driver.homeBaseState].filter(Boolean).join(', ') : '—' }}
        </p>
        <p class="text-xs text-ink-3" data-testid="drawer-cdl">
          {{ driver.yearsExperience != null ? `${driver.yearsExperience} yr` : '—' }} · CDL {{ driver.cdlClass }}
          <template v-if="driver.endorsements.length"> · {{ driver.endorsements.join(' ') }}</template>
          <template v-if="driver.hazmatEndorsed"> · HAZMAT</template>
        </p>
      </div>
      <button type="button" class="shrink-0 text-sm text-ink-3 hover:text-ink" data-testid="drawer-close" aria-label="Close" @click="close">✕</button>
    </div>

    <p v-if="store.drawer.error" class="mx-4 mt-3 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/40 p-2 text-xs text-red-700 dark:text-red-200" data-testid="drawer-error">
      {{ store.drawer.error }}
    </p>
    <p v-else-if="store.drawer.loading" class="mx-4 mt-3 text-xs text-ink-3">Loading…</p>

    <DriverAvailabilityControls :driver="driver" />
    <DriverSimulationControls v-if="sim.available" :driver-id="driver.driverId" />
    <DriverEvidencePanel :metrics="store.drawer.metrics" />
    <DriverPreferencesForm :driver-id="driver.driverId" :preference="store.drawer.preference" />
    <DriverHistoryList :history="store.drawer.history" />

    <section class="px-4 py-3" data-testid="driver-link-section">
      <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-3">Driver link</h3>
      <div v-if="driverLink" class="mt-2 flex items-center gap-2">
        <input :value="driverLink" readonly class="min-w-0 flex-1 rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2" data-testid="driver-link-input" />
        <button
          type="button"
          class="shrink-0 rounded border border-line px-2 py-1 text-xs font-semibold text-ink hover:bg-surface-2"
          data-testid="driver-link-copy"
          @click="copyLink"
        >
          {{ linkCopied ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p v-else class="mt-2 text-xs text-ink-3" data-testid="driver-link-hint">
        No availability record yet — save a setting to create one.
      </p>
    </section>
  </div>
</template>
