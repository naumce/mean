<script setup lang="ts">
import { ref } from 'vue'

// A small popover: check/uncheck a column's visibility, nudge it up/down in
// the header order with the arrows, or reset both to the server's layout.
// Stateless about columns themselves — BrokerGrid owns visibility/order/
// prefs and just hands this component the current list to render.
const props = defineProps<{ columns: { id: string; label: string; visible: boolean }[] }>()
const emit = defineEmits<{ (e: 'toggle', id: string): void; (e: 'move', id: string, dir: -1 | 1): void; (e: 'reset'): void }>()
const open = ref(false)
</script>

<template>
  <div class="relative">
    <button type="button" data-columns class="rounded border border-line px-2 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="open = !open" :aria-expanded="open">Columns</button>
    <div v-if="open" class="absolute right-0 z-40 mt-1 w-72 rounded border border-line bg-surface p-2 shadow-xl" role="menu">
      <ul class="max-h-80 overflow-auto text-sm text-ink">
        <li v-for="(c, i) in props.columns" :key="c.id" class="flex items-center gap-2 px-1 py-1">
          <input type="checkbox" :id="'col-' + c.id" :checked="c.visible" @change="emit('toggle', c.id)" />
          <label :for="'col-' + c.id" class="grow truncate">{{ c.label }}</label>
          <button type="button" :data-move-up="c.id" class="px-1 text-ink-3 hover:text-ink disabled:opacity-30" :disabled="i === 0" aria-label="Move up" @click="emit('move', c.id, -1)">▲</button>
          <button type="button" :data-move-down="c.id" class="px-1 text-ink-3 hover:text-ink disabled:opacity-30" :disabled="i === props.columns.length - 1" aria-label="Move down" @click="emit('move', c.id, 1)">▼</button>
        </li>
      </ul>
      <button type="button" data-reset class="mt-2 w-full rounded border border-line px-2 py-1 text-sm text-ink-2 hover:bg-surface-2" @click="emit('reset')">Reset to their layout</button>
    </div>
  </div>
</template>
