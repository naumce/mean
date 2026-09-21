<script setup lang="ts">
import { computed } from 'vue'
import type { BreakPlanEntry, FuelAdvice, FuelPlanBody, StopDetention } from '../../lib/api'
import { equipClass, equipIcon, equipLabel } from '../../lib/cockpit/equipment'
import { fmtClock } from '../../lib/cockpit/format'
import { progressShare, stepSegs, STEP_TITLES } from '../../lib/cockpit/lifecycle'
import { formatUsd } from '../../lib/money'
import type { BoardLoad } from '../../stores/loadboard'
import AgentPill from '../agent/AgentPill.vue'

// One leg on the time axis. Every tag is a real flag the parent derived from
// API data (engine conflicts, live risk, equipment mismatch, registration).
const props = withDefaults(
  defineProps<{
    load: BoardLoad
    x: number
    w: number
    tz: string
    nowMs: number
    deadheadPx?: number
    spotted?: boolean
    dimmed?: boolean
    selected?: boolean
    conflict?: boolean
    mismatch?: boolean
    hazIssue?: boolean
    regExpired?: boolean
    risk?: 'warn' | 'block' | null
    marginView?: boolean
    hazLoud?: boolean
    /** Plan A3 (spec §8.3): this leg has no assignment of ours — it runs on a
     *  carrier's own truck, placed (or not) purely from Their Board's data.
     *  `unplaced` is the narrower case: no assignment AND `spanOf` could find
     *  no appointment window to place it by, so the brick pins to the lane's
     *  left edge and reads its Attention instead of a route. */
    brokered?: boolean
    unplaced?: boolean
    /** T3 Break and Rest Planning, Task 9 (Ruling 8): this load's slice of
     *  `stores/cockpit.ts`'s `breakPlanByLoadId` — the SAME data the live
     *  map's break marker layer reads (`lib/cockpit/mapData.ts`'s
     *  `breakMarkers`), handed down by GanttBoard rather than looked up
     *  here, matching every other derived flag on this brick (`conflict`,
     *  `risk`, `mismatch`…) which is also computed by the parent and passed
     *  in, not re-derived from a store inside this presentational
     *  component. `needsBreak` does NOT exist on `BoardLoad`/`load` — the
     *  loadboard payload never carried it (checked dispatcherLoadboard.ts
     *  and this portal's own dispatcher types) — so this prop is the only
     *  honest source: one absence rule, on both surfaces. `undefined`
     *  (never evaluated this session) and `known: false` (HOS never
     *  imported) both mean no glyph, exactly like `breakMarkers` produces
     *  no marker for either case. */
    breakPlan?: { entries: BreakPlanEntry[]; known: boolean }
    /** T4 Fuel and Stops, Task 9: this load's slice of `stores/cockpit.ts`'s
     *  `fuelPlanByLoadId`, handed down by GanttBoard exactly like `breakPlan`
     *  above — the SAME prop-down, presentational-brick shape, one reader
     *  per surface. `undefined` (never evaluated this session), `known:
     *  false` (no mpg on file) and `advice: null` (burn known, but no
     *  cheaper stop worth naming) all mean no chip — absence claims nothing,
     *  never a fabricated "$0 saved". */
    fuelPlan?: FuelPlanBody
    /** T5 Dwell and Detention, Task 8: this load's detention row, handed
     *  down by GanttBoard from its own `detentionByLoadId` computed — a
     *  derived index over the store's flat `detention.items` (there is no
     *  keyed map on the store for this one; see GanttBoard.vue's doc for
     *  why, and for the multi-claim rule when a load has several billable
     *  stops). Same one-reader-per-surface shape as `breakPlan`/`fuelPlan`
     *  above. `undefined` (no detention row for this load) and a row with
     *  `claim: null` (a real dwell nobody could bill, so it is not money
     *  owed — Global Constraint 1) both mean no marker. This component
     *  re-checks `claim` itself rather than trusting the caller to have
     *  already filtered, matching the defensive guards `breakEntries` and
     *  `fuelAdvice` run below for their own props. */
    detention?: StopDetention
    /** A4 Task 8: who else is editing this load right now, if anyone —
     *  handed down by GanttBoard from `useLoadLocksStore().theirs`, the one
     *  source of lock truth (see that store's own doc comment). Informational,
     *  not a barrier: the server already refuses this brick's own writes
     *  while someone else holds the lock (A2's `runGesture`), so this only
     *  names them — a brick that silently stopped responding would read as a
     *  bug, not as someone else's edit. Renders at every brick width,
     *  including the 96px unplaced width — the same lesson A3 Task 6 learned
     *  the hard way when the carrier-name badge was gated behind the `mid`
     *  (110px) tier and never showed on an unplaced brick. */
    lockedBy?: string | null
  }>(),
  { deadheadPx: 0, spotted: false, dimmed: false, selected: false, conflict: false, mismatch: false, hazIssue: false, regExpired: false, risk: null, marginView: false, hazLoud: false, brokered: false, unplaced: false, lockedBy: null },
)
const emit = defineEmits<{
  open: [loadId: string]
  hover: [loadId: string | null, el: HTMLElement | null]
  /** Night Shift on the Board, Task 6: the AGENT pill was clicked. Another
   *  implementer's drawer listens for this further up (CockpitView.vue,
   *  through GanttBoard.vue's relay); this brick only names the load. */
  'open-agent': [loadId: string]
}>()

