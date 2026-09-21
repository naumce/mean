<script setup lang="ts">
// Renders only when something is selected (spec 2026-09-08 Task 5). Purely
// presentational — the view owns what each action does (confirm-before-
// delete, reload-after-archive); this component just reports intent.
// NIT 9: `hidden` is how many of the selected loads the current search or
// per-column filters are keeping off screen. The selection deliberately
// survives a search — it is a set the dispatcher built, and silently dropping
// ids because of a search box would be worse — so the bar names the gap
// instead of hiding it. (A load that left the BOARD entirely is a different
// problem, fixed in useBoardTable: it leaves the selection with it.)
const props = withDefaults(defineProps<{ count: number; busy: boolean; hidden?: number }>(), { hidden: 0 })
const emit = defineEmits<{ (e: 'archive'): void; (e: 'unarchive'): void; (e: 'delete'): void; (e: 'export'): void; (e: 'duplicate'): void; (e: 'clear'): void; (e: 'set-update', text: string): void }>()

// The handoff's "Set update…": one status written into the UPDATE cell of
// every selected load. DELIVERED stamps today's date beside it, which is what
// their sheet reads — the dispatcher can still type anything they like into
// the cell itself; this is only the shortcut for a whole selection.
const UPDATES = ['DELIVERED', 'IN TRANSIT', 'LOADING', 'AT SHIPPER', 'AT RECEIVER', 'WAITING', '(clear)']
const stamp = (choice: string): string => {
  if (choice === '(clear)') return ''
  if (choice !== 'DELIVERED') return choice
  const d = new Date()
  return `DELIVERED ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}
function onSetUpdate(ev: Event) {
  const select = ev.target as HTMLSelectElement
  const choice = select.value
  select.value = ''
  if (choice) emit('set-update', stamp(choice))
}
</script>

<template>
  <div v-if="props.count > 0" data-bulk class="flex flex-wrap items-center gap-2 rounded border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
    <span class="font-semibold">{{ props.count }} {{ props.count === 1 ? 'load' : 'loads' }} selected</span>
    <span v-if="props.hidden > 0" data-hidden class="text-ink-2">· {{ props.hidden }} not shown by the current search/filters</span>
    <span class="mx-1 text-ink-3">·</span>
    <select data-action="set-update" aria-label="Set the UPDATE cell for the selection" class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50" :disabled="props.busy" @change="onSetUpdate">
      <option value="">Set update…</option>
      <option v-for="u in UPDATES" :key="u" :value="u">{{ u }}</option>
    </select>
    <button type="button" data-action="archive" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('archive')">Archive</button>
    <button type="button" data-action="unarchive" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('unarchive')">Unarchive</button>
    <button type="button" data-action="export" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('export')">Export selected</button>
    <button type="button" data-action="duplicate" class="rounded px-2 py-1 hover:bg-surface disabled:opacity-50" :disabled="props.busy" @click="emit('duplicate')">Duplicate</button>
    <button type="button" data-action="delete" class="rounded px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40" :disabled="props.busy" @click="emit('delete')">Delete</button>
    <span class="grow"></span>
    <button type="button" data-action="clear" class="rounded px-2 py-1 text-ink-2 hover:bg-surface" @click="emit('clear')">Clear selection</button>
  </div>
</template>
