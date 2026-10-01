<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useDriverSupplyStore } from '../../stores/driverSupply'
import type { PatchAvailabilityBody, SupplyDriver } from '../../types/supply'

// Availability controls (drawer section 2 of the brief): acceptingLoads
// toggle, a status select limited to the three DISPATCHER-settable statuses
// (AVAILABLE_SOON/ON_LOAD are derived from an active assignment — offering
// them here would let a dispatcher "set" a status the engine immediately
// overrides), and optional projected-location overrides. Save writes only
// the fields the form actually touched, same field-by-field-override
// contract the PATCH route itself documents.
const props = defineProps<{ driver: SupplyDriver }>()
const store = useDriverSupplyStore()

const EDITABLE_STATUSES = ['AVAILABLE', 'OFF_DUTY', 'UNAVAILABLE'] as const
type EditableStatus = (typeof EDITABLE_STATUSES)[number]

function isEditableStatus(status: string): status is EditableStatus {
  return (EDITABLE_STATUSES as readonly string[]).includes(status)
}

/** epoch ms -> the value a <input type="datetime-local"> expects, in the
 *  browser's own local time (there is no timezone-aware datetime-local
 *  input); '' when unset. */
function toDatetimeLocal(ms: number | null): string {
  if (ms == null) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formFromDriver(driver: SupplyDriver) {
  return {
    acceptingLoads: driver.acceptingLoads,
    availabilityStatus: isEditableStatus(driver.status) ? driver.status : ('' as EditableStatus | ''),
    availableCity: driver.available.city ?? '',
    availableState: driver.available.state ?? '',
    availableAt: toDatetimeLocal(driver.availableAt),
  }
}

const form = reactive(formFromDriver(props.driver))
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.driver.driverId,
  () => {
    Object.assign(form, formFromDriver(props.driver))
    saved.value = false
    error.value = null
  },
)

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = null
  const body: PatchAvailabilityBody = { acceptingLoads: form.acceptingLoads }
  if (form.availabilityStatus) body.availabilityStatus = form.availabilityStatus
  if (form.availableCity.trim()) body.availableCity = form.availableCity.trim()
  if (form.availableState.trim()) body.availableState = form.availableState.trim()
  if (form.availableAt) body.availableAt = new Date(form.availableAt).toISOString()

  const ok = await store.updateAvailability(props.driver.driverId, body)
  saving.value = false
  if (ok) saved.value = true
  else error.value = store.error
}
</script>

<template>
  <section class="border-b border-line px-4 py-3" data-testid="availability-controls">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-3">Availability</h3>
    <div class="mt-2 flex flex-col gap-2 text-xs">
      <label class="flex items-center gap-2">
        <input v-model="form.acceptingLoads" type="checkbox" data-testid="availability-accepting" />
        Accepting loads
      </label>

      <label class="flex flex-col gap-1">
        Status
        <select v-model="form.availabilityStatus" data-testid="availability-status" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink">
          <option value="">Derived from assignment / acceptingLoads</option>
          <option v-for="s in EDITABLE_STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>

      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1">
          Projected city
          <input v-model="form.availableCity" data-testid="availability-city" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
        </label>
        <label class="flex flex-col gap-1">
          Projected state
          <input v-model="form.availableState" data-testid="availability-state" maxlength="2" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
        </label>
      </div>

      <label class="flex flex-col gap-1">
        Projected available at
        <input v-model="form.availableAt" type="datetime-local" data-testid="availability-at" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>

      <div class="mt-1 flex items-center gap-2">
        <button
          type="button"
          class="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="availability-save"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <span v-if="saved" class="text-emerald-600 dark:text-emerald-400" data-testid="availability-saved">Saved</span>
        <span v-if="error" class="text-red-600 dark:text-red-400" data-testid="availability-error">{{ error }}</span>
      </div>
    </div>
  </section>
</template>
