<script setup lang="ts">
import { ageLabel } from '../../lib/cockpit/format'
import { useCockpitStore, type ActivityKind } from '../../stores/cockpit'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; jump: [loadId: string] }>()
const ck = useCockpitStore()
const ICON: Record<ActivityKind, string> = { move: '🔀', plan: '📌', conflict: '⚠', hook: '🔗', feed: '📡', lock: '🔒', message: '💬' }
function pick(id: number, loadId: string | null): void {
  ck.activity = ck.activity.map((a) => (a.id === id ? { ...a, read: true } : a))
  if (loadId) emit('jump', loadId)
  emit('close')
}
</script>

<template>
  <div v-if="props.open" class="fixed right-4 top-[58px] z-50 flex max-h-[70vh] w-[360px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl" data-testid="activity-panel">
    <div class="flex items-center justify-between border-b border-line px-3.5 py-2.5">
      <b class="font-mono text-xs text-ink">Activity Feed</b>
      <button type="button" class="font-mono text-[10px] text-brand-ink hover:underline" data-testid="mark-read" @click="ck.markAllRead()">Mark all read</button>
    </div>
    <div class="overflow-y-auto">
      <button v-for="a in ck.activity" :key="a.id" type="button" class="flex w-full gap-2.5 border-b border-line/80 px-3.5 py-2.5 text-left hover:bg-surface-2" :class="a.read ? '' : 'bg-brand/5'" data-testid="activity-item" @click="pick(a.id, a.loadId)">
        <div class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-3 text-xs">{{ ICON[a.kind] }}</div>
        <div class="min-w-0"><div class="truncate text-[11px] font-bold" :class="a.read ? 'text-ink-2' : 'text-ink'">{{ a.title }}</div><div class="truncate font-mono text-[10px] text-ink-3">{{ a.sub }} · {{ ageLabel(new Date(a.at).toISOString(), Date.now()) }}</div></div>
      </button>
      <div v-if="!ck.activity.length" class="p-6 text-center font-mono text-[11px] text-ink-3">No activity yet.</div>
    </div>
  </div>
</template>
