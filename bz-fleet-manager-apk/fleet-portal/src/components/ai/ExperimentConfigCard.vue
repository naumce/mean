<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { HARNESS_CONFIG_RANGES, type HarnessConfig } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1): the harness config, editable within the same
// ranges the backend validates (design §2 defaults / task-7 brief) — used
// both for an existing experiment's "Save changes" and, embedded in the Lab
// page's create form, for "prefilled, editable defaults before creating."
//
// dispatch-v2 A/B experiment: the prompt version select lives here too (not
// a separate control on the Lab page) since both the create form and an
// existing experiment's config card need the identical "pick from
// status.promptVersions, locked once runs exist" behavior. `runCount` stays
// at its default `0` for the create-form usage — a brand-new experiment has
// no runs yet, so the select is never locked there.
const props = withDefaults(
  defineProps<{
    config: HarnessConfig
    promptVersion: string
    promptVersions?: string[]
    runCount?: number
    saving?: boolean
    saveLabel?: string
  }>(),
  {
    promptVersions: () => [],
    runCount: 0,
    saving: false,
    saveLabel: 'Save',
  },
)
const emit = defineEmits<{ save: [payload: { config: HarnessConfig; promptVersion?: string }] }>()

const draft = reactive<HarnessConfig>({ ...props.config })
watch(
  () => props.config,
  (next) => Object.assign(draft, next),
)

const draftPromptVersion = ref(props.promptVersion)
watch(
  () => props.promptVersion,
  (next) => { draftPromptVersion.value = next },
)

// Once an experiment has runs, the backend rejects a PATCH that names
// `promptVersion` at all (409 HAS_RUNS) — locking the select here and
// omitting the field from the emitted payload (see onSave) keeps a routine
// "save the config" from ever tripping that guard.
const promptVersionLocked = computed(() => props.runCount > 0)
// The current value is always selectable even if `promptVersions` (fed from
// `status.promptVersions`) hasn't loaded yet or omits it for some reason —
// a select whose bound value matches no <option> renders blank.
const promptVersionOptions = computed(() => Array.from(new Set([...props.promptVersions, draftPromptVersion.value])))

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
  emit('save', {
    config: { ...draft },
    ...(promptVersionLocked.value ? {} : { promptVersion: draftPromptVersion.value }),
  })
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
      <label class="flex flex-col gap-1">
        <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Prompt version</span>
        <select
          v-model="draftPromptVersion"
          :disabled="promptVersionLocked"
          class="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-ink disabled:bg-surface-3 disabled:text-ink-3"
          data-testid="config-prompt-version"
        >
          <option v-for="version in promptVersionOptions" :key="version" :value="version">{{ version }}</option>
        </select>
        <span v-if="promptVersionLocked" class="text-[10px] text-ink-3" data-testid="config-prompt-version-hint">fixed once runs exist</span>
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
        <span v-if="errors[field]" class="text-[10px] text-red-600 dark:text-red-400" role="alert">{{ errors[field] }}</span>
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
      <span v-if="hasErrors" class="text-[11px] text-red-600 dark:text-red-400" data-testid="config-invalid">Fix the highlighted fields first.</span>
    </div>
  </form>
</template>
