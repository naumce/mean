<script setup lang="ts">
import { computed } from 'vue'
import { clockChip, PILL_CLASSES, type Chip } from '../../lib/cockpit/chips'
import { ageLabel, avatarColor, COLOR_CLASSES, hrsLabel, initials } from '../../lib/cockpit/format'
import { laneMoneyInView, pillOf, type CockpitLane } from '../../lib/cockpit/lanes'
import { isExpired } from '../../lib/compliance'
import { hosFreshness } from '../../lib/hosFreshness'
import { formatUsd } from '../../lib/money'
import { useCarriersStore } from '../../stores/carriers'
import type { BoardTractor, BoardTrailer } from '../../stores/loadboard'
import type { DriverLocation } from '../../types/dispatcher'

// The Bertschi composite lane header, every value real: pairing from the
// loadboard, clocks from HosState, chips from the fleet compliance clocks,
// telemetry from the last GPS ping, money from the lane's legs.
const props = withDefaults(
  defineProps<{
    lane: CockpitLane
    tractor?: BoardTractor | null
    trailer?: BoardTrailer | null
    nowMs: number
    tz: string
    plannedDriveMin: number
    lastPing?: DriverLocation | null
    compact?: boolean
  }>(),
  { tractor: null, trailer: null, lastPing: null, compact: false },
)
const emit = defineEmits<{ open: [driverId: string] }>()
const carriers = useCarriersStore()

const d = computed(() => props.lane.driver!)
// T1 Carrier Layer, Task 8: the carrier tag is only informative once an org
// actually runs more than one carrier — check the roster's length, not
// merely whether this particular driver has a carrierName, so a
// single-carrier org (or one not yet using the carrier layer at all) gains
// no clutter even for a driver whose carrier is set.
const showCarrier = computed(() => carriers.list.length > 1 && !!d.value.carrierName)
const color = computed(() => COLOR_CLASSES[avatarColor(d.value.id)])
const pill = computed(() => pillOf(props.lane, props.nowMs))
const fresh = computed(() => (d.value.hosKnown ? hosFreshness(d.value.hosImportedAt, props.nowMs) : null))
const PING_LIVE_MS = 15 * 60_000

