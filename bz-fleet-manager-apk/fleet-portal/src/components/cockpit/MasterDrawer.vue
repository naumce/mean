<script setup lang="ts">
import { computed, ref } from 'vue'
import { equipClass, equipIcon, equipLabel } from '../../lib/cockpit/equipment'
import { fmtClock, fmtDT } from '../../lib/cockpit/format'
import { stepIndex, STEPS8 } from '../../lib/cockpit/lifecycle'
import { focusPointsForLoad, pingsByDriver } from '../../lib/cockpit/mapData'
import { stopEtas } from '../../lib/cockpit/stopEtas'
import { formatUsd } from '../../lib/money'
import { useCockpitStore } from '../../stores/cockpit'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'
import { useLoadLocksStore } from '../../stores/loadLocks'
import { useTrackingStore } from '../../stores/tracking'
import AgentPill from '../agent/AgentPill.vue'
import AgentSwitch from '../agent/AgentSwitch.vue'

// The Bertschi split-screen drawer: asset specs, milestones with ETAs,
// lifecycle, economics — all from the loadboard payload — plus the load's
// lifecycle actions. Those came over from the Slice-1 board when it was
// retired (2026-09-19): start / deliver / unassign / cancel / reopen, each
// one an existing loadboard-store action, so this panel is the one place a
// dispatcher acts on a load and there is no second set of rules.
const props = defineProps<{ load: BoardLoad | null; nowMs: number; tz: string }>()
const emit = defineEmits<{
  close: []
  /** Night Shift on the Board, Task 6: the AGENT pill in the Night Shift
   *  section was clicked. CockpitView already wires this same event from
   *  the brick (LegBrick -> GanttBoard -> CockpitView) to the AgentDrawer;
   *  this is the inspect panel's own copy of that same emit. */
  'open-agent': [loadId: string]
}>()
const ck = useCockpitStore()
const lb = useLoadboardStore()
const tracking = useTrackingStore()
const loadLocks = useLoadLocksStore()

// Night Shift on the Board, Task 6: same lock treatment BrokerGrid gives a
// locked row (spec §7.3) — the pill still shows, the switch does not
// respond while another dispatcher holds this load.
const lockedBy = computed(() => (props.load ? loadLocks.theirs[props.load.id]?.by ?? null : null))

// T2 "Map as Navigation", Task 5: the reverse of Task 4's map->board jump.
// This drawer is the natural home for it — unlike BrickPopover (a
// pointer-events-none hover card with no interactive elements at all, "Click
// to inspect" is its own hint that IT isn't where actions live), the drawer
// is already the persistent, click-opened, per-selection panel with its own
// close button, and it's already rendered across BOTH the board and radar
// views (see CockpitView.vue), so one button here can read the current view
// and offer the reverse of whichever one you're not on right now — no need
// for a second component to host the opposite direction.
//
// "Show on map" is disabled (never a silent no-op past the click, and never
// a jump to a default/invented coordinate) for a load with nothing to centre
// on — no geocoded stops AND no known driver position. Same invariant Task 3
// enforces for a no_gps driver marker; `focusPointsForLoad` is the one place
// that invariant is decided, shared with FleetMap's own centring.
const canFocusOnMap = computed(() => {
  if (!props.load) return false
  return focusPointsForLoad(props.load, lb.lanes, pingsByDriver(tracking.locations)).length > 0
})
function showOnMap(): void {
  if (props.load) ck.focusOnMap(props.load.id)
}
function showOnBoard(): void {
  if (props.load) ck.focusOnBoard(props.load.id)
}

// Night Shift on the Board, Task 6: the switch's own reload-on-conflict —
// same reasoning as BrokerGrid.vue's `onAgentStale`. A refused (409
// STALE_VERSION) flip leaves nothing to re-patch this load's row on its
// own (unlike a successful one, which the worker's `load_changed` frame
// already re-reads through this board's existing realtime path), so the
// switch's `stale` event re-requests exactly this load.
function onAgentStale(loadId: string): void {
  void lb.patchLoads([loadId])
}

const a = computed(() => props.load?.assignment ?? null)

// Lifecycle actions. Which ones show follows the record, not a menu: an
// assigned leg can start or be unassigned, a rolling one can be delivered,
// an open/tendered load can be canceled, a canceled one reopened. Every
// action is disabled while another dispatcher holds the load (same lock
// rule as the Night Shift switch above). `actionError` surfaces the store's
// own message — never a silent failed click.
const busy = ref(false)
const actionError = ref<string | null>(null)
const canStart = computed(() => a.value?.status === 'assigned')
const canDeliver = computed(() => a.value?.status === 'in_progress')
const canUnassign = computed(() => !!a.value && (a.value.status === 'assigned' || a.value.status === 'in_progress'))
const canCancel = computed(() => !a.value && (props.load?.status === 'open' || props.load?.status === 'tendered'))
const canReopen = computed(() => !a.value && props.load?.status === 'canceled')
const hasActions = computed(() => canStart.value || canDeliver.value || canUnassign.value || canCancel.value || canReopen.value)

