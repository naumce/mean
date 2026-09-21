<script setup lang="ts">
import { computed } from 'vue'
import type { RouteCard } from '../../lib/cockpit/routeCard'

// The panel behind a click on the ROUTE, as opposed to a click on the truck.
// TripCard.vue answers "how is this driver right now"; this answers "what is
// this run, end to end" — the plan a dispatcher relays over the phone.
//
// Same rule as TripCard and for the same reason: every value here can be
// UNKNOWN, and unknown renders in words, never as a comfortable zero. The
// specific harm is concrete — "no breaks required" shown for a run whose break
// plan merely failed to load will send a driver past their eighth hour.

const props = defineProps<{ card: RouteCard }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'show-on-board', loadId: string): void }>()

const mi = (n: number | null): string => (n === null ? '—' : Math.round(n).toLocaleString('en-US'))
const usd = (cents: number): string => '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })
const equipLabel = computed(() => props.card.equipment.replace(/_/g, ' '))

/** Rate per mile is quoted to the cent, and only when miles are known — see
 *  routeCard.ts. Over an arc it is an estimate of an estimate, so the label
 *  says so rather than printing a figure that looks surveyed. */
const ratePerMi = computed(() => {
  const r = props.card.ratePerMiCents
  if (r === null) return null
  return '$' + (r / 100).toFixed(2) + '/mi' + (props.card.onRoad ? '' : ' est')
})

const barWidth = computed(() => (props.card.progressPct ?? 0) + '%')

/** A detour is a distance a dispatcher reads out loud — "it's a mile and a bit
 *  off your route". The engine computes it as a float; printing that float
 *  verbatim put "+1.1486727122268334 mi" on the card. One decimal, and whole
 *  miles once it is far enough that the fraction stops mattering. */
const detour = (miles: number): string => (miles < 10 ? miles.toFixed(1) : String(Math.round(miles)))

const breakClock = (ms: number): string =>
  new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
</script>

