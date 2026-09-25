<script setup lang="ts">
import { computed } from 'vue'

// AI Lab (Qwen Harness v0.1): raw JSON, exactly as the harness persisted it —
// no summarizing, no re-labelling of fields. The developer-console rule for
// this whole surface (task-7 brief): monospace numbers, raw JSON, nothing
// interpreted on the model's behalf.
const props = defineProps<{ value: unknown }>()

const pretty = computed(() => {
  if (props.value === undefined) return '—'
  try {
    return JSON.stringify(props.value, null, 2)
  } catch {
    return String(props.value)
  }
})
</script>

<template>
  <pre
    class="max-h-64 overflow-auto rounded border border-line bg-surface-3 p-2 font-mono text-[11px] leading-relaxed text-ink-2"
    data-testid="json-viewer"
  >{{ pretty }}</pre>
</template>
