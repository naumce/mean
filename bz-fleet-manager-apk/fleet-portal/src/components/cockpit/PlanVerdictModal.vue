<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { BreakPlanEntry, FuelPlanBody } from '../../lib/api'
import { fmtDT } from '../../lib/cockpit/format'
import { formatMiles, formatPct, formatUsd } from '../../lib/money'

// The verdict dialog a dispatcher sees when a drag's dry-run (or the commit's
// 422) comes back blocked. This component never decides feasibility — it only
// renders what the server already decided, and lets the dispatcher Cancel or,
// when the server allows it, Force. Engine-authoritative: nothing here writes
// anything; the parent supplies the force callback via the `force` event.

export interface PlanVerdictConflict {
  kind: string
  severity: 'block' | 'warn'
  detail: string
}

export interface PlanVerdictPlan {
  proposedStart: number
  proposedEnd: number
  deadheadMi: number
  loadedMi: number
  driveMin: number
  onDutyMin: number
  needsBreak: boolean
}

/** The committed-rate-snapshot shape. Present only once the load has been
 *  priced — see `PlanVerdict.economics`, which is nullable for exactly that
 *  reason. */
export interface PlanVerdictEconomics {
  revenueCents: number
  totalMi: number
  deadheadMi: number
  loadedMi: number
  estCostCents: number
  marginCents: number
  marginPct: number
  ratePerLoadedMiCents: number
  ratePerTotalMiCents: number
}

/** The server's dry-run / 422 verdict body, verbatim. `economics` is null
 *  when the load was never priced — absent, not zero, and must render as
 *  "—". This is the C1 defect class from S1: a verdict that prints "$0
 *  margin" for an unpriced load is the same lie in a new place.
 *
 *  T3 Break and Rest Planning, Task 9: `breakPlan`/`breakPlanKnown` mirror
 *  api.ts's `PlanResult` field-for-field — same wire-twin convention, same
 *  meaning. Both optional so a verdict body with `breakPlan` absent entirely
 *  (an older server response, or `stores/cockpit.ts`'s `CockpitVerdict`
 *  degradation path) still typechecks and renders — as unknown, never a
 *  crash. `breakPlanKnown: undefined` reads identically to `false` below:
 *  the modal cannot claim a break schedule it was never told about. */
export interface PlanVerdict {
  feasible: boolean
  conflicts: PlanVerdictConflict[]
  plan: PlanVerdictPlan
  economics: PlanVerdictEconomics | null
  breakPlan?: BreakPlanEntry[]
  breakPlanKnown?: boolean
  /** T4 Fuel and Stops, Task 8: mirrors api.ts's `PlanResult.fuel` — same
   *  wire-twin, same optionality reasoning as `breakPlan` above. Absent
   *  (an older server response) reads exactly like `fuel.known === false`:
   *  never a crash, never a claimed measurement the server never sent. */
  fuel?: FuelPlanBody
}

const props = withDefaults(defineProps<{ verdict: PlanVerdict | null; tz?: string }>(), { tz: 'America/Chicago' })
const emit = defineEmits<{ cancel: []; force: [] }>()

const blockers = computed(() => props.verdict?.conflicts.filter((c) => c.severity === 'block') ?? [])
const warnings = computed(() => props.verdict?.conflicts.filter((c) => c.severity === 'warn') ?? [])

// An overlap is physics, not judgement: the server's in-transaction
// Serializable re-check refuses an overlapping window unconditionally, on
// both POST /assignments and PATCH /plan. `force` clears the advisory 422 but
// the write is refused anyway with a 409 — one driver cannot run two loads at
// once. Offering Force here offers a click that cannot succeed, so it must be
// absent whenever a blocker is an overlap, not just absent when there are no
// blockers at all.
const hasOverlapBlock = computed(() => blockers.value.some((c) => c.kind === 'overlap'))
const canForce = computed(() => blockers.value.length > 0 && !hasOverlapBlock.value)
const econ = computed(() => props.verdict?.economics ?? null)

/** T3 Break and Rest Planning, Task 9: the modal's three break states.
 *  `breakPlanKnown` absent (or the whole `breakPlan` shape absent — Step 1's
 *  degradation case) reads exactly like `false`, mirroring `stores/
 *  cockpit.ts`'s `applyBreakPlan`: silence here means "nothing to say yet",
 *  never "known and empty". `breakEntries` is deliberately `[]` whenever
 *  `breakKnown` is false too, so the template needs only one guard, not two
 *  independently-driftable ones. */
const breakKnown = computed(() => props.verdict?.breakPlanKnown ?? false)
const breakEntries = computed<BreakPlanEntry[]>(() => (breakKnown.value ? (props.verdict?.breakPlan ?? []) : []))

function breakTimeLabel(bp: BreakPlanEntry): string {
  return fmtDT(bp.atMs, props.tz)
}
/** Same 4-decimal fallback + `≈` precedent MapPopup's `breakLocationLabel`
 *  already established for this exact fact (Global Constraint 7) — matched
 *  verbatim so a dispatcher never reads two different claims about the same
 *  break point between the modal and the map popup. `at: null` (the engine
 *  could not place this entry) degrades to an honest "unknown", never a
 *  crash on `.lat`. */
