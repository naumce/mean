<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import DemoStatusLine from '../components/demo/DemoStatusLine.vue'
import HowItWorksLinks from '../components/demo/HowItWorksLinks.vue'
import StageCard from '../components/demo/StageCard.vue'
import StageRail from '../components/demo/StageRail.vue'
import { useDemoStore } from '../stores/demo'
import type { DemoActionKind, DemoStage } from '../types/demo'

// Demo Mode (2026-09-28 plan, Task 2): the presenter screen — one load
// walked end to end through the real systems, ten stages, one button at a
// time. Every store call lives here; StageRail/StageCard/DemoStatusLine/
// HowItWorksLinks are all presentational, so this is the one place that
// decides which store action a click maps to (spec: rail states, the right
// button per stage, the approve/reset/autoRun flows).
const demo = useDemoStore()

onMounted(async () => {
  // AppShell already probes on shell mount for nav visibility; this only
  // covers a direct visit or a test that mounts the view on its own.
  if (demo.available === null) await demo.probe()
  if (demo.available) {
    await demo.load()
    demo.startPolling()
  }
})
onBeforeUnmount(() => {
  demo.stopPolling()
})

const story = computed(() => demo.data?.story ?? null)
const DEFAULT_SIM = { running: false, speed: null, simNowMs: 0 }

// Task 6: "View agent activity" — a deep link into the Cockpit's AgentDrawer
// for this story's load, shown once there is a Night Shift story worth
// looking at (a driver is on the road or being supervised through an
// incident). Hidden before a driver is assigned (uncovered, driver
// recommendation, awaiting approval) and on the error stage, where there is
// nothing to show yet.
const AGENT_ACTIVITY_STAGES = new Set<DemoStage>([
  'in_transit', 'breakdown_detected', 'driver_contacted', 'awaiting_driver_reply',
  'escalated', 'awaiting_customer_update', 'customer_updated', 'resolved', 'delivering', 'delivered',
])
const showAgentActivity = computed(() => !!story.value && AGENT_ACTIVITY_STAGES.has(story.value.stage))
const agentTimelineHref = computed(() => {
  const loadId = demo.data?.links.agentTimelineLoadId ?? null
  return loadId ? `/cockpit?load=${loadId}` : '/cockpit'
})

async function onAct(payload: { kind: DemoActionKind; text?: string }): Promise<void> {
  switch (payload.kind) {
    case 'ask_ai':
      await demo.askAi()
      return
    case 'approve':
      await demo.approve()
      return
    case 'driver_reply':
      await demo.driverReply(payload.text ?? '')
      return
    case 'customer_update_sent':
      await demo.sendCustomerUpdate()
      return
    case 'resolve':
      await demo.resolve()
      return
    case 'skip_arrival':
      await demo.skipArrival()
      return
    case 'next':
      await demo.next()
  }
}

async function onReset(): Promise<void> {
  if (!window.confirm('Reset the demo? This starts the story over from an uncovered load.')) return
  await demo.reset()
}
</script>

<template>
  <div class="flex flex-col gap-6" data-testid="demo-view">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-ink">One load, end to end</h1>
        <p class="text-sm text-ink-2">A single load, walked through driver recommendation, human approval, a breakdown, and delivery — live, in the real systems.</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <RouterLink
          v-if="showAgentActivity"
          :to="agentTimelineHref"
          class="rounded-md border border-line px-3 py-1.5 text-sm font-semibold text-brand-ink hover:bg-surface-2"
          data-testid="demo-view-agent"
        >
          View agent activity
        </RouterLink>
        <button
          v-if="demo.available"
          type="button"
          class="rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-semibold text-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="demo.busy"
          data-testid="demo-reset"
          @click="onReset"
        >
          Reset Demo
        </button>
      </div>
    </div>

    <p v-if="demo.available === false" class="text-sm text-ink-3" data-testid="demo-unavailable">
      Demo mode is not enabled on this server.
    </p>

    <template v-if="demo.available">
      <p v-if="demo.error" class="text-sm text-red-600" role="alert" data-testid="demo-error">{{ demo.error }}</p>

      <div
        v-if="story?.stage === 'error'"
        class="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600"
        data-testid="demo-error-banner"
      >
        <p class="font-semibold" data-testid="demo-error-summary">The demo hit a problem. Press Reset Demo to start again.</p>
        <details class="mt-2 text-ink-3" data-testid="demo-error-details">
          <summary class="cursor-pointer text-sm">Technical details</summary>
          <p class="mt-1 text-sm">{{ story.error }}</p>
        </details>
      </div>

      <StageRail :stages="demo.presenterStages" />

      <label class="flex w-fit items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" :checked="demo.autoRun" data-testid="demo-autorun-toggle" @change="demo.toggleAutoRun()" />
        Auto-run
      </label>

      <StageCard
        :narration="demo.currentPresenterStage?.narration ?? null"
        :action="demo.actionForStage"
        :busy="demo.busy"
        :worker-configured="demo.data?.worker.configured ?? true"
        @act="onAct"
      />

      <DemoStatusLine
        v-if="story"
        :stage="story.stage"
        :waiting-on="demo.data?.waitingOn ?? null"
        :sim="demo.data?.sim ?? DEFAULT_SIM"
        :hold-started-at="story.holdStartedAt"
        :now-ms="Date.now()"
      />

      <HowItWorksLinks
        :ai-run-id="demo.data?.links.aiRunId ?? null"
        :agent-timeline-load-id="demo.data?.links.agentTimelineLoadId ?? null"
        :log="story?.log ?? []"
      />
    </template>
  </div>
</template>
