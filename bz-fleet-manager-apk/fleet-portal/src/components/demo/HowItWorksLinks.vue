<script setup lang="ts">
import { ref } from 'vue'
import type { DemoStoryLogEntry } from '../../types/demo'

// Demo Mode (2026-09-28 plan, Task 2): the collapsed "How it works" panel —
// everywhere the technical detail behind the presenter surface actually
// lives (AI Lab, Cockpit, Driver Supply, the raw event log), tucked away so
// the main screen stays plain business language. Same manual
// toggle-button-plus-v-if idiom AppShell.vue's own "More" disclosure uses,
// not a native <details> element, so this file's spec can drive it the same
// way AppShell.spec.ts already drives that one.
//
// "Night Shift timeline" links to the Cockpit's `?load=` deep link (Task 6)
// once one is known — CockpitView watches `route.query.load` into its
// AgentDrawer, so this opens that load's supervision drawer directly instead
// of landing on the plain board. Before the demo has a load yet
// (`agentTimelineLoadId` still null), it falls back to the plain /cockpit
// route, same as before.
// Render follow-up (2026-10-01): `recommendationSource` says whether the AI
// model or the dispatch rules actually produced the recommendation on
// screen — DemoView passes `demo.data?.story?.recommendationSource ?? null`.
// Before this, a timed-out/unavailable model (source 'engine', no aiRunId
// yet or a run that never finished) still read "AI Lab run (not started
// yet)", implying nothing was ever asked. Presenter copy rule: no other line
// here may use the words score/rank/ranking/engine/deterministic/scenario —
// the prop VALUE 'engine' is fine, those words are not what the room reads.
defineProps<{
  aiRunId: string | null
  log: DemoStoryLogEntry[]
  agentTimelineLoadId: string | null
  recommendationSource: 'ai' | 'engine' | null
}>()

const open = ref(false)
const logOpen = ref(false)

function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <div class="rounded-lg border border-line bg-surface" data-testid="how-it-works">
    <button
      type="button"
      class="flex w-full items-center justify-between px-4 py-2 text-sm font-medium text-ink-2 hover:bg-surface-2"
      :aria-expanded="open"
      data-testid="how-it-works-toggle"
      @click="open = !open"
    >
      How it works
      <svg class="h-3 w-3 transition-transform" :class="open ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <div v-if="open" class="flex flex-col gap-2 border-t border-line px-4 py-3 text-sm">
      <RouterLink v-if="aiRunId" :to="`/ai-lab/runs/${aiRunId}`" class="text-brand-ink hover:underline" data-testid="how-it-works-ai-run">
        AI Lab run<template v-if="recommendationSource === 'engine'"> — timed out; the dispatch rules made the recommendation</template>
      </RouterLink>
      <span v-else-if="recommendationSource === 'engine'" class="text-ink-3" data-testid="how-it-works-ai-run-engine">No AI run — the dispatch rules made this recommendation.</span>
      <span v-else class="text-ink-3" data-testid="how-it-works-ai-run-pending">AI Lab run (not started yet)</span>

      <RouterLink to="/cockpit" class="text-brand-ink hover:underline" data-testid="how-it-works-cockpit">Control Tower</RouterLink>
      <RouterLink to="/supply" class="text-brand-ink hover:underline" data-testid="how-it-works-supply">Driver Supply map</RouterLink>
      <RouterLink
        :to="agentTimelineLoadId ? `/cockpit?load=${agentTimelineLoadId}` : '/cockpit'"
        class="text-brand-ink hover:underline"
        data-testid="how-it-works-timeline"
      >
        Night Shift timeline
      </RouterLink>

      <div>
        <button
          type="button"
          class="text-xs font-semibold uppercase tracking-wide text-ink-3 hover:text-ink"
          :aria-expanded="logOpen"
          data-testid="how-it-works-log-toggle"
          @click="logOpen = !logOpen"
        >
          Technical log
        </button>
        <ul v-if="logOpen" class="mt-2 flex flex-col gap-1 font-mono text-xs text-ink-3" data-testid="how-it-works-log">
          <li v-if="log.length === 0" data-testid="how-it-works-log-empty">Nothing logged yet.</li>
          <li v-for="(entry, i) in log" :key="i" data-testid="how-it-works-log-entry">
            {{ formatTime(entry.atMs) }} · {{ entry.stage }} · {{ entry.text }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
