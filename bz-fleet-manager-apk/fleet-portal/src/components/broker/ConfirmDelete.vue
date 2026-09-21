<script setup lang="ts">
// Names every selected load before it deletes anything — the whole point of
// this dialog is that a dispatcher never has to trust "N loads" blind.
const props = defineProps<{ labels: string[] }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Delete loads">
    <div class="w-[min(520px,95vw)] rounded-lg border border-line bg-surface p-5 text-ink shadow-xl">
      <h2 class="text-lg font-semibold">Delete {{ props.labels.length }} {{ props.labels.length === 1 ? 'load' : 'loads' }}?</h2>
      <p class="mt-1 text-sm text-ink-2">This can't be undone. Loads that are assigned or in progress will refuse and nothing will be deleted.</p>
      <ul class="mt-3 max-h-48 overflow-auto rounded border border-line bg-surface-2 p-2 text-sm font-mono">
        <li v-for="l in props.labels" :key="l">{{ l }}</li>
      </ul>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" data-cancel class="rounded px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="emit('cancel')">Cancel</button>
        <button type="button" data-confirm class="rounded bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700" @click="emit('confirm')">Delete {{ props.labels.length }} {{ props.labels.length === 1 ? 'load' : 'loads' }}</button>
      </div>
    </div>
  </div>
</template>
