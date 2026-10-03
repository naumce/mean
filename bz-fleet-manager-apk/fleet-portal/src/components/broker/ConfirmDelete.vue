<script setup lang="ts">
// Shows what a Delete will do before it does anything: the loads it will
// delete, and — with the reason — the ones it can't. The dispatcher never has
// to trust "N loads" blind.
import { computed } from 'vue'

interface Deletable { id: string; label: string }
interface Blocked { id: string; label: string; reason: string }

const props = defineProps<{ loading: boolean; deletable: Deletable[]; blocked: Blocked[]; count?: number }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const noun = (n: number) => (n === 1 ? 'load' : 'loads')
const blockedGroups = computed(() => {
  const groups = new Map<string, Blocked[]>()
  for (const b of props.blocked) groups.set(b.reason, [...(groups.get(b.reason) ?? []), b])
  return [...groups.entries()].map(([reason, items]) => ({ reason, items }))
})
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Delete loads">
    <div class="w-[min(560px,95vw)] rounded-lg border border-line bg-surface p-5 text-ink shadow-xl">
      <template v-if="props.loading">
        <h2 class="text-lg font-semibold" data-loading>Checking {{ props.count ?? '' }} {{ noun(props.count ?? 0) }}…</h2>
        <div class="mt-4 flex justify-end">
          <button type="button" data-cancel class="rounded px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="emit('cancel')">Cancel</button>
        </div>
      </template>
      <template v-else>
        <h2 class="text-lg font-semibold">
          <template v-if="props.deletable.length === 0">None of the selected loads can be deleted</template>
          <template v-else>Delete {{ props.deletable.length }} {{ noun(props.deletable.length) }}?</template>
        </h2>

        <section v-if="props.deletable.length > 0" data-testid="delete-deletable" class="mt-3">
          <h3 class="text-sm font-medium">Will be deleted ({{ props.deletable.length }})</h3>
          <p class="mt-1 text-sm text-ink-2">This can't be undone.</p>
          <ul class="mt-2 max-h-40 overflow-auto rounded border border-line bg-surface-2 p-2 text-sm font-mono">
            <li v-for="l in props.deletable" :key="l.id">{{ l.label }}</li>
          </ul>
        </section>

        <section v-if="props.blocked.length > 0" data-testid="delete-blocked" class="mt-3">
          <h3 class="text-sm font-medium text-amber-700 dark:text-amber-400">Can't be deleted ({{ props.blocked.length }})</h3>
          <div class="mt-2 max-h-40 overflow-auto rounded border border-line bg-surface-2 p-2 text-sm">
            <div v-for="g in blockedGroups" :key="g.reason" class="mb-2 last:mb-0" data-blocked-group>
              <div class="text-ink-2">{{ g.reason }} ({{ g.items.length }})</div>
              <ul class="font-mono">
                <li v-for="b in g.items" :key="b.id">{{ b.label }}</li>
              </ul>
            </div>
          </div>
        </section>

        <div class="mt-4 flex justify-end gap-2">
          <template v-if="props.deletable.length > 0">
            <button type="button" data-cancel class="rounded px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="emit('cancel')">Cancel</button>
            <button type="button" data-confirm class="rounded bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700" @click="emit('confirm')">Delete {{ props.deletable.length }} {{ noun(props.deletable.length) }}</button>
          </template>
          <button v-else type="button" data-cancel class="rounded px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="emit('cancel')">Close</button>
        </div>
      </template>
    </div>
  </div>
</template>
