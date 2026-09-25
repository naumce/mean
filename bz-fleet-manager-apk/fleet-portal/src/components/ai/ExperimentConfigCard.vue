<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { HARNESS_CONFIG_RANGES, type HarnessConfig } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1): the harness config, editable within the same
// ranges the backend validates (design §2 defaults / task-7 brief) — used
// both for an existing experiment's "Save changes" and, embedded in the Lab
// page's create form, for "prefilled, editable defaults before creating."
const props = withDefaults(defineProps<{ config: HarnessConfig; saving?: boolean; saveLabel?: string }>(), {
  saving: false,
  saveLabel: 'Save',
})
const emit = defineEmits<{ save: [config: HarnessConfig] }>()

const draft = reactive<HarnessConfig>({ ...props.config })
watch(
  () => props.config,
  (next) => Object.assign(draft, next),
)

const RANGED_FIELDS = Object.keys(HARNESS_CONFIG_RANGES) as (keyof typeof HARNESS_CONFIG_RANGES)[]

const errors = computed<Partial<Record<keyof HarnessConfig, string>>>(() => {
  const found: Partial<Record<keyof HarnessConfig, string>> = {}
  for (const field of RANGED_FIELDS) {
    const { min, max } = HARNESS_CONFIG_RANGES[field]
    const value = draft[field]
    if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
      found[field] = `must be between ${min} and ${max}`
    }
  }
  if (!draft.model.trim()) found.model = 'required'
  return found
})
const hasErrors = computed(() => Object.keys(errors.value).length > 0)

function onSave(): void {
  if (hasErrors.value) return
  // A fresh object — the parent's own config prop must never be mutated by
  // this card's local draft.
  emit('save', { ...draft })
}
</script>

<template>
  <form class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 text-xs" data-testid="experiment-config-card" @submit.prevent="onSave">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <label class="flex flex-col gap-1">
        <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Adapter</span>
        <input :value="draft.adapter" disabled class="rounded border border-line bg-surface-3 px-2 py-1 font-mono text-ink-3" data-testid="config-adapter" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Model</span>
        <input v-model.trim="draft.model" class="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-ink" data-testid="config-model" />
      </label>
      <label class="flex items-center gap-2 self-end pb-1">
        <input v-model="draft.think" type="checkbox" data-testid="config-think" />
        <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Think</span>
      </label>

      <label v-for="field in RANGED_FIELDS" :key="field" class="flex flex-col gap-1">
        <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">{{ field }}</span>
        <input
          v-model.number="draft[field]"
          type="number"
          :step="field === 'temperature' ? 0.1 : 1"
          :min="HARNESS_CONFIG_RANGES[field].min"
          :max="HARNESS_CONFIG_RANGES[field].max"
          class="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-ink"
          :data-testid="`config-${field}`"
        />
        <span v-if="errors[field]" class="text-[10px] text-red-600" role="alert">{{ errors[field] }}</span>
      </label>
    </div>

    <div class="flex items-center gap-2">
      <button
        type="submit"
        class="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="config-save"
        :disabled="saving || hasErrors"
      >
        {{ saving ? 'Saving…' : saveLabel }}
      </button>
      <span v-if="hasErrors" class="text-[11px] text-red-600" data-testid="config-invalid">Fix the highlighted fields first.</span>
    </div>
  </form>
</template>