const telemetry = computed(() => {
  const p = props.lastPing
  if (!p) return { t: 'NO GPS', c: 'text-ink-3' }
  const age = props.nowMs - Date.parse(p.createdAt)
  if (age < PING_LIVE_MS) return { t: p.speed != null ? `${Math.round(p.speed)} MPH` : 'MOVING', c: 'text-emerald-500' }
  return { t: `LAST PING ${ageLabel(p.createdAt, props.nowMs)}`, c: 'text-ink-3' }
})
const reefer = computed(() => {
  try {
    const f = props.trailer?.features ? (JSON.parse(props.trailer.features) as { reeferSetpoint?: number }) : null
    return f?.reeferSetpoint != null ? `SET ${f.reeferSetpoint}°F` : null
  } catch {
    return null
  }
})
const chips = computed<Array<Chip & { key: string }>>(() => {
  const out: Array<Chip & { key: string }> = [{ key: 'MED', ...clockChip('MED', d.value.medicalCertExpiresAt, props.nowMs) }]
  if (props.tractor) out.push({ key: 'DOT', ...clockChip('DOT', props.tractor.inspectionExpiresAt, props.nowMs) })
  if (props.trailer) out.push({ key: 'REG', ...clockChip('REG', props.trailer.registrationExpiresAt, props.nowMs) })
  if (props.tractor) out.push({ key: 'PM', ...clockChip('PM', props.tractor.nextServiceAt, props.nowMs) })
  return out
})
// Compact mode is a density control, not a safety-signal control: an
// expired compliance chip must survive the compact collapse.
const expiredChips = computed(() => chips.value.filter((c) => c.level === 'expired'))
const drvCls = computed(() => {
  const m = d.value.driveRemainingMin
  if (!d.value.hosKnown || m == null) return 'text-ink-3 bg-surface-3 border-line'
  if (m <= 0) return 'text-red-500 bg-red-500/10 border-red-500/40'
  if (m < 180) return 'text-amber-500 bg-amber-500/10 border-amber-500/30'
  return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30'
})
// A driver whose legal hours were never imported must never look "legal":
// the bar gets its own neutral state rather than silently falling through
// to the ok/green branch just because hosBad can't be computed.
const hosUnknown = computed(() => {
  const m = d.value.driveRemainingMin
  return !d.value.hosKnown || m == null
})
const hosPct = computed(() => {
  const m = d.value.driveRemainingMin
  if (!d.value.hosKnown || m == null) return 100
  if (m <= 0) return props.plannedDriveMin > 0 ? 100 : 0
  return Math.min(100, Math.round((props.plannedDriveMin / m) * 100))
})
const hosBad = computed(() => {
  const m = d.value.driveRemainingMin
  return d.value.hosKnown && m != null && props.plannedDriveMin > m + 0.5
})
const hosBarCls = computed(() => (hosUnknown.value ? 'bg-ink-3/40' : hosBad.value ? 'bg-red-500' : 'bg-emerald-500'))
const hosTitle = computed(() => (hosUnknown.value ? 'HOS clocks not imported — legal hours unknown' : 'Planned drive today vs legal driving time left'))
const toBreak = computed(() => (d.value.hosKnown && d.value.minutesSinceBreak != null ? Math.max(0, 480 - d.value.minutesSinceBreak) : null))
// Lane revenue = every leg in view (see laneMoneyInView's doc comment for how
// this differs from the KPI strip's Committed Gross). Margin comes only from
// legs with a committed rate snapshot, so an unpriced lane reads "—" instead
// of a manufactured 0%, and the colour follows the sign instead of always
// claiming green.
const money = computed(() => laneMoneyInView(props.lane))
const marginPct = computed(() => {
  const m = money.value
  return m.marginCents != null && m.pricedRevenueCents ? Math.round((m.marginCents / m.pricedRevenueCents) * 100) : null
})
const regExpired = computed(() => isExpired(props.trailer?.registrationExpiresAt, props.nowMs))
const dotCls = computed(() => (d.value.status === 'active' || d.value.status === 'online' ? `${color.value.dot} animate-pulse` : d.value.status === 'on_break' ? 'bg-amber-400' : 'bg-ink-3'))
</script>