async function runAction(action: () => Promise<boolean>): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = null
  try {
    const ok = await action()
    if (!ok) actionError.value = lb.error ?? 'That did not go through — the board was refreshed, try again.'
  } finally {
    busy.value = false
  }
}
function startTrip(): void {
  const cur = a.value
  if (cur) void runAction(() => lb.setAssignmentStatus(cur.id, 'in_progress'))
}
function deliver(): void {
  const cur = a.value
  if (cur) void runAction(() => lb.setAssignmentStatus(cur.id, 'completed'))
}
function unassign(): void {
  const cur = a.value
  if (cur) void runAction(() => lb.unassign(cur.id))
}
function cancelLoad(): void {
  const id = props.load?.id
  if (id) void runAction(() => lb.cancelLoad(id))
}
function reopenLoad(): void {
  const id = props.load?.id
  if (id) void runAction(() => lb.reopenLoad(id))
}
const driver = computed(() => lb.lanes.find((d) => d.id === a.value?.driverId) ?? null)
const tractor = computed(() => lb.tractors.find((t) => t.id === a.value?.tractorId) ?? null)
const trailer = computed(() => lb.trailers.find((t) => t.id === a.value?.trailerId) ?? null)
const status = computed(() => a.value?.status ?? props.load?.status ?? 'open')
const step = computed(() => stepIndex(status.value, a.value ? Date.parse(a.value.plannedStart) : null, props.nowMs))
// ETAs are the planned window redistributed by real leg distance and dwell
// (lib/cockpit/stopEtas) — an interpolation, hedged with "~" in the template,
// never a routed arrival time.
const milestones = computed(() => {
  const l = props.load
  if (!l?.stops?.length) return []
  const n = l.stops.length
  const start = a.value ? Date.parse(a.value.plannedStart) : null
  const etas = start != null ? stopEtas(l.stops, start, Date.parse(a.value!.plannedEnd)) : []
  return l.stops.map((s, i) => ({ s, role: i === 0 ? 'PICKUP' : i === n - 1 ? 'DROP' : `STOP ${i + 1}`, eta: etas[i] ?? null }))
})
// The committed rate snapshot, or nothing. Cost is read from the snapshot, not
// derived as revenue − margin: an unpriced load used to render "-$740 cost".
const econ = computed(() => a.value?.economics ?? null)
const rpm = computed(() => (props.load && a.value?.loadedMi ? props.load.revenueCents / a.value.loadedMi / 100 : null))
</script>

