<script setup lang="ts">
import { computed } from 'vue'
import { fmtClock, hrsLabel } from '../../lib/cockpit/format'
import { equipClass, equipIcon } from '../../lib/cockpit/equipment'
import { formatMiles, formatPct } from '../../lib/money'
import { STATUS_CHIP_CLASS, projectedAvailabilityLabel, statusLabel } from '../../lib/supplyFormat'
import type { CandidateContext } from '../../stores/loadboard'

// AI Dispatch Foundation (Task 6/10): the ⚡Suggest panel's second line,
// under each feasible candidate's name (two-line cell, portal §5) — every
// value here is Task 6's evidence, attached to the row AFTER ranking. IT
// NEVER CHANGES THE ROW'S ORDER, SCORE, OR FEASIBLE/INFEASIBLE STYLING; it
// is information only, same rule as candidateContext.ts's own header
// comment. No subjective labels — every fragment names a real field.
const props = withDefaults(defineProps<{ context: CandidateContext; tz?: string }>(), {
  tz: 'America/Chicago',
})

const statusChipClass = computed(() => STATUS_CHIP_CLASS[props.context.availability.status])

const availLine = computed(() => {
  const a = props.context.availability
  return `avail ${projectedAvailabilityLabel(a.available, a.availableAt, Date.now(), (ms) => fmtClock(ms, props.tz))}`
})

const pickupLine = computed(() => {
  const ms = props.context.estimatedArrivalAtPickupMs
  return ms == null ? 'at pickup —' : `at pickup ≈ ${fmtClock(ms, props.tz)}`
})

const hosLine = computed(() => {
  const hos = props.context.hosRemaining
  return hos.known ? `HOS ${hrsLabel(hos.driveMin)} drive` : 'HOS not imported'
})

const homeLine = computed(() => {
  const mi = props.context.homeTime.deliveryToHomeMi
  return mi == null ? '— to home' : `${formatMiles(mi)} to home`
})

/** The plain-text facts, joined into one wrapping line — everything except
 *  the chips (status, home-time fit, preference flags, qualifications),
 *  which render separately below so they keep their own pill styling. */
const facts = computed<string[]>(() => {
  const c = props.context
  const list = [
    availLine.value,
    pickupLine.value,
    hosLine.value,
    `lane runs ${c.laneRuns}`,
    c.onTimeRate != null ? `on-time ${formatPct(c.onTimeRate)}` : 'on-time —',
    c.responseRate != null ? `reply ${formatPct(c.responseRate)}` : 'reply —',
  ]
  if (c.noResponseIncidents > 0) list.push(`no-reply ×${c.noResponseIncidents}`)
  list.push(homeLine.value)
  if (c.preferences) list.push(`equip pref ${c.preferences.matchesEquipmentPref ? '✓' : '✗'}`)
  return list
})

const CHIP = 'rounded px-1.5 py-0.5 font-mono text-[9px] font-bold'
</script>

<template>
  <div class="mt-0.5 flex flex-wrap items-center gap-1.5" data-testid="candidate-context">
    <span :class="[CHIP, statusChipClass]" data-testid="context-status-chip">{{ statusLabel(context.availability.status) }}</span>
    <span class="font-mono text-[10px] text-ink-3" data-testid="context-facts">{{ facts.join(' · ') }}</span>
    <span v-if="context.homeTime.withinRelocate" :class="[CHIP, 'bg-emerald-500/10 text-emerald-500']" data-testid="context-home-fit-chip">
      home-time fit
    </span>
    <span v-if="context.preferences?.laneAvoided" :class="[CHIP, 'bg-amber-500/10 text-amber-500']" data-testid="context-avoids-lane-chip">
      avoids lane
    </span>
    <span v-if="context.preferences?.regionAvoided" :class="[CHIP, 'bg-amber-500/10 text-amber-500']" data-testid="context-avoids-region-chip">
      avoids region
    </span>
    <span v-for="e in context.qualifications.equipmentTypes" :key="e" :class="[CHIP, equipClass(e)]">{{ equipIcon(e) }} {{ e }}</span>
    <span v-if="context.qualifications.hazmatEndorsed" :class="[CHIP, 'bg-red-500/10 text-red-500']" data-testid="context-hazmat-chip">
      HAZMAT
    </span>
  </div>
</template>
