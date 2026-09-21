<script setup lang="ts">
import { computed } from 'vue'

// Night Shift on the Board, Task 6: the pill vocabulary of spec §6.1, plus
// `held` from §17.3 ("I've got it" — a human holds it, agent watching but
// silent). Shared by Their Board's AGENT column (BrokerGrid.vue) and the
// Cockpit's brick + inspect panel (LegBrick.vue, MasterDrawer.vue) — one
// definition of what each state looks like and means, read from either
// board's own `agentPill`/`agentLine` projection.
const PILL_META: Record<string, { label: string; classes: string; fallback: string }> = {
  off: { label: '—', classes: 'text-ink-3', fallback: 'Not assigned yet, or shadow mode off and agent off for this load' },
  watching: { label: 'Watching', classes: 'bg-emerald-500/15 text-emerald-600', fallback: 'Trip started; driver invited or tracking, nothing open' },
  asked: { label: 'Asked', classes: 'bg-amber-500/15 text-amber-600', fallback: "A question is open on the driver's page" },
  calling: { label: 'Calling', classes: 'bg-amber-500/15 text-amber-600', fallback: 'A voice rung is in progress or just happened' },
  escalated: { label: 'Escalated', classes: 'bg-red-500/15 text-red-600', fallback: 'The dispatcher has been emailed (and called, if configured)' },
  delivered: { label: 'Delivered', classes: 'bg-emerald-500 text-white', fallback: 'Arrived; on time or late shown in the tooltip' },
  attention: { label: 'Attention', classes: 'border border-red-500 text-red-600', fallback: "The agent could not start or continue (missing phone, unreadable appointment, route unusable)" },
  shadow: { label: 'Shadow', classes: 'bg-blue-500/15 text-blue-600', fallback: 'The agent is watching but not allowed to talk' },
  held: { label: 'Held', classes: 'bg-violet-500/15 text-violet-600', fallback: "A human holds it — the agent is watching but silent" },
}

const props = defineProps<{
  /** One of the states above. An unrecognised or missing value renders as
   *  `off` — the same "—, grey" the board shows a load the agent has never
   *  touched. */
  pill?: string | null
  /** The last event's own sentence (spec §6.1: "Asked at 02:14, no reply
   *  yet…"). When absent, the tooltip falls back to the state's own meaning
   *  from the §6.1 table, verbatim. */
  line?: string | null
  /** Who to open when clicked — this component never navigates itself
   *  (another implementer owns the drawer); it only names the load. */
  loadId: string
}>()
const emit = defineEmits<{ (e: 'open-agent', loadId: string): void }>()

const meta = computed(() => PILL_META[props.pill ?? 'off'] ?? PILL_META.off)
const title = computed(() => props.line || meta.value.fallback)
</script>

<template>
  <button
    type="button"
    data-agent-pill
    :data-pill-state="pill ?? 'off'"
    class="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none"
    :class="meta.classes"
    :title="title"
    @click.stop="emit('open-agent', loadId)"
  >{{ meta.label }}</button>
</template>
