<script setup lang="ts">
import { computed } from 'vue'
import type { DemoSimInfo, DemoStage } from '../../types/demo'

// Demo Mode (2026-09-28 plan, Task 2; fix round 1): one sentence under the
// stage card translating `waitingOn` + `sim` (+ the dock-hold countdown)
// into plain language.
//
// `waitingOn` (fleet-backend/src/lib/demoStory/waitingOn.ts) names the
// PENDING HUMAN ACTION for the six stages that have one (ask_ai, approve,
// driver_reply, the customer-update pair, skip_arrival) and is null for
// every other stage — it is not a progress fraction, and nothing in the
// contract exposes one (no plannedStart/plannedEnd or ETA reaches this
// response). So: a non-null `waitingOn` means StageCard is already showing
// the one relevant button — this line stays silent rather than repeating
// that. A null `waitingOn` means the stage is genuinely automatic (an
// AI/engine run, Night Shift's own worker, the sim clock), which is where
// this sentence earns its keep.
const props = defineProps<{
  stage: DemoStage
  waitingOn: string | null
  sim: DemoSimInfo
  /** DemoStory.holdStartedAt (an ISO timestamp) — set once, when the story
   *  enters "delivering", and unchanged for the rest of the hold. Real
   *  wall-clock time, matching the backend's own 7-real-minute cap
   *  (observeDelivery.ts's ARRIVAL_WAIT_MS) — NOT sim time. */
  holdStartedAt: string | null
  /** The presenter's own "now", passed down fresh on every poll (DemoView
   *  reads Date.now() inline in its template) rather than read via
   *  Date.now() in here: `holdStartedAt` itself never changes for the whole
   *  hold, so a countdown driven only by prop changes would freeze at 7:00
   *  without some OTHER prop that genuinely differs every poll to trigger
   *  recomputation. */
  nowMs: number
}>()

const HOLD_WAIT_MS = 7 * 60_000

function formatCountdown(msLeft: number): string {
  const totalSeconds = Math.floor(Math.max(0, msLeft) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const message = computed<string | null>(() => {
  if (props.stage === 'delivering') {
    if (!props.holdStartedAt) return 'Holding at the dock so Night Shift records the arrival'
    const elapsedMs = props.nowMs - Date.parse(props.holdStartedAt)
    const left = formatCountdown(HOLD_WAIT_MS - elapsedMs)
    return `Holding at the dock so Night Shift records the arrival (${left} left)`
  }
  // Terminal — nothing left to wait on; delivered speaks for itself and the
  // error banner (DemoView) already owns the "error" stage's messaging.
  if (props.stage === 'delivered' || props.stage === 'error') return null
  // A human action is already the card's own button — no second line for it.
  if (props.waitingOn !== null) return null
  if (props.stage === 'ai_recommendation') return 'Deciding who should run this load'
  if (props.stage === 'in_transit' && props.sim.running) return 'Truck moving — Night Shift is watching for trouble'
  // Fix round 4, P14: the truck is moving again here, not waiting on a
  // check — the generic "waiting" sentence below was actively wrong for
  // this stage.
  if (props.stage === 'resolved') return 'Truck is moving again — heading to the dock'
  return "Waiting for Night Shift's next check — up to 60 seconds"
})
</script>

<template>
  <p v-if="message" class="text-sm text-ink-2" data-testid="demo-status-line">{{ message }}</p>
</template>
