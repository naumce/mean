<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useNightShiftStore } from '../../stores/nightShift'

// Night Shift on the Board, Task 6: the switch on a load. A Load write like
// any other (traced, version-backstopped — spec §17.1), routed through
// nightShift.ts's `setSwitch`. Turning it ON opens a small policy picker
// defaulting to Standard (spec §17.2: "the dispatcher picks the policy…in
// the same gesture"); turning it OFF asks first, since it stops a night
// watcher that is presumably already doing something.
const props = defineProps<{
  load: { id: string; version: number; agentEnabled?: boolean; agentPolicyId?: string | null }
  /** Someone else holds this load (the lock badge, spec §7.3) — same
   *  treatment the board gives a locked row: the pill still shows, the
   *  switch does not respond. */
  disabled?: boolean
  /** Task 11 ruling: on an org with a connected sheet binding, the switch is
   *  disabled with a reason that names where it actually moves now ("Change
   *  it in the Night Shift column of your sheet"), not the lock message
   *  below — which stays the default whenever `disabled` is true but the
   *  caller has no more specific reason to give. */
  disabledReason?: string
}>()
const emit = defineEmits<{
  (e: 'change', payload: { enabled: boolean; policyId?: string }): void
  /** The write landed on a version the row no longer has (409
   *  STALE_VERSION, spec §7.4). This component has no board row to
   *  re-render — the caller owns that (brokerBoard.ts's `patchRows` or
   *  loadboard.ts's `patchLoads`) — so it only says "go reload me". */
  (e: 'stale'): void
}>()

const nightShift = useNightShiftStore()
onMounted(() => {
  if (!nightShift.policies?.length && !nightShift.loading) void nightShift.loadPolicies()
})

const busy = ref(false)
const error = ref<string | null>(null)
const showPicker = ref(false)
const showConfirmOff = ref(false)
const pickedPolicyId = ref('')

const standardPolicyId = computed(
  () => (nightShift.policies ?? []).find((p) => p.name === 'Standard')?.id ?? nightShift.policies?.[0]?.id ?? '',
)

function onToggle(): void {
  if (props.disabled || busy.value) return
  error.value = null
  if (props.load.agentEnabled) {
    showConfirmOff.value = true
  } else {
    pickedPolicyId.value = props.load.agentPolicyId ?? standardPolicyId.value
    showPicker.value = true
  }
}
function cancelOn(): void { showPicker.value = false }
function cancelOff(): void { showConfirmOff.value = false }
async function confirmOn(): Promise<void> {
  showPicker.value = false
  await doSwitch(true, pickedPolicyId.value || undefined)
}
async function confirmOff(): Promise<void> {
  showConfirmOff.value = false
  await doSwitch(false)
}

async function doSwitch(enabled: boolean, policyId?: string): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await nightShift.setSwitch(props.load.id, enabled, policyId, props.load.version)
    emit('change', enabled ? { enabled, policyId } : { enabled })
  } catch (e) {
    const body = (e as { response?: { data?: { error?: string } } } | undefined)?.response?.data
    if (body?.error === 'STALE_VERSION') {
      error.value = 'This load changed elsewhere — reloading it.'
      emit('stale')
    } else {
      error.value = 'That did not go through — try again'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="relative inline-flex items-center">
    <button
      type="button"
      role="switch"
      :aria-checked="!!load.agentEnabled"
      data-agent-switch
      class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50"
      :class="load.agentEnabled ? 'bg-emerald-500' : 'bg-surface-3'"
      :disabled="disabled || busy"
      :title="disabled ? (disabledReason ?? 'Someone else is editing this load') : (load.agentEnabled ? 'Stop watching this load' : 'Start watching this load')"
      @click="onToggle"
    >
      <span class="inline-block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform" :class="load.agentEnabled ? 'translate-x-3.5' : ''" />
    </button>

    <div v-if="showPicker" data-agent-policy-picker class="absolute left-0 top-5 z-30 w-44 rounded border border-line bg-surface p-2 text-[11px] shadow-xl">
      <label class="block text-[10px] text-ink-3" for="agent-policy-select">Policy</label>
      <select id="agent-policy-select" v-model="pickedPolicyId" data-policy-select class="mt-1 w-full rounded border border-line bg-surface-2 px-1 py-0.5 text-ink">
        <option v-for="p in nightShift.policies ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <div class="mt-2 flex justify-end gap-1">
        <button type="button" data-cancel class="rounded px-2 py-0.5 text-ink-3 hover:bg-surface-2" @click="cancelOn">Cancel</button>
        <button type="button" data-confirm class="rounded bg-brand px-2 py-0.5 font-semibold text-white" @click="confirmOn">Start</button>
      </div>
    </div>

    <div v-if="showConfirmOff" data-agent-off-confirm class="absolute left-0 top-5 z-30 w-48 rounded border border-line bg-surface p-2 text-[11px] shadow-xl">
      <p class="text-ink">Stop watching this load?</p>
      <div class="mt-2 flex justify-end gap-1">
        <button type="button" data-cancel class="rounded px-2 py-0.5 text-ink-3 hover:bg-surface-2" @click="cancelOff">Cancel</button>
        <button type="button" data-confirm class="rounded bg-red-600 px-2 py-0.5 font-semibold text-white" @click="confirmOff">Stop</button>
      </div>
    </div>

    <span v-if="error" data-agent-switch-error class="ml-1 text-[10px] text-red-500" role="alert">{{ error }}</span>
  </span>
</template>
