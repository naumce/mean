<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import AgentDrawer from '../components/agent/AgentDrawer.vue'
import ActivityPanel from '../components/cockpit/ActivityPanel.vue'
import BacklogPanel from '../components/cockpit/BacklogPanel.vue'
import BoardLegend from '../components/cockpit/BoardLegend.vue'
import BrickPopover from '../components/cockpit/BrickPopover.vue'
import CockpitHeader from '../components/cockpit/CockpitHeader.vue'
import CockpitToolbar from '../components/cockpit/CockpitToolbar.vue'
import DetentionPanel from '../components/cockpit/DetentionPanel.vue'
import GanttBoard from '../components/cockpit/GanttBoard.vue'
import MasterDrawer from '../components/cockpit/MasterDrawer.vue'
import SuggestModal from '../components/cockpit/SuggestModal.vue'
import PlanVerdictModal from '../components/cockpit/PlanVerdictModal.vue'
import ToastStack from '../components/cockpit/ToastStack.vue'
import YardChips from '../components/cockpit/YardChips.vue'
import RadarView from '../components/cockpit/views/RadarView.vue'
import { timeToX } from '../lib/cockpit/geometry'
import { useAuthStore } from '../stores/auth'
import { useCarriersStore } from '../stores/carriers'
import { useCockpitStore } from '../stores/cockpit'
import { useEconomicsStore } from '../stores/economics'
import { useFleetStore } from '../stores/fleet'
import { useLoadboardStore } from '../stores/loadboard'
import { useLocksStore } from '../stores/locks'
import { useLoadLocksStore } from '../stores/loadLocks'
import { useTrackingStore } from '../stores/tracking'

// The cockpit route. Owns the clock, the realtime → activity bridge, hotkeys
// and selection; everything else is composed from the cockpit components.
const ck = useCockpitStore()

const lb = useLoadboardStore()

// ⚡Suggest — the ranking engine, reachable from the cockpit at last.
const suggestLoadId = ref<string | null>(null)
const suggestDispatching = ref<string | null>(null)
const suggestLoad = computed(() => lb.loads.find((l) => l.id === suggestLoadId.value) ?? null)

async function openSuggest(loadId: string): Promise<void> {
  suggestLoadId.value = loadId
  await lb.suggestFor(loadId)
}

/** Dispatching a suggestion goes through `ck.dropLoad` — the SAME action a
 *  drag uses, which runs lock -> dry-run -> verdict modal on a block -> commit.
 *  A second route to the same write would be a second set of rules about when a
 *  dispatch is allowed, and they would drift. */
async function dispatchSuggested(p: { driverId: string; tractorId: string; trailerId: string }): Promise<void> {
  const loadId = suggestLoadId.value
  if (!loadId) return
  suggestDispatching.value = p.driverId
  try {
    await ck.dropLoad(p.driverId, { loadId, driverId: p.driverId, tractorId: p.tractorId, trailerId: p.trailerId })
    await lb.load()
    suggestLoadId.value = null
  } finally {
    suggestDispatching.value = null
  }
}
const carriers = useCarriersStore()
const fleet = useFleetStore()
const tracking = useTrackingStore()
const econ = useEconomicsStore()
const auth = useAuthStore()
const locks = useLocksStore()
const loadLocks = useLoadLocksStore()
const router = useRouter()

const nowMs = ref(Date.now())
const activityOpen = ref(false)
const hover = ref<{ loadId: string | null; el: HTMLElement | null }>({ loadId: null, el: null })
let clock: number | undefined

const selected = computed(() => lb.loads.find((l) => l.id === ck.selectedLoadId) ?? null)
const hoverLoad = computed(() => lb.loads.find((l) => l.id === hover.value.loadId) ?? null)
const spotted = computed(() => (ck.search.trim() ? ck.lanes.reduce((n, ln) => n + ln.legs.filter((l) => ck.matchesSearch(l, ln.name)).length, 0) : 0))

function onOpenDriver(driverId: string): void {
  const lane = ck.lanes.find((l) => l.id === driverId)
  const cur = lane?.legs.find((l) => l.assignment?.status === 'in_progress') ?? lane?.legs[0]
  if (cur) ck.select(cur.id)
}
/** Closing the drawer — the ✕ button or Escape — is the one place a lane
 *  hold from this view is known to be done with. `locks.release()` is
 *  idempotent (a no-op when nothing is held), so calling it here even when
 *  no gesture ever acquired anything is always safe. */
function closeDrawer(): void {
  ck.select(null)
  locks.release()
}

// Cockpit S2b Task 4 wiring: GanttBoard's gesture-* events funnel into the
// shared pipeline (stores/cockpit.ts's runGesture) via planLeg/dropLoad, so
// drop, move and resize all go through the same acquire→dry-run→commit path
// regardless of which gesture triggered them.
interface GestureMovePayload { loadId: string; assignmentId: string; driverId: string; availableAt: number }
interface GestureResizePayload { loadId: string; assignmentId: string; plannedEnd?: number; availableAt?: number }
interface GestureDropPayload { loadId: string; driverId: string; availableAt: number }
interface GesturePairPayload { driverId: string; tractorId?: string; trailerId?: string }