const a = computed(() => props.load.assignment)
const status = computed(() => a.value?.status ?? props.load.status)
const done = computed(() => status.value === 'completed' || status.value === 'delivered')
const wide = computed(() => props.w >= 230)
const mid = computed(() => props.w >= 110)
const segs = computed(() => stepSegs(status.value))
const startMs = computed(() => (a.value ? Date.parse(a.value.plannedStart) : 0))
const endMs = computed(() => (a.value ? Date.parse(a.value.plannedEnd) : 0))
// A brokered leg has no assignment of ours, so startMs/endMs are both 0 —
// progressShare('in_progress', 0, 0, now) reads that zero-width window as
// "elapsed" and returns 1, drawing a full bar for a truck we have no GPS on
// at all (spec §8.4). No assignment, no progress claim.
const progress = computed(() => (a.value ? progressShare(status.value, startMs.value, endMs.value, props.nowMs) : 0))
// Economics come from the committed rate snapshot, or not at all. A load that
// was never priced has no margin to show and no margin colour to earn — it is
// not a $0 margin and it is certainly not a loss.
const econ = computed(() => a.value?.economics ?? null)
const marginPct = computed<number | null>(() =>
  econ.value && props.load.revenueCents ? econ.value.marginCents / props.load.revenueCents : null,
)
const rpm = computed(() => (a.value?.loadedMi ? props.load.revenueCents / a.value.loadedMi / 100 : null))

/** T3 Break and Rest Planning, Task 9 (Ruling 8): `[]` whenever there is no
 *  cached plan for this load OR it is `known: false` — one guard covers both
 *  "no glyph" cases from the brief, the same fold `breakMarkers` does for
 *  the map. A plan that genuinely needs no break also carries an empty
 *  `entries` array, so `hasBreak` below needs no separate check for that
 *  case either. */
const breakEntries = computed<BreakPlanEntry[]>(() => (props.breakPlan?.known ? props.breakPlan.entries : []))
const hasBreak = computed(() => breakEntries.value.length > 0)
/** The first mandatory break point's time, `≈`-prefixed when it's an
 *  estimate (Global Constraint 7) — a load needing more than one break still
 *  gets one glyph, naming the soonest stop, not a list none of this brick's
 *  widths has room for. */
const breakTooltip = computed(() => {
  const first = breakEntries.value[0]
  if (!first) return ''
  const time = fmtClock(first.atMs, props.tz)
  return `Mandatory break · ${first.precision === 'estimated' ? '≈' : ''}${time}`
})

/** T4 Fuel and Stops, Task 9: `null` whenever there is no cached fuel plan
 *  for this load, OR it is `known: false`, OR the engine found nowhere
 *  cheaper worth naming (`advice: null`) — three ways to reach "no chip",
 *  folded into one guard the same way `breakEntries` folds its own two. */
const fuelAdvice = computed<FuelAdvice | null>(() => (props.fuelPlan?.known ? props.fuelPlan.advice : null))

/** T5 Dwell and Detention, Task 8: `null` whenever there is no detention row
 *  for this load, OR the row's `claim` is null — a real dwell we could not
 *  honestly bill is not money owed (Global Constraint 1), so it earns no
 *  marker, same absence rule as `breakEntries`/`fuelAdvice` above. */
const detentionClaim = computed(() => props.detention?.claim ?? null)

