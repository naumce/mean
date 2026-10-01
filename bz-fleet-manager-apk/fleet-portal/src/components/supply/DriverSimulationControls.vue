<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSimStore } from '../../stores/sim'
import type { SimDriverMode } from '../../lib/api'

// Driver drawer Simulation section (Task 10, part B): only ever mounted by
// the caller when `sim.available` — see DriverDrawer.vue. Reads the current
// mode from the ALREADY-probed sim store (populated by SimControls.vue
// elsewhere on the same page) rather than fetching it itself, so opening the
// drawer never costs a second /sim/state round trip.
const props = defineProps<{ driverId: string }>()
const sim = useSimStore()

const MODES: SimDriverMode[] = ['auto', 'stopped', 'dark', 'offroute', 'idle']

/** dispatcherSim.ts's GET /sim/state only lists non-auto rows (an "auto" row
 *  is indistinguishable from no row at all) — a driver missing from
 *  `sim.state.drivers` is simply running "auto". */
const currentMode = computed<SimDriverMode>(() => {
  const row = sim.state?.drivers.find((d) => d.driverId === props.driverId)
  return row?.mode ?? 'auto'
})

// Vue's v-model casts a `type="number"` input's value to a number as soon
// as it holds any parseable text, but leaves it the empty string while
// blank — so these two fields are genuinely `number | ''`, never a plain
// string with a `.trim()` to call.
const form = reactive<{ mode: SimDriverMode; minutes: number | ''; offsetMi: number | '' }>({
  mode: currentMode.value,
  minutes: '',
  offsetMi: '',
})
const saving = ref(false)
const saved = ref(false)

watch(
  () => props.driverId,
  () => {
    form.mode = currentMode.value
    form.minutes = ''
    form.offsetMi = ''
    saved.value = false
  },
)
// A tick or another dispatcher's own mode change can move `currentMode`
// out from under an untouched form — keep the select honest with the
// server's own view rather than a stale local default.
watch(currentMode, (mode) => {
  form.mode = mode
})

function toOptionalNumber(v: number | ''): number | undefined {
  return v === '' || !Number.isFinite(v) ? undefined : v
}

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  const body: { mode: SimDriverMode; minutes?: number; offsetMi?: number } = { mode: form.mode }
  const minutes = toOptionalNumber(form.minutes)
  if (minutes !== undefined) body.minutes = minutes
  if (form.mode === 'offroute') {
    const offsetMi = toOptionalNumber(form.offsetMi)
    if (offsetMi !== undefined) body.offsetMi = offsetMi
  }
  const ok = await sim.setDriverMode(props.driverId, body)
  saving.value = false
  saved.value = ok
}
</script>

<template>
  <section class="border-b border-line px-4 py-3" data-testid="sim-drawer-section">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-3">Simulation</h3>
    <p class="mt-1 text-xs text-ink-3" data-testid="sim-current-mode">Current mode: {{ currentMode }}</p>
    <div class="mt-2 flex flex-col gap-2 text-xs">
      <label class="flex flex-col gap-1">
        Mode
        <select v-model="form.mode" data-testid="sim-mode-select" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink">
          <option v-for="m in MODES" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        Minutes (optional)
        <input v-model="form.minutes" type="number" min="1" data-testid="sim-minutes" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>
      <label v-if="form.mode === 'offroute'" class="flex flex-col gap-1">
        Offset (mi)
        <input v-model="form.offsetMi" type="number" min="0" data-testid="sim-offset-mi" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" />
      </label>
      <div class="mt-1 flex items-center gap-2">
        <button
          type="button"
          class="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="sim.busy"
          data-testid="sim-mode-save"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <span v-if="saved" class="text-emerald-600 dark:text-emerald-400" data-testid="sim-mode-saved">Saved</span>
        <span v-if="sim.error" class="text-red-600 dark:text-red-400" data-testid="sim-mode-error">{{ sim.error }}</span>
      </div>
    </div>
  </section>
</template>
