<script setup lang="ts">
import { computed } from 'vue'
import { durationLabel, type TripSummary } from '../../lib/cockpit/tripCard'
import { useCockpitStore } from '../../stores/cockpit'

// The map's trip card: the "what is this truck doing right now" panel, modelled
// on a rider-hailing app's trip sheet. One hero ETA, who is driving, where they
// are headed, and the constraint that could change the plan.
//
// Every value here can be UNKNOWN, and unknown renders as a dash with a reason
// — never as a comfortable zero. A dispatcher told "0h to break" for a driver
// whose hours were never imported will send that driver into a violation.

const props = defineProps<{ trip: TripSummary | null; nowMs: number; tz?: string }>()
const emit = defineEmits<{ (e: 'show-on-board', loadId: string): void; (e: 'close'): void }>()

const ck = useCockpitStore()

/** The most recent "where are you?" for THIS driver, if any. */
const locationRequest = computed(() => {
  const id = props.trip?.driverId
  if (!id) return null
  return ck.locationRequests.items.find((r) => r.driverId === id) ?? null
})
const asking = computed(() => ck.locationRequests.asking === props.trip?.driverId)

function askLocation(): void {
  if (props.trip) void ck.askDriverLocation(props.trip.driverId)
}

const clock = (ms: number): string =>
  new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: props.tz || undefined,
  }).format(new Date(ms))

/** Countdown to the next stop. Null when there is no next stop to count to. */
const eta = computed(() => {
  const s = props.trip?.nextStop
  if (!s || s.etaMs == null) return null
  return { at: clock(s.etaMs), inMs: s.etaMs - props.nowMs, late: s.late, approx: s.etaApprox }
})

/** The break clock, phrased the way a dispatcher would say it out loud. */
const breakIn = computed(() => {
  const m = props.trip?.minutesToBreak
  if (m == null) return null
  return durationLabel(m * 60_000)
})

const pingAge = computed(() =>
  props.trip?.pingAgeMs == null ? null : durationLabel(props.trip.pingAgeMs),
)
</script>

<template>
  <div
    v-if="trip"
    data-testid="trip-card"
    class="pointer-events-auto w-[19rem] rounded-lg border border-line bg-surface/95 p-3 text-xs shadow-lg backdrop-blur"
  >
    <div class="flex items-start justify-between gap-2">
      <div>
        <div class="font-mono text-[11px] text-muted" data-testid="trip-ref">{{ trip.loadRef }}</div>
        <div class="text-sm font-semibold text-fg" data-testid="trip-driver">{{ trip.driverName }}</div>
      </div>
      <button
        class="rounded px-1 text-muted hover:text-fg"
        aria-label="Close trip card"
        data-testid="trip-close"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <!-- Hero: the one number a dispatcher acts on. -->
    <div class="mt-2 rounded bg-surface-3 px-2 py-2" data-testid="trip-eta">
      <template v-if="eta">
        <div class="flex items-baseline gap-2">
          <span class="text-lg font-semibold" :class="eta.late ? 'text-rose-400' : 'text-emerald-400'">
            {{ eta.approx ? '~' : '' }}{{ eta.at }}
          </span>
          <span class="text-muted">in {{ durationLabel(eta.inMs) }}</span>
        </div>
        <div class="text-[11px] text-muted">
          {{ trip.nextStop!.late ? 'PAST APPOINTMENT · ' : '' }}next stop {{ trip.nextStop!.label }}
        </div>
      </template>
      <template v-else>
        <div class="text-sm text-muted" data-testid="trip-eta-none">No stop ahead — every arrival is in the past</div>
      </template>
    </div>

    <div class="mt-2 text-[11px] text-muted" data-testid="trip-lane">
      {{ trip.origin }} <span class="text-fg">➔</span> {{ trip.destination }}
    </div>

    <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
      <dt class="text-muted">Break due in</dt>
      <dd class="text-right" data-testid="trip-break">
        <template v-if="breakIn">{{ breakIn }}</template>
        <!-- NOT "0h": nobody imported this driver's hours. -->
        <span v-else class="text-amber-400" title="HOS never imported for this driver">— HOS unknown</span>
      </dd>

      <dt class="text-muted">Position</dt>
      <dd class="text-right" data-testid="trip-ping">
        <template v-if="pingAge && !trip.positionStale">live · {{ pingAge }} ago</template>
        <span v-else-if="pingAge" class="text-amber-400">stale · {{ pingAge }} ago</span>
        <span v-else class="text-amber-400">never pinged</span>
      </dd>
    </dl>

    <!-- "Where are you?" — the driver's phone prompts and they press approve.
         Nothing here reads a position without that: `pending` is not a
         location, and `denied` is a real answer rather than missing data. -->
    <div class="mt-2 text-[11px]" data-testid="trip-location-request">
      <template v-if="locationRequest?.status === 'pending'">
        <span class="text-amber-400">Location requested — waiting on driver</span>
      </template>
      <template v-else-if="locationRequest?.status === 'denied'">
        <span class="text-rose-400">Driver declined to share location</span>
      </template>
      <template v-else-if="locationRequest?.status === 'expired'">
        <span class="text-muted">Location request expired — no answer</span>
      </template>
      <template v-else-if="locationRequest?.status === 'approved' && locationRequest.location">
        <span class="text-emerald-400">
          Shared {{ locationRequest.location.latitude.toFixed(3) }}, {{ locationRequest.location.longitude.toFixed(3) }}
        </span>
      </template>
      <button
        v-else
        class="w-full rounded border border-line px-2 py-1.5 font-medium hover:bg-surface-3 disabled:opacity-50"
        data-testid="trip-ask-location"
        :disabled="asking"
        @click="askLocation"
      >
        {{ asking ? 'Asking…' : 'Ask driver for location' }}
      </button>
    </div>

    <button
      class="mt-2 w-full rounded bg-surface-3 px-2 py-1.5 text-[11px] font-medium hover:bg-surface-2"
      data-testid="trip-show-board"
      @click="emit('show-on-board', trip.loadId)"
    >
      Show on board
    </button>
  </div>
</template>