const STATUS_CLASS: Record<string, string> = {
  assigned: 'bg-s-assigned/15 border-s-assigned/60',
  tendered: 'bg-s-tendered/15 border-s-tendered/70 border-dashed',
  in_progress: 'bg-s-progress/15 border-s-progress/70',
  completed: 'bg-s-completed/15 border-s-completed/50',
  delivered: 'bg-s-completed/15 border-s-completed/50',
}
// The border/background channel can only show one override at a time — a
// conflicted+mismatched load must not leave the winner to Tailwind's
// stylesheet ordering. Priority highest first: conflict > regExpired >
// mismatch/hazIssue > marginView tier > hazLoud > base status (no override).
const borderOverride = computed(() => {
  if (props.conflict) return '!border-conflict'
  if (props.regExpired) return '!border-amber-500 !border-dashed'
  if (props.mismatch || props.hazIssue) return '!border-amber-500 !border-dashed'
  // Unpriced legs keep their status colour: heat-mapping an unknown margin
  // would paint "we never priced this" as "this is losing money".
  if (props.marginView && marginPct.value !== null)
    return marginPct.value >= 0.22 ? '!bg-emerald-500/15 !border-emerald-500' : marginPct.value >= 0.12 ? '!bg-yellow-500/15 !border-yellow-500' : '!bg-red-500/15 !border-red-500'
  if (props.hazLoud && props.load.hazmatClass) return '!border-haz ck-hatch-haz'
  return null
})
const cls = computed(() => {
  const out = ['ck-brick rounded-lg border overflow-hidden shadow-lg transition cursor-pointer select-none', STATUS_CLASS[status.value] ?? STATUS_CLASS.assigned]
  if (borderOverride.value) out.push(borderOverride.value)
  // Ring/glow/opacity are a separate visual channel from the border colour
  // above and may coexist with whichever override won.
  if (props.conflict) out.push('ring-1 ring-conflict/60')
  if (props.risk === 'block') out.push('ring-2 ring-red-500')
  else if (props.risk === 'warn') out.push('ring-2 ring-amber-400')
  if (props.spotted) out.push('ck-spot')
  if (props.dimmed) out.push('opacity-40')
  if (props.selected) out.push('ring-2 ring-brand/70')
  return out.join(' ')
})
</script>

