<script setup lang="ts">
import { onUnmounted, watch } from 'vue'
import { useCockpitStore } from '../../stores/cockpit'

// Transient copies of new activity; each disappears after 5s or on click.
const emit = defineEmits<{ jump: [loadId: string] }>()
const ck = useCockpitStore()
const TOAST_MS = 5_000
const timers = new Map<number, ReturnType<typeof setTimeout>>()
watch(
  () => ck.toasts.map((t) => t.id),
  (ids) => {
    for (const id of ids)
      if (!timers.has(id)) timers.set(id, setTimeout(() => { timers.delete(id); ck.dismissToast(id) }, TOAST_MS))
    for (const [id, t] of timers) if (!ids.includes(id)) { clearTimeout(t); timers.delete(id) }
  },
  { immediate: true },
)
onUnmounted(() => timers.forEach((t) => clearTimeout(t)))
function pick(id: number, loadId: string | null): void {
  if (loadId) emit('jump', loadId)
  ck.dismissToast(id)
}
</script>

<template>
  <div class="fixed bottom-4 right-4 z-[65] flex flex-col items-end gap-2">
    <button
      v-for="t in ck.toasts"
      :key="t.id"
      type="button"
      class="max-w-[340px] rounded-lg border border-line-strong border-l-4 bg-surface px-3 py-2 text-left font-mono text-xs shadow-2xl"
      :class="t.kind === 'conflict' ? 'border-l-red-500' : t.kind === 'plan' ? 'border-l-emerald-500' : 'border-l-blue-500'"
      data-testid="toast"
      @click="pick(t.id, t.loadId)"
    >
      <div class="font-bold text-ink">{{ t.title }}</div>
      <div class="mt-0.5 text-[10px] text-ink-3">{{ t.sub }}{{ t.loadId ? ' · click to locate' : '' }}</div>
    </button>
  </div>
</template>