function breakPlaceLabel(bp: BreakPlanEntry): string {
  if (!bp.at) return 'location unknown'
  const coords = `${bp.at.lat.toFixed(4)}, ${bp.at.lng.toFixed(4)}`
  return bp.precision === 'estimated' ? `≈${coords}` : coords
}
/** Matched verbatim against MapPopup's `breakCoverageLabel` — see that
 *  computed's own doc. `hasCoverage: false` is "the org told us nothing
 *  about this corridor", never conflated with "checked, found nothing"
 *  (Global Constraint 1). */
function breakCoverageLabel(bp: BreakPlanEntry): string {
  if (!bp.hasCoverage) return 'rest options unknown'
  if (bp.options.length === 0) return 'no rest option within 35 mi'
  return `${bp.options.length} option${bp.options.length === 1 ? '' : 's'} nearby`
}

/** T4 Fuel and Stops, Task 8: the modal's three fuel states, matching the
 *  break row's pattern above — a single nullable computed narrowed by one
 *  `v-if` in the template (same precedent `econ` already established), not
 *  a boolean + separate value pair. The server puts `known` INSIDE the
 *  `fuel` object rather than nulling the object itself, so this collapses
 *  that into the same "null means nothing to say yet" shape: `known: false`
 *  and `fuel` absent entirely (an older server response) both fold to
 *  `null` here and render identically as "fuel estimate unavailable". */
const fuel = computed(() => (props.verdict?.fuel?.known ? props.verdict.fuel : null))
/** `advice: null` is the engine finding nowhere cheaper to recommend — never
 *  hidden inside `fuel`'s narrowing above, so it gets its own nullable
 *  computed narrowed by its own `v-if`, same reasoning as `econ`. */
const fuelAdvice = computed(() => fuel.value?.advice ?? null)

/** Gallons are not money — `formatUsd` in ../../lib/money stays the only
 *  cents-to-dollars formatter (T4 brief: do not add a second one). This is
 *  a distinct unit, formatted the same "round + unit suffix" way
 *  `formatMiles` already does for miles. */
function formatGal(gal: number): string {
  return `${Math.round(gal)} gal`
}