async function onGestureMove(e: GestureMovePayload): Promise<void> {
  // The lane is the drop target (e.driverId) — a move can carry a leg onto a
  // different driver's row, and it's that lane's lock the pipeline needs.
  await ck.planLeg(e.assignmentId, e.driverId, e.loadId, { driverId: e.driverId, availableAt: e.availableAt })
}
async function onGestureResize(e: GestureResizePayload): Promise<void> {
  // A resize never changes lanes, and the event carries no driverId — read
  // it off the leg's current assignment instead.
  const laneId = lb.loads.find((l) => l.id === e.loadId)?.assignment?.driverId
  if (!laneId) return
  await ck.planLeg(e.assignmentId, laneId, e.loadId, { plannedEnd: e.plannedEnd, availableAt: e.availableAt })
}
async function onGestureDrop(e: GestureDropPayload): Promise<void> {
  // The read model exposes the driver's current (or, absent that, default)
  // pairing — a drop can't invent equipment the driver doesn't have, and
  // sending a request without it would just 422. Refuse locally instead.
  const driver = lb.lanes.find((d) => d.id === e.driverId)
  const tractorId = driver?.currentTractorId ?? driver?.defaultTractorId ?? null
  const trailerId = driver?.currentTrailerId ?? driver?.defaultTrailerId ?? null
  if (!tractorId || !trailerId) {
    ck.pushActivity('conflict', 'No equipment paired', `${driver?.name ?? 'This driver'} has no tractor/trailer hooked — pair equipment before assigning a load.`, e.loadId)
    return
  }
  await ck.dropLoad(e.driverId, { loadId: e.loadId, driverId: e.driverId, tractorId, trailerId, availableAt: e.availableAt })
}
async function onGesturePair(e: GesturePairPayload): Promise<void> {
  // The chip names exactly one side (tractorId XOR trailerId) — pass both
  // through as-is so the unnamed side stays `undefined` and is omitted from
  // the request body, leaving that side of the pairing untouched server-side.
  await ck.pairUnit(e.driverId, { tractorId: e.tractorId, trailerId: e.trailerId })
}
// Night Shift on the Board (Task 7): the drawer, mounted once here too.
// Opened by the pill's `open-agent`, which bubbles LegBrick -> GanttBoard ->
// here (GanttBoard's own passthrough, added alongside its existing
// `open`/`hover` bubbling — LegBrick's own emit is the other implementer's).
// Header fields come straight off this board's own BoardLoad.
const agentDrawerLoadId = ref<string | null>(null)
const agentDrawerLoad = computed(() => lb.loads.find((l) => l.id === agentDrawerLoadId.value) ?? null)

function jumpTo(loadId: string): void {
  // T2 "Map as Navigation", Task 4: this exact select+switch-view+scroll
  // sequence now lives on the store itself (`focusOnBoard`) so a map popup
  // nested under FleetMap can call it directly — this wrapper just keeps the
  // radar/activity/toast callers below reading naturally as "jump".
  ck.focusOnBoard(loadId)
}
function jumpNow(): void {
  const x = timeToX(nowMs.value, ck.config)
  const scroller = document.querySelector<HTMLElement>('[data-testid="board-scroll"]')
  if (x !== null && scroller) scroller.scrollTo({ left: Math.max(0, x - 200), behavior: 'smooth' })
}
function onKey(e: KeyboardEvent): void {
  const typing = /INPUT|SELECT|TEXTAREA/.test((document.activeElement as HTMLElement | null)?.tagName ?? '')
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    const el = document.getElementById('spotInput') as HTMLInputElement | null
    el?.focus()
    el?.select()
  } else if (e.key === 'Escape') {
    activityOpen.value = false
    closeDrawer()
    if (typing) (document.activeElement as HTMLElement).blur()
  } else if (e.key === ' ' && !typing) {
    e.preventDefault()
    ck.setView('board')
    jumpNow()
  }
}