<template>
  <aside class="sticky top-[64px] flex max-h-[calc(100vh-80px)] w-[400px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" data-testid="drawer">
    <div class="flex-1 overflow-y-auto p-3 font-mono text-xs">
      <template v-if="!load">
        <div class="flex items-center justify-between border-b border-line pb-3"><span class="text-xs font-bold text-ink">MASTER DRAWER</span><span class="rounded bg-surface-3 px-1.5 text-[9px] text-ink-3">IDLE</span></div>
        <div class="mt-3 text-[11px] leading-relaxed text-ink-3">Click any leg brick to inspect it.<br /><br />• Spot search highlights matches across the board<br />• Hover a brick for its facts<br />• The bell keeps every live event</div>
        <div class="mt-4 rounded-lg border border-line bg-surface-3 p-2.5 text-[10px] text-ink-3">
          <div class="mb-1 text-[9px] font-bold uppercase tracking-wider">Latest activity</div>
          <div v-for="it in ck.activity.slice(0, 5)" :key="it.id" class="truncate"><span class="text-ink-2">{{ it.title }}</span> <span class="text-ink-3">· {{ it.sub }}</span></div>
          <div v-if="!ck.activity.length">—</div>
        </div>
      </template>

      <template v-else>
        <div class="flex items-center justify-between border-b border-line pb-3">
          <div class="flex min-w-0 items-center gap-2"><span class="text-xs font-bold text-ink">INSPECT: LEG {{ load.reference }}</span></div>
          <button type="button" class="text-xs text-ink-3 hover:text-ink" data-testid="drawer-close" @click="emit('close')">✕</button>
        </div>
        <!-- T2 "Map as Navigation", Task 5: the reverse of whichever jump got
             you here — "Show on map" on the board, "Show on board" once
             you're already on the map (Task 4's focusOnBoard). -->
        <button
          v-if="ck.view === 'board'"
          type="button"
          class="mt-2 w-full rounded border border-brand bg-brand/20 px-2 py-1.5 text-[10px] font-bold text-brand-ink hover:bg-brand/30 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-3 disabled:hover:bg-transparent"
          data-testid="drawer-show-on-map"
          :disabled="!canFocusOnMap"
          :title="canFocusOnMap ? '' : 'No geocoded stops or known position for this load yet'"
          @click="showOnMap"
        >
          Show on map →
        </button>
        <button
          v-else
          type="button"
          class="mt-2 w-full rounded border border-brand bg-brand/20 px-2 py-1.5 text-[10px] font-bold text-brand-ink hover:bg-brand/30"
          data-testid="drawer-show-on-board"
          @click="showOnBoard"
        >
          Show on board →
        </button>
        <div class="mt-2.5">
          <div class="truncate text-sm font-bold text-ink">{{ load.origin }} ➔ {{ load.destination }}</div>
          <div class="text-[10px] text-ink-3">{{ load.brokerName ?? '' }}{{ load.commodity ? ' · ' + load.commodity : '' }}{{ load.weightLbs ? ' · ' + load.weightLbs.toLocaleString() + ' lbs' : '' }}</div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span class="rounded border px-1.5 py-0.5 text-[9px] font-black uppercase text-ink-2">{{ status }}</span>
            <span class="rounded px-1.5 py-0.5 text-[9px]" :class="equipClass(load.requiredEquip)">{{ equipIcon(load.requiredEquip) }} {{ equipLabel(load.requiredEquip) }}</span>
            <span v-if="load.hazmatClass" class="rounded border border-haz/40 bg-haz/20 px-1.5 py-0.5 text-[9px] font-black text-haz">⬧ HAZMAT {{ load.hazmatClass }}</span>
          </div>
        </div>

        <!-- Night Shift on the Board, Task 6 (spec §8): the pill, the switch,
             and a click-through to the drawer another implementer owns —
             this section never opens that drawer itself. -->
        <section class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5" data-testid="drawer-night-shift">
          <div class="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-3">
            <span>Night shift</span>
            <AgentPill :pill="load.agentPill" :line="load.agentLine ?? null" :load-id="load.id" @open-agent="emit('open-agent', $event)" />
          </div>
          <div class="mt-2 flex items-center justify-between">
            <span class="text-[10px] text-ink-3">{{ load.agentEnabled ? 'Watching this load' : 'Not watching this load' }}</span>
            <AgentSwitch :load="{ ...load, version: load.version ?? 0 }" :disabled="!!lockedBy" @stale="onAgentStale(load.id)" />
          </div>
          <div v-if="lockedBy" class="mt-1 text-[9px] text-ink-3">{{ lockedBy }} is editing this load on Their Board</div>
        </section>

        <section v-if="hasActions" class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5" data-testid="drawer-actions">
          <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Actions</div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button v-if="canStart" type="button" class="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50" :disabled="busy || !!lockedBy" data-testid="action-start" @click="startTrip">▶ Start trip</button>
            <button v-if="canDeliver" type="button" class="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50" :disabled="busy || !!lockedBy" data-testid="action-deliver" @click="deliver">✓ Delivered</button>
            <button v-if="canUnassign" type="button" class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-500 hover:bg-amber-500/20 disabled:opacity-50" :disabled="busy || !!lockedBy" data-testid="action-unassign" @click="unassign">Unassign</button>
            <button v-if="canCancel" type="button" class="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] font-bold text-red-500 hover:bg-red-500/20 disabled:opacity-50" :disabled="busy || !!lockedBy" data-testid="action-cancel" @click="cancelLoad">Cancel load</button>
            <button v-if="canReopen" type="button" class="rounded border border-brand/40 bg-brand/10 px-2 py-1 text-[10px] font-bold text-brand-ink hover:bg-brand/20 disabled:opacity-50" :disabled="busy || !!lockedBy" data-testid="action-reopen" @click="reopenLoad">Reopen</button>
          </div>
          <div v-if="actionError" class="mt-1.5 text-[10px] text-red-500" data-testid="action-error">{{ actionError }}</div>
        </section>

        <section class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5">
          <div class="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-3"><span>Lifecycle</span><span class="text-brand-ink">{{ STEPS8[step] }}</span></div>
          <div class="mt-2 flex">
            <div v-for="(s, i) in STEPS8" :key="s" class="flex-1 text-center">
              <div class="mx-auto h-3.5 w-3.5 rounded-full border-2" :class="i < step ? 'border-emerald-500 bg-emerald-500' : i === step ? 'border-brand bg-brand ring-4 ring-brand/30' : 'border-line-strong bg-surface-3'" />
              <div class="mt-1 whitespace-nowrap text-[8px]" :class="i === step ? 'font-bold text-brand-ink' : 'text-ink-3'">{{ s }}</div>
            </div>
          </div>
        </section>

        <section class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5">
          <div class="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-3"><span>Physical Asset Specs</span><span :class="trailer ? 'text-emerald-500' : 'text-amber-500'">{{ trailer ? 'Active Hooked' : 'No trailer' }}</span></div>
          <div class="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            <div><span class="text-ink-3">Tractor:</span><div class="font-bold text-ink">{{ tractor ? `#${tractor.unit} ${tractor.cab}` : '— bobtail —' }}</div><div class="text-[9px] text-ink-3">{{ tractor?.make ?? '' }}</div></div>
            <div><span class="text-ink-3">Trailer:</span><div class="font-bold text-ink">{{ trailer ? `${trailer.unit} ${trailer.length ?? ''} ${trailer.type}` : '— none —' }}</div><div class="text-[9px] text-ink-3">{{ trailer?.features ?? '' }}</div></div>
          </div>
          <div v-if="driver" class="mt-2 text-[10px] text-ink-3">Driver {{ driver.name }}{{ driver.hazmatEndorsed ? ' · ☣ endorsed' : '' }}{{ driver.lastCity ? ' · 📍 ' + driver.lastCity : '' }}</div>
        </section>

        <section class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5">
          <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Route Milestones</div>
          <div class="mt-2 flex flex-col gap-2">
            <div v-for="m in milestones" :key="m.s.sequence" class="flex items-start gap-2">
              <span class="w-16 shrink-0 text-[10px] font-bold" :class="m.role === 'PICKUP' ? 'text-emerald-500' : m.role === 'DROP' ? 'text-blue-500' : 'text-ink-3'">{{ m.s.sequence }}. {{ m.role }}</span>
              <div class="min-w-0"><div class="truncate font-bold text-ink">{{ m.s.address }}</div><div class="text-[10px] text-ink-3">{{ m.eta != null ? 'ETA ~' + fmtDT(m.eta, tz) : 'unscheduled' }}{{ m.s.windowEnd ? ' · by ' + fmtDT(Date.parse(m.s.windowEnd), tz) : '' }}</div></div>
            </div>
            <div v-if="!milestones.length" class="text-[10px] text-ink-3">{{ load.stopCount }} stops · detail not loaded</div>
          </div>
        </section>

        <section class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5">
          <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Economics (committed snapshot)</div>
          <div class="mt-2 flex flex-col gap-1 text-[11px]">
            <div class="flex justify-between"><span class="text-ink-3">Gross Linehaul + FSC:</span><span class="font-bold text-ink">{{ formatUsd(load.revenueCents) }}</span></div>
            <div class="flex justify-between" data-testid="drawer-cost"><span class="text-ink-3">Est. cost{{ a?.loadedMi ? ` (${Math.round((a.deadheadMi ?? 0) + a.loadedMi)} mi)` : '' }}:</span><span v-if="econ" class="font-bold text-red-500">-{{ formatUsd(econ.estCostCents) }}</span><span v-else class="text-ink-3">—</span></div>
            <div v-if="econ" class="mt-1 flex justify-between border-t border-line pt-1 font-bold" data-testid="drawer-profit"><span :class="econ.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500'">Net Estimated Profit:</span><span :class="econ.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500'">{{ econ.marginCents >= 0 ? '+' : '' }}{{ formatUsd(econ.marginCents) }}<template v-if="load.revenueCents"> ({{ Math.round((econ.marginCents / load.revenueCents) * 100) }}%)</template></span></div>
            <div v-else class="mt-1 flex justify-between border-t border-line pt-1" data-testid="drawer-profit"><span class="text-ink-3">Net Estimated Profit:</span><span class="text-ink-3">— not priced</span></div>
            <div v-if="rpm != null" class="flex justify-between text-[10px] text-ink-3"><span>${{ rpm.toFixed(2) }}/loaded mi</span><span v-if="a?.savedMi">+{{ Math.round(a.savedMi) }} empty mi avoided</span></div>
            <div v-if="a" class="text-[10px] text-ink-3">{{ fmtClock(Date.parse(a.plannedStart), tz) }} – {{ fmtClock(Date.parse(a.plannedEnd), tz) }}</div>
          </div>
        </section>
      </template>
    </div>
  </aside>
</template>