function handleCancel(): void {
  emit('cancel')
}
function handleForce(): void {
  if (!canForce.value) return
  emit('force')
}
function handleKeydown(event: KeyboardEvent): void {
  // Escape closes without committing, same as Cancel — it must never reach
  // the force path.
  if (event.key === 'Escape' && props.verdict) handleCancel()
}
onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div
    v-if="verdict"
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
    data-testid="verdict-modal"
    @click.self="handleCancel"
  >
    <div class="w-full max-w-md rounded-lg border border-line-strong bg-surface font-mono text-xs shadow-2xl" role="dialog" aria-modal="true">
      <div class="flex items-center justify-between border-b border-line px-4 py-3">
        <span class="text-xs font-bold text-ink">{{ verdict.feasible ? 'PLAN VERDICT' : 'PLAN BLOCKED' }}</span>
        <button type="button" class="text-ink-3 hover:text-ink" aria-label="Close" data-testid="verdict-close" @click="handleCancel">✕</button>
      </div>

      <div class="max-h-[50vh] overflow-y-auto px-4 py-3">
        <div v-if="!blockers.length && !warnings.length" class="text-[11px] text-emerald-500" data-testid="verdict-clean">✓ No conflicts</div>

        <div v-else class="flex flex-col gap-1.5" data-testid="conflict-list">
          <div v-for="(c, i) in blockers" :key="`b-${i}`" class="flex items-start gap-1.5 text-conflict" data-severity="block" :data-kind="c.kind">
            <span class="shrink-0 font-bold">✗</span><span>{{ c.detail }}</span>
          </div>
          <div v-for="(c, i) in warnings" :key="`w-${i}`" class="flex items-start gap-1.5 text-amber-500" data-severity="warn" :data-kind="c.kind">
            <span class="shrink-0 font-bold">⚠</span><span>{{ c.detail }}</span>
          </div>
        </div>

        <div class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5">
          <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Economics</div>
          <div class="mt-1.5 flex flex-col gap-1 text-[11px]" data-testid="verdict-economics">
            <template v-if="econ">
              <div class="flex justify-between"><span class="text-ink-3">Est. cost</span><span class="font-bold text-ink">{{ formatUsd(econ.estCostCents) }}</span></div>
              <div class="flex justify-between">
                <span class="text-ink-3">Margin</span>
                <span class="font-bold" :class="econ.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500'">{{ formatUsd(econ.marginCents) }} ({{ formatPct(econ.marginPct) }})</span>
              </div>
              <div class="flex justify-between text-[10px] text-ink-3"><span>{{ formatMiles(econ.loadedMi) }} loaded</span><span>{{ formatMiles(econ.deadheadMi) }} deadhead</span></div>
            </template>
            <div v-else class="text-ink-3" data-testid="verdict-unpriced">— not priced</div>
          </div>
        </div>

        <div v-if="hasOverlapBlock" class="mt-3 rounded-lg border border-conflict/40 bg-conflict/10 p-2.5 text-[11px] text-conflict" data-testid="verdict-overlap-reason">
          An overlap cannot be forced — one driver cannot run two loads at once. Resolve the conflicting leg first.
        </div>

        <!-- T3 Break and Rest Planning, Task 9: the mandatory-break row —
             engine-authoritative, rendered off `breakPlan`/`breakPlanKnown`
             alone, never re-derived and never gated on `plan.needsBreak`
             (that would be a second source of truth for the same fact,
             which Ruling 8 forbids). No warning styling on the "unknown"
             state: a data gap is not a problem with the plan. -->
        <div class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5" data-testid="verdict-break">
          <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Mandatory break</div>
          <div v-if="!breakKnown" class="mt-1 text-[11px] text-ink-3" data-testid="verdict-break-unknown">break schedule unknown — HOS not imported</div>
          <div v-else-if="!breakEntries.length" class="mt-1 text-[11px] text-ink-3" data-testid="verdict-break-none">no break required</div>
          <div v-else class="mt-1.5 flex flex-col gap-2" data-testid="verdict-break-list">
            <div v-for="(bp, i) in breakEntries" :key="i" class="flex flex-col gap-0.5 text-[11px]" data-testid="verdict-break-row">
              <div class="flex justify-between">
                <span class="text-ink">{{ breakTimeLabel(bp) }}</span>
                <span class="text-ink-3">{{ breakPlaceLabel(bp) }}</span>
              </div>
              <div class="text-[10px] text-ink-3" data-testid="verdict-break-coverage">{{ breakCoverageLabel(bp) }}</div>
            </div>
          </div>
        </div>

        <!-- T4 Fuel and Stops, Task 8: diesel burn, where-to-buy advice, and
             IFTA attribution — engine-authoritative, rendered off `fuel`
             alone. Mirrors the break row above: three states (unknown /
             burn-only / burn-plus-advice), plus the IFTA sub-block that
             MUST show `unattributedGal` whenever `ifta.complete` is false —
             hiding that remainder would make a partial state attribution
             look complete on what is, ultimately, a tax filing input. -->
        <div class="mt-3 rounded-lg border border-line bg-surface-3 p-2.5" data-testid="verdict-fuel">
          <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">Fuel</div>
          <div v-if="!fuel" class="mt-1 text-[11px] text-ink-3" data-testid="verdict-fuel-unknown">fuel estimate unavailable</div>
          <template v-else>
            <div class="mt-1.5 flex flex-col gap-1 text-[11px]" data-testid="verdict-fuel-burn">
              <div class="flex justify-between"><span class="text-ink-3">Burn</span><span class="font-bold text-ink">{{ formatGal(fuel.burn.totalGal) }}</span></div>
              <div class="flex justify-between text-[10px] text-ink-3"><span>{{ formatGal(fuel.burn.loadedGal) }} loaded</span><span>{{ formatGal(fuel.burn.deadheadGal) }} deadhead</span></div>
            </div>
            <div v-if="fuelAdvice" class="mt-1.5 text-[11px] text-emerald-500" data-testid="verdict-fuel-advice">
              Buy {{ formatGal(fuelAdvice.gallons) }} in {{ fuelAdvice.atLabel }} — saves {{ formatUsd(fuelAdvice.savingCents) }} vs {{ fuelAdvice.vsLabel }}
            </div>
            <div v-else class="mt-1.5 text-[11px] text-ink-3" data-testid="verdict-fuel-no-advice">no cheaper stop found</div>

            <div class="mt-2 flex flex-col gap-1 border-t border-line pt-1.5" data-testid="verdict-fuel-ifta">
              <div class="text-[10px] font-bold uppercase tracking-wider text-ink-3">IFTA attribution</div>
              <div v-for="(s, i) in fuel.ifta.byState" :key="i" class="flex justify-between text-[11px]" data-testid="verdict-fuel-ifta-row">
                <span class="text-ink-3">{{ s.state }}</span><span class="text-ink">{{ formatGal(s.gallons) }}</span>
              </div>
              <div v-if="!fuel.ifta.complete" class="mt-0.5 text-[11px] text-amber-500" data-testid="verdict-fuel-unattributed">
                {{ formatGal(fuel.ifta.unattributedGal) }} unattributed
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button type="button" class="rounded-lg border border-line px-3 py-1.5 text-ink-2 hover:border-line-strong hover:text-ink" data-testid="verdict-cancel" @click="handleCancel">Cancel</button>
        <button
          v-if="canForce"
          type="button"
          class="rounded-lg border border-conflict bg-conflict px-3 py-1.5 font-bold text-white hover:opacity-90"
          data-testid="verdict-force"
          @click="handleForce"
        >
          Force anyway
        </button>
      </div>
    </div>
  </div>
</template>