<template>
  <div
    data-testid="route-plan-card"
    class="pointer-events-auto w-[21rem] rounded-lg border border-line bg-surface/95 p-3 text-xs shadow-lg backdrop-blur"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="font-mono text-[11px] text-muted">{{ card.loadRef }}</div>
        <div class="truncate text-sm font-semibold text-fg">
          {{ card.origin }} <span class="text-muted">&rarr;</span> {{ card.destination }}
        </div>
      </div>
      <button
        class="rounded px-1 text-muted hover:text-fg"
        aria-label="Close route plan"
        data-testid="route-close"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <!-- The product's strongest claim, and the one most damaging to overstate:
         a truck-legal road is asserted ONLY over provider geometry. -->
    <div class="mt-2">
      <span
        v-if="card.onRoad"
        class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400"
        data-testid="route-onroad"
      >TRUCK-LEGAL ROAD</span>
      <span
        v-else
        class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400"
        data-testid="route-arc"
      >ESTIMATED PATH — not a routed road</span>
    </div>

    <!-- Progress -->
    <div class="mt-2 rounded bg-surface-3 px-2 py-2">
      <div class="flex items-baseline justify-between" data-testid="route-progress">
        <template v-if="card.totalMi !== null">
          <span class="font-mono text-sm font-bold text-fg">
            {{ mi(card.drivenMi) }} <span class="text-muted">of</span> {{ mi(card.totalMi) }} mi
          </span>
          <span class="font-mono text-[11px] text-muted">{{ card.progressPct }}%</span>
        </template>
        <span v-else class="text-[11px] text-amber-400">Distance unknown — no route geometry</span>
      </div>
      <div v-if="card.progressPct !== null" class="mt-1.5 h-1 rounded bg-surface">
        <div class="h-1 rounded bg-emerald-500" :style="{ width: barWidth }" />
      </div>
      <div v-if="card.remainingMi !== null" class="mt-1 font-mono text-[10px] text-muted">
        {{ mi(card.remainingMi) }} mi remaining
      </div>
    </div>

    <!-- Breaks. Four states, deliberately kept apart. -->
    <div class="mt-2">
      <div class="text-[10px] font-semibold uppercase tracking-wide text-muted">Mandatory breaks</div>
      <div v-if="!card.breaks" class="mt-1 text-[11px] text-muted" data-testid="route-breaks-absent">
        Break plan not loaded for this run.
      </div>
      <div v-else-if="!card.breaks.known" class="mt-1 text-[11px] text-amber-400" data-testid="route-breaks-unknown">
        Hours unknown — no break plan can be made.
      </div>
      <div v-else-if="!card.breaks.lines.length" class="mt-1 text-[11px] text-muted" data-testid="route-breaks-none">
        None required on this run.
      </div>
      <ul v-else class="mt-1 space-y-1">
        <li v-for="(b, i) in card.breaks.lines" :key="i" class="flex items-baseline gap-2">
          <span class="font-mono text-[11px] text-fg">{{ breakClock(b.atMs) }}</span>
          <span v-if="b.best" class="truncate text-[11px] text-fg">
            {{ b.best.name }}
            <span class="text-muted">+{{ detour(b.best.detourMi) }} mi</span>
            <span v-if="b.best.spaces !== null" class="text-muted">· {{ b.best.spaces }} spaces</span>
          </span>
          <!-- Three different facts, and only the first is "we have no idea".
               Telling a dispatcher there is no rest data when the registry
               covers the area perfectly well — there is simply nothing within
               range — sends them to import data they already have. -->
          <span v-else-if="!b.hasCoverage" class="text-[11px] text-amber-400" data-testid="route-break-nocoverage">
            No rest data in this area
          </span>
          <span v-else class="text-[11px] text-amber-400" data-testid="route-break-nooption">
            Nothing within range of this point
          </span>
          <span v-if="b.precision === 'estimated'" class="text-[10px] text-muted">(est. position)</span>
        </li>
      </ul>
    </div>

    <!-- Fuel -->
    <div class="mt-2">
      <div class="text-[10px] font-semibold uppercase tracking-wide text-muted">Fuel</div>
      <div v-if="!card.fuel" class="mt-1 text-[11px] text-muted" data-testid="route-fuel-absent">
        Fuel plan not loaded for this run.
      </div>
      <!-- Only a MISSING MPG makes the burn unknowable. A plan can also come
           back not-known because no fuel PRICES are on file, which is a
           different gap with a different owner — and blaming the truck for it
           sends a dispatcher chasing the wrong fix. -->
      <div
        v-else-if="card.fuel.burn.mpgUsed === null"
        class="mt-1 text-[11px] text-amber-400"
        data-testid="route-fuel-unknown"
      >
        No mpg on file for this truck — burn cannot be estimated.
      </div>
      <div v-else class="mt-1 text-[11px]">
        <div class="text-muted">
          <span class="font-mono text-fg">{{ Math.round(card.fuel.burn.totalGal) }}</span> gal at
          <span class="font-mono text-fg">{{ card.fuel.burn.mpgUsed.toFixed(1) }}</span> mpg
        </div>
        <div v-if="card.fuel.advice" class="mt-0.5 text-emerald-400" data-testid="route-fuel-advice">
          Buy {{ Math.round(card.fuel.advice.gallons) }} gal at {{ card.fuel.advice.atLabel }} —
          saves {{ usd(card.fuel.advice.savingCents) }}
        </div>
        <!-- Not knowing is not the same as knowing there is no saving. With
             no prices on file the engine never compared anything, and saying
             "nothing cheaper" would be a finding it never made. -->
        <div v-else-if="!card.fuel.known" class="mt-0.5 text-amber-400" data-testid="route-fuel-noprices">
          No fuel prices on file for this lane — nothing to compare.
        </div>
        <!-- Here the engine DID compare and found nothing better. That is an
             answer, not a missing one. -->
        <div v-else class="mt-0.5 text-muted" data-testid="route-fuel-noadvice">
          Nothing cheaper found along this lane.
        </div>
      </div>
    </div>

    <!-- The load itself -->
    <div class="mt-2 flex items-baseline justify-between border-t border-line pt-2">
      <div class="text-[11px] text-muted">
        {{ equipLabel }}
        <template v-if="card.weightLbs !== null"> · {{ card.weightLbs.toLocaleString('en-US') }} lb</template>
        <span v-if="card.hazmat" class="ml-1 rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-400">
          HAZMAT {{ card.hazmat }}
        </span>
      </div>
      <div class="text-right">
        <div class="font-mono text-sm font-bold text-emerald-400">{{ usd(card.revenueCents) }}</div>
        <div v-if="ratePerMi" class="font-mono text-[10px] text-muted">{{ ratePerMi }}</div>
      </div>
    </div>

    <button
      class="mt-2 w-full rounded border border-line py-1 text-[11px] text-muted hover:text-fg"
      data-testid="route-show-on-board"
      @click="emit('show-on-board', card.loadId)"
    >
      Show on board
    </button>
  </div>
</template>