<template>
  <div
    :class="cls"
    :style="{ left: `${Math.round(x)}px`, width: `${Math.round(w)}px` }"
    :data-load="load.id"
    :data-status="status"
    :data-brokered="brokered || undefined"
    :data-unplaced="unplaced || undefined"
    :data-locked="lockedBy || undefined"
    :title="unplaced ? (load.attention ?? []).join(' · ') : undefined"
    @click="emit('open', load.id)"
    @mouseenter="emit('hover', load.id, $event.currentTarget as HTMLElement)"
    @mouseleave="emit('hover', null, null)"
  >
    <div class="absolute inset-x-0 top-0 flex h-1" data-testid="step-bar">
      <div
        v-for="(s, i) in segs"
        :key="i"
        class="flex-1"
        :class="s === 'done' ? 'bg-emerald-400' : s === 'current' ? 'bg-amber-400 animate-pulse' : 'bg-ink-3/40'"
        :title="`${STEP_TITLES[i]} (${s})`"
      />
    </div>
    <div v-if="deadheadPx > 0" class="ck-hatch absolute bottom-0 left-0 top-1" :style="{ width: `${Math.min(deadheadPx, w)}px` }" title="Hatched = empty drive to the pickup" />

    <div class="relative flex items-center justify-between gap-1 px-2 pt-1.5 text-[11px]">
      <span class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono font-bold" :class="done ? 'text-ink-2' : 'text-ink'">
        {{ load.reference }}
        <!-- A4 Task 8: same "renders at every width" rule as the unplaced
             carrier-name line below — deliberately NOT inside the `mid`
             template, so a 96px unplaced brick still shows who is holding
             the load, the same treatment the broker grid already gives a
             locked row (BrokerGrid.vue's `.bb-lock`). -->
        <span
          v-if="lockedBy"
          class="rounded bg-violet-500/20 px-1 text-[9px] font-black text-violet-400"
          data-testid="tag-locked"
          :title="`${lockedBy} is editing this load on Their Board`"
        >✎ {{ lockedBy }}</span>
        <!-- Night Shift on the Board, Task 6: same "every width" rule as the
             lock badge above — the 96px unplaced brick still owes its night
             watcher a pill, the lesson A3 Task 6 already learned the hard way
             for the carrier-name badge (never gate a status indicator behind
             the `mid` (110px) tier). -->
        <AgentPill
          v-if="load.agentPill && load.agentPill !== 'off'"
          :pill="load.agentPill"
          :line="load.agentLine ?? null"
          :load-id="load.id"
          @open-agent="emit('open-agent', $event)"
        />
        <template v-if="mid">
          <span class="rounded px-1 text-[9px]" :class="equipClass(load.requiredEquip)">{{ equipIcon(load.requiredEquip) }} {{ equipLabel(load.requiredEquip) }}</span>
          <span v-if="wide && load.brokerName" class="rounded bg-surface-3 px-1 text-[9px] text-ink-2">{{ load.brokerName }}</span>
          <span v-if="load.hazmatClass" class="rounded border border-haz/40 bg-haz/20 px-1 text-[9px] font-black text-haz" data-testid="tag-haz">⬧ HAZMAT {{ load.hazmatClass }}</span>
          <span v-if="conflict" class="rounded bg-conflict/30 px-1 text-[9px] font-black text-conflict" data-testid="tag-conflict">⚠ CONFLICT</span>
          <span v-if="mismatch" class="rounded bg-amber-500 px-1 text-[9px] font-black text-slate-950" data-testid="tag-mismatch">≠ {{ equipLabel(load.requiredEquip) }}</span>
          <span v-if="hazIssue" class="rounded bg-amber-500 px-1 text-[9px] font-black text-slate-950" data-testid="tag-hazissue">NO HZ ENDT</span>
          <span v-if="regExpired" class="rounded bg-red-500 px-1 text-[9px] font-black text-white" data-testid="tag-reg">REG EXP</span>
          <span v-if="risk === 'block'" class="rounded bg-red-600 px-1 text-[9px] font-black text-white" data-testid="tag-late">⏰ LATE</span>
          <span v-if="status === 'tendered'" class="rounded bg-s-tendered px-1 text-[9px] font-black text-white" data-testid="tag-tendered">⏳ TENDERED</span>
          <span v-if="spotted" class="rounded bg-yellow-400 px-1 text-[9px] font-black text-slate-950" data-testid="tag-spotted">SPOTTED</span>
          <span v-if="hasBreak" class="rounded bg-amber-500/20 px-1 text-[9px] font-black text-amber-500" data-testid="tag-break" :title="breakTooltip">⬡ BREAK</span>
          <span v-if="fuelAdvice" class="rounded bg-sky-500/20 px-1 text-[9px] font-black text-sky-500" data-testid="tag-fuel" :title="`Cheaper fuel at ${fuelAdvice.atLabel} (${fuelAdvice.state}) vs ${fuelAdvice.vsLabel}`">⛽ {{ formatUsd(fuelAdvice.savingCents) }}</span>
          <span v-if="detentionClaim" class="rounded bg-rose-500/20 px-1 text-[9px] font-black text-rose-500" data-testid="tag-detention" :title="`${detentionClaim.billableMin} min billable`">⏱ DETENTION</span>
        </template>
      </span>
      <span v-if="wide" class="whitespace-nowrap font-mono font-bold text-emerald-500" data-testid="brick-rate">
        {{ formatUsd(load.revenueCents) }}<span v-if="rpm != null" class="text-ink-3"> (${{ rpm.toFixed(2) }}/mi)</span>
      </span>
    </div>

    <div v-if="mid" class="ck-mid relative truncate px-2 text-[11px] font-medium text-ink" data-testid="brick-route">
      <span v-if="brokered && load.carrierName" class="mr-1 rounded bg-surface-3 px-1 text-[9px] font-bold text-ink-2" data-testid="tag-carrier">{{ load.carrierName }}</span>
      {{ load.origin }} ➔ {{ load.destination }}<span v-if="wide && load.commodity" class="font-normal text-ink-3"> ({{ load.commodity }}<template v-if="load.weightLbs"> · {{ load.weightLbs.toLocaleString() }} lbs</template>)</span>
    </div>
    <!-- Fix round 1: a brick too narrow for the route line (UNPLACED_W=96 <
         mid's 110px threshold) still owes its carrier a name — this compact
         line is the `!mid` twin of the badge above; the two are mutually
         exclusive (`mid` / `!mid`), so `[data-testid="tag-carrier"]` never
         appears twice. -->
    <div v-else-if="brokered && load.carrierName" class="ck-mid relative truncate px-2 text-[9px] font-bold text-ink-2" data-testid="tag-carrier">
      {{ load.carrierName }}
    </div>

    <div v-if="wide && a" class="ck-mid relative mx-2 mt-1 flex items-center justify-between border-t border-line pt-1 font-mono text-[10px] text-ink-3">
      <span>{{ fmtClock(startMs, tz) }}–{{ fmtClock(endMs, tz) }} · {{ load.stopCount }} stops<template v-if="a.savedMi"> · +{{ Math.round(a.savedMi) }} mi saved</template></span>
      <span v-if="econ" class="font-bold" :class="econ.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500'" data-testid="brick-margin">{{ econ.marginCents >= 0 ? '+' : '' }}{{ formatUsd(econ.marginCents) }} MARGIN</span>
      <span v-else class="font-bold text-ink-3" title="Not priced — no committed rate snapshot" data-testid="brick-margin">— MARGIN</span>
    </div>

    <div v-if="status === 'in_progress'" class="absolute bottom-0 left-0 h-[3px] bg-s-progress" :style="{ width: `${Math.round(w * progress)}px` }" data-testid="brick-progress" />
    <div v-if="load.stopCount > 1 && w > 64" class="absolute inset-x-2 bottom-1 h-0">
      <span v-for="i in load.stopCount" :key="i" class="absolute -top-0.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-ink-3/70" :style="{ left: `${((i - 1) / (load.stopCount - 1)) * 100}%` }" />
    </div>
  </div>
</template>
