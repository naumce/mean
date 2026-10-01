<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useDriverSupplyStore } from '../../stores/driverSupply'
import type { DriverPreference } from '../../types/supply'

// Preferences (drawer section 4): the whole DriverPreference row is always
// fully loaded before this form renders (driverSupply.ts's select() fetches
// it alongside metrics/history), so — unlike the availability panel's
// optional field-by-field overrides — Save always writes the complete,
// currently-edited set: there is no "untouched field" ambiguity to preserve.
const props = defineProps<{ driverId: string; preference: DriverPreference | null }>()
const store = useDriverSupplyStore()

/** Comma-separated list <-> string[], trimming blanks either way. */
function listToText(items: string[]): string {
  return items.join(', ')
}
function textToList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean)
}
/** One lane per line <-> string[]. */
function linesToText(items: string[]): string {
  return items.join('\n')
}
function textToLines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean)
}

function formFromPreference(pref: DriverPreference | null) {
  const p = pref ?? {
    maxTripMiles: null, preferredRegions: [], preferredLanes: [], avoidRegions: [], avoidLanes: [],
    homeTimeTarget: null, willingToDriveNight: true, willingToRelocateMiles: null, preferredEquipment: [],
  }
  return {
    maxTripMiles: (p.maxTripMiles ?? '') as number | string,
    willingToRelocateMiles: (p.willingToRelocateMiles ?? '') as number | string,
    homeTimeTarget: p.homeTimeTarget ?? '',
    willingToDriveNight: p.willingToDriveNight,
    preferredEquipment: listToText(p.preferredEquipment),
    preferredRegions: listToText(p.preferredRegions),
    avoidRegions: listToText(p.avoidRegions),
    preferredLanes: linesToText(p.preferredLanes),
    avoidLanes: linesToText(p.avoidLanes),
  }
}

const form = reactive(formFromPreference(props.preference))
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

watch(
  () => [props.driverId, props.preference],
  () => {
    Object.assign(form, formFromPreference(props.preference))
    saved.value = false
    error.value = null
  },
)

// Vue's native <input type="number"> v-model coerces to a real number at the
// DOM layer (runtime-dom's vModelText), independent of the `.number`
// modifier — so this has to accept either, not just the string this field
// starts out as (formFromPreference above seeds it from a possibly-null API
// number).
function toIntOrNull(value: string | number): number | null {
  if (value === '') return null
  const n = typeof value === 'number' ? value : Number.parseInt(value.trim(), 10)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = null
  const ok = await store.updatePreference(props.driverId, {
    maxTripMiles: toIntOrNull(form.maxTripMiles),
    willingToRelocateMiles: toIntOrNull(form.willingToRelocateMiles),
    homeTimeTarget: form.homeTimeTarget.trim() || null,
    willingToDriveNight: form.willingToDriveNight,
    preferredEquipment: textToList(form.preferredEquipment),
    preferredRegions: textToList(form.preferredRegions),
    avoidRegions: textToList(form.avoidRegions),
    preferredLanes: textToLines(form.preferredLanes),
    avoidLanes: textToLines(form.avoidLanes),
  })
  saving.value = false
  if (ok) saved.value = true
  else error.value = store.error
}
</script>

<template>
  <section class="border-b border-line px-4 py-3" data-testid="preferences-form">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-3">Preferences</h3>
    <div class="mt-2 flex flex-col gap-2 text-xs">
      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1">
          Max trip miles
          <input v-model="form.maxTripMiles" type="number" min="0" data-testid="pref-max-trip-miles" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
        </label>
        <label class="flex flex-col gap-1">
          Willing to relocate (mi)
          <input v-model="form.willingToRelocateMiles" type="number" min="0" data-testid="pref-relocate-miles" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
        </label>
      </div>

      <label class="flex items-center gap-2">
        <input v-model="form.willingToDriveNight" type="checkbox" data-testid="pref-drive-night" />
        Willing to drive at night
      </label>

      <label class="flex flex-col gap-1">
        Home time target
        <input v-model="form.homeTimeTarget" maxlength="40" data-testid="pref-home-time-target" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>

      <label class="flex flex-col gap-1">
        Preferred equipment (comma-separated)
        <input v-model="form.preferredEquipment" data-testid="pref-equipment" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>

      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1">
          Preferred regions (e.g. TX, OK)
          <input v-model="form.preferredRegions" data-testid="pref-preferred-regions" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
        </label>
        <label class="flex flex-col gap-1">
          Avoid regions
          <input v-model="form.avoidRegions" data-testid="pref-avoid-regions" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
        </label>
      </div>

      <label class="flex flex-col gap-1">
        Preferred lanes (one per line, "City, ST &gt; City, ST")
        <textarea v-model="form.preferredLanes" rows="2" data-testid="pref-preferred-lanes" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>
      <label class="flex flex-col gap-1">
        Avoid lanes
        <textarea v-model="form.avoidLanes" rows="2" data-testid="pref-avoid-lanes" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>

      <div class="mt-1 flex items-center gap-2">
        <button
          type="button"
          class="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="preferences-save"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <span v-if="saved" class="text-emerald-600 dark:text-emerald-400" data-testid="preferences-saved">Saved</span>
        <span v-if="error" class="text-red-600 dark:text-red-400" data-testid="preferences-error">{{ error }}</span>
      </div>
    </div>
  </section>
</template>