<template>
  <div class="flex flex-col justify-between">
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2.5">
        <button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border font-mono text-xs font-bold shadow-inner" :class="color.av" @click="emit('open', d.id)">{{ initials(d.name) }}</button>
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 whitespace-nowrap text-xs font-bold text-ink">
            <button type="button" class="hover:underline" data-testid="lane-name" @click="emit('open', d.id)">{{ d.name }}</button>
            <span class="h-2 w-2 rounded-full" :class="dotCls" :title="`presence: ${d.status}`" />
            <span v-if="showCarrier" class="rounded border border-line bg-surface-3 px-1 font-mono text-[9px] font-normal text-ink-3" data-testid="lane-carrier">{{ d.carrierName }}</span>
            <span v-if="tractor" class="font-mono text-[10px] font-normal text-ink-3">#{{ tractor.unit }} {{ tractor.cab }}</span>
            <span v-else class="font-mono text-[10px] font-normal text-ink-3">no tractor</span>
          </div>
          <div v-if="!compact" class="mt-0.5 flex items-center gap-1.5 whitespace-nowrap font-mono text-[10px] text-ink-3">
            <span :class="regExpired ? 'font-bold text-red-500' : 'text-ink-2'">{{ trailer ? `${trailer.unit} (${trailer.length ? trailer.length + ' ' : ''}${trailer.type})` : '— no trailer —' }}</span>
            <span>•</span>
            <span class="font-bold" :class="telemetry.c" data-testid="lane-telemetry">{{ telemetry.t }}</span>
            <span v-if="reefer" class="font-bold text-cyan-500">{{ reefer }}</span>
          </div>
          <div v-if="!compact" class="mt-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[9px]">
            <span v-for="c in chips" :key="c.key" class="rounded border px-1" :class="c.cls" :data-testid="`chip-${c.key}`">{{ c.text }}</span>
            <span v-if="d.hazmatEndorsed" class="rounded border border-violet-500/30 bg-violet-500/10 px-1 font-bold text-violet-500" data-testid="chip-HZ">☣ HAZMAT ✓</span>
            <span v-if="fresh?.stale" class="rounded border border-amber-500/40 bg-amber-500/15 px-1 font-bold uppercase text-amber-500" :title="fresh.label" data-testid="lane-hos-stale">stale</span>
          </div>
          <div v-else-if="expiredChips.length || fresh?.stale" class="mt-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[9px]">
            <span v-for="c in expiredChips" :key="c.key" class="rounded border px-1" :class="c.cls" :data-testid="`chip-${c.key}`">{{ c.text }}</span>
            <span v-if="fresh?.stale" class="rounded border border-amber-500/40 bg-amber-500/15 px-1 font-bold uppercase text-amber-500" :title="fresh.label" data-testid="lane-hos-stale">stale</span>
          </div>
        </div>
      </div>
      <span class="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="PILL_CLASSES[pill.c]" data-testid="lane-pill">{{ pill.t }}</span>
    </div>

    <div class="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2 font-mono text-[10px]">
      <div class="min-w-0 truncate text-ink-3" data-testid="lane-city">
        📍 <span class="font-semibold text-ink">{{ d.lastCity ?? 'position unknown' }}</span>
        <span v-if="d.lastLocationAt" class="text-ink-3"> ({{ ageLabel(d.lastLocationAt, nowMs) }})</span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <span class="rounded border px-1.5 py-0.5 font-bold" :class="drvCls" data-testid="lane-drv">DRV: {{ hrsLabel(d.hosKnown ? d.driveRemainingMin : null) }}</span>
        <span class="rounded border border-line bg-surface-3 px-1.5 py-0.5" :class="(d.cycleRemainingMin ?? 999) < 300 ? 'font-bold text-red-500' : 'text-ink-2'" data-testid="lane-cyc">CYC: {{ hrsLabel(d.hosKnown ? d.cycleRemainingMin : null) }}</span>
      </div>
    </div>

    <div v-if="!compact" class="mt-1.5 flex items-center justify-between gap-2 whitespace-nowrap font-mono text-[9px] text-ink-3">
      <span :class="hosBad ? 'font-bold text-red-500' : ''" :title="hosTitle" data-testid="lane-hos">
        HOS <span class="inline-block h-1 w-12 overflow-hidden rounded bg-surface-3 align-middle" data-testid="lane-hos-bar"><span class="block h-full" :class="hosBarCls" :style="{ width: `${hosPct}%` }" /></span>
        {{ (plannedDriveMin / 60).toFixed(1) }}/{{ d.hosKnown && d.driveRemainingMin != null ? (d.driveRemainingMin / 60).toFixed(1) : '?' }}h{{ hosBad ? ' ⚠' : '' }}
      </span>
      <span v-if="toBreak != null" data-testid="lane-tobreak">⏱ {{ hrsLabel(toBreak) }} to break</span>
      <span v-if="money.revenueCents" class="text-ink-2" data-testid="lane-money">{{ formatUsd(money.revenueCents) }} · <b v-if="marginPct != null" :class="marginPct >= 0 ? 'text-emerald-500' : 'text-red-500'">{{ marginPct }}% mgn</b><b v-else class="text-ink-3" title="No committed rate snapshot on this lane's legs">— mgn</b></span>
      <span v-else class="text-ink-3">no revenue</span>
    </div>
    <span v-else-if="hosBad" class="mt-1.5 block whitespace-nowrap font-mono text-[9px] font-bold text-red-500" :title="hosTitle" data-testid="lane-hos">⚠</span>
  </div>
</template>
