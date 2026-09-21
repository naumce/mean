<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchDemoShiftPlan, runDemoShift, type DemoShiftPlan } from '../../lib/api'

// The demo control: move the seeded week forward so it lands under today.
//
// A generated scenario goes stale by simply existing — three days later the
// trucks that were mid-run have finished and the board's future is empty. This
// shifts every date forward by whole days instead of regenerating, so the rest
// stops, the carrier terms and anything demonstrated in a meeting survive.
//
// Renders NOTHING unless the server has demo mode on. The probe is the gate:
// the endpoint 404s on a normal server, so there is no second "is this a demo"
// flag in the portal to drift out of sync with the backend.

const plan = ref<DemoShiftPlan | null>(null)
const running = ref(false)
const result = ref<string | null>(null)

async function probe(): Promise<void> {
  plan.value = await fetchDemoShiftPlan()
}

onMounted(probe)

async function shift(): Promise<void> {
  running.value = true
  result.value = null
  try {
    const done = await runDemoShift()
    // Say what actually happened. "Moved 0 days" and "moved 4 days" are
    // different outcomes and the button must not report them the same way.
    result.value = done.shifted ? `Moved ${done.days} day${done.days === 1 ? '' : 's'} — reloading…` : done.reason
    if (done.shifted) {
      // Every store on screen holds pre-shift timestamps. Patching them one by
      // one would leave whichever view nobody remembered showing last week's
      // clock; a reload is the honest way to re-read all of it at once.
      setTimeout(() => window.location.reload(), 700)
      return
    }
    await probe()
  } catch {
    result.value = 'Could not move the demo data'
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div v-if="plan" class="rounded-lg border border-line bg-surface-2 p-3" data-testid="demo-time-shift">
    <p class="text-xs font-semibold text-ink-2">Demo data</p>

    <p v-if="plan.shifted" class="mt-1 text-xs leading-relaxed text-ink-3" data-testid="demo-stale">
      The scenario is
      <span class="font-semibold text-brand-ink">{{ plan.days }} day{{ plan.days === 1 ? '' : 's' }}</span>
      behind today.
    </p>
    <p v-else class="mt-1 text-xs leading-relaxed text-ink-3" data-testid="demo-current">
      {{ plan.reason }}
    </p>

    <button
      class="mt-2 w-full rounded border border-line py-1 text-[11px] font-semibold text-ink-2 hover:text-ink disabled:opacity-50"
      data-testid="demo-shift-button"
      :disabled="running || !plan.shifted"
      @click="shift"
    >
      {{ running ? 'Moving…' : 'Move demo to today' }}
    </button>

    <p v-if="result" class="mt-1 text-[11px] text-ink-3" data-testid="demo-shift-result">{{ result }}</p>
  </div>
</template>