onMounted(async () => {
  ck.init(auth.org?.timezone ?? null)
  window.addEventListener('keydown', onKey)
  clock = window.setInterval(() => { nowMs.value = Date.now() }, 30_000)
  await Promise.all([ck.reload(), lb.loadAlerts(), lb.loadYard(), lb.loadRisk(), fleet.loadDigest(), tracking.listLocations(), econ.loadCostModel(), carriers.load()])
  lb.connectRealtime()
  tracking.connectRealtime()
  ck.connectRealtime()
  requestAnimationFrame(jumpNow)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  if (clock !== undefined) window.clearInterval(clock)
  lb.disconnectRealtime()
  tracking.disconnectRealtime()
  ck.disconnectRealtime()
  lb.setWindowOverride(null)
  // Leak hazard (S1's review caught this class of bug here before): a lane
  // hold left running past unmount keeps it locked for every other
  // dispatcher until the server's TTL. release() is idempotent, so this is
  // safe even when nothing is held.
  locks.release()
  // F9: the same leak, for LOAD locks. A gesture holds the load it is moving
  // (stores/cockpit.ts) and a view torn down mid-verdict never reaches the
  // settle — the row on Their Board would stay badged until the TTL.
  loadLocks.releaseAll()
  clearCockpitScopedState()
})
// SPA navigation away from /cockpit (no full unmount if a parent keeps the
// route tree alive) is the other way a hold can outlive the view — the same
// leak, a different exit.
onBeforeRouteLeave(() => {
  locks.release()
  loadLocks.releaseAll()
  clearCockpitScopedState()
})

/** The carrier filter is a COCKPIT control — it lives in CockpitToolbar and
 *  there is nowhere else to see or clear it. But the carriers and loadboard
 *  stores are shared with every other screen that reads them, so leaving a
 *  selection behind would silently narrow what those screens show with no
 *  indication there that a filter is even active: a dispatcher would see
 *  trucks missing and no reason why. (The Slice-1 board this first bit was
 *  retired 2026-09-19; the rule stands for whatever reads the store next.)
 *
 *  Scoping it to the view that owns the control is the honest fix. If a
 *  fleet-wide "working carrier" is ever wanted, it needs a global indicator
 *  first — a filter you cannot see is a filter you cannot trust. */
function clearCockpitScopedState(): void {
  if (carriers.selectedCarrierId !== null) {
    carriers.select(null)
    void lb.load()
    void lb.loadYard()
  }
}
</script>

<template>
  <div class="-m-4 flex min-h-screen flex-col bg-bg text-ink sm:-m-6">
    <CockpitHeader :now-ms="nowMs" :spotted="spotted" @toggle-activity="activityOpen = !activityOpen" @messages="router.push('/messages')" />
    <CockpitToolbar v-if="ck.view === 'board'" @jump-now="jumpNow" @open-fleet="router.push('/fleet')" />

    <div class="flex w-full items-start gap-3 p-3">
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <template v-if="ck.view === 'board'">
          <GanttBoard
            :now-ms="nowMs"
            @open="ck.select($event)"
            @open-driver="onOpenDriver"
            @hover="(id, el) => (hover = { loadId: id, el })"
            @gesture-move="onGestureMove"
            @gesture-resize="onGestureResize"
            @gesture-drop="onGestureDrop"
            @gesture-pair="onGesturePair"
            @open-agent="agentDrawerLoadId = $event"
          />
          <div class="grid grid-cols-1 gap-3 xl:grid-cols-[1.25fr_1fr]">
            <BacklogPanel :now-ms="nowMs" @open="ck.select($event)" @suggest="openSuggest" />
            <YardChips />
          </div>
          <DetentionPanel />
          <BoardLegend />
          <SuggestModal
    v-if="suggestLoadId"
    :result="lb.suggest"
    :load-reference="suggestLoad?.reference ?? ''"
    :lane="suggestLoad ? `${suggestLoad.origin} ➔ ${suggestLoad.destination}` : ''"
    :revenue-cents="suggestLoad?.revenueCents ?? 0"
    :loading="lb.suggestLoading"
    :dispatching="suggestDispatching"
    @dispatch="dispatchSuggested"
    @close="suggestLoadId = null"
  />
</template>
        <RadarView v-else-if="ck.view === 'radar'" :now-ms="nowMs" @open="jumpTo" />
      </div>
      <MasterDrawer v-if="ck.view === 'board' || ck.view === 'radar'" :load="selected" :now-ms="nowMs" :tz="ck.tz" @close="closeDrawer" @open-agent="agentDrawerLoadId = $event" />
    </div>

    <BrickPopover :load="hoverLoad" :anchor="hover.el" :tz="ck.tz" :now-ms="nowMs" />
    <ActivityPanel :open="activityOpen" @close="activityOpen = false" @jump="jumpTo" />
    <ToastStack @jump="jumpTo" />
    <PlanVerdictModal :verdict="ck.verdict" :tz="ck.tz" @cancel="ck.cancelVerdict()" @force="ck.forceVerdict()" />

    <!-- Night Shift on the Board (spec §6.4): slides in from the right, the board stays visible underneath it. -->
    <AgentDrawer
      :load-id="agentDrawerLoadId"
      :load-no="agentDrawerLoad?.boardLoadNo || agentDrawerLoad?.reference || null"
      :customer-name="agentDrawerLoad?.customerName ?? null"
      :carrier-name="agentDrawerLoad?.carrierName ?? null"
      :carrier-mc="agentDrawerLoad?.carrierMc ?? null"
      @close="agentDrawerLoadId = null"
    />
  </div>
</template>
