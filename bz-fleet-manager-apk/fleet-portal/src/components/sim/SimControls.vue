<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { useSimStore } from '../../stores/sim'
import { fmtDT } from '../../lib/cockpit/format'

// Simulation controls (AI Dispatch Foundation, Task 8 backend / Task 10 UI):
// a compact bar mounted on Driver Supply and the Cockpit toolbar. Renders
// NOTHING once a probe finds the /sim endpoints absent (a real, non-demo
// tenant) — see stores/sim.ts's probe(). Every field below is read
// defensively (typeof checks, not bare truthiness on `sim.state`) because
// a handful of existing view specs mock `api.get` with a generic catch-all
// that does not know this shape — the same "never trust the wire" rule
// stores/tracking.ts already applies to realtime frames.
const sim = useSimStore()
const auth = useAuthStore()
const tz = computed(() => auth.org?.timezone ?? 'America/Chicago')

const SPEEDS = [1, 5, 15, 60] as const
const speed = ref<number>(SPEEDS[0])
const reseeding = ref(false)
let reseedTimer: number | null = null

onMounted(() => {
  void sim.probe()
})
onUnmounted(() => {
  if (reseedTimer !== null) window.clearInterval(reseedTimer)
})

const running = computed(() => sim.state?.running === true)
const simNowLabel = computed(() => {
  const ms = sim.state?.simNowMs
  return typeof ms === 'number' ? fmtDT(ms, tz.value) : '—'
})
const advancedLabel = computed(() => {
  const min = sim.state?.simMinutesAdvanced
  return `+${typeof min === 'number' ? min : 0} min`
})

async function tick(minutes: number): Promise<void> {
  await sim.tick(minutes)
}

async function toggleRun(): Promise<void> {
  if (running.value) await sim.stop()
  else await sim.start(speed.value)
}

/** Reset kicks off an async reseed server-side (a spawned child process,
 *  no completion signal on the response itself) — "reseeding…" stays up
 *  until a poll of probe() shows the fresh post-reset signature
 *  (dispatcherSim.ts's own reset handler: simMinutesAdvanced back to 0,
 *  lastTickAt cleared). */
async function resetWorld(): Promise<void> {
  if (!window.confirm('Reset the demo world? This replaces every driver, load and assignment.')) return
  reseeding.value = true
  await sim.reset()
  if (reseedTimer !== null) window.clearInterval(reseedTimer)
  reseedTimer = window.setInterval(() => {
    void sim.probe().then(() => {
      const s = sim.state
      if (s && s.simMinutesAdvanced === 0 && s.lastTickAt === null) {
        reseeding.value = false
        if (reseedTimer !== null) window.clearInterval(reseedTimer)
        reseedTimer = null
      }
    })
  }, 1500)
}
</script>

<template>
  <section
    v-if="sim.available !== false"
    class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[11px]"
    data-testid="sim-controls"
  >
    <span class="font-bold text-ink">Sim</span>
    <span data-testid="sim-now">{{ simNowLabel }} ({{ advancedLabel }})</span>
    <span
      class="rounded-full px-2 py-0.5 text-[10px] font-bold"
      :class="running ? 'bg-emerald-500/20 text-emerald-500' : 'bg-surface-3 text-ink-3'"
      data-testid="sim-run-badge"
    >
      {{ running ? `running · ${sim.state?.speed}x` : 'stopped' }}
    </span>
    <span v-if="reseeding" class="text-amber-700 dark:text-amber-400" data-testid="sim-reseeding">reseeding…</span>

    <div class="ml-auto flex flex-wrap items-center gap-1.5">
      <button type="button" class="rounded border border-line px-2 py-1 hover:border-line-strong disabled:opacity-40" :disabled="sim.busy" data-testid="sim-tick-15" @click="tick(15)">+15 min</button>
      <button type="button" class="rounded border border-line px-2 py-1 hover:border-line-strong disabled:opacity-40" :disabled="sim.busy" data-testid="sim-tick-60" @click="tick(60)">+1 h</button>
      <button type="button" class="rounded border border-line px-2 py-1 hover:border-line-strong disabled:opacity-40" :disabled="sim.busy" data-testid="sim-tick-240" @click="tick(240)">+4 h</button>
      <select v-model.number="speed" class="rounded border border-line bg-surface-2 px-1 py-1" :disabled="sim.busy || running" data-testid="sim-speed">
        <option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}x</option>
      </select>
      <button type="button" class="rounded border border-line px-2 py-1 hover:border-line-strong disabled:opacity-40" :disabled="sim.busy" data-testid="sim-toggle-run" @click="toggleRun">
        {{ running ? 'Stop' : 'Start' }}
      </button>
      <button type="button" class="rounded border border-red-500/40 px-2 py-1 text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-40" :disabled="sim.busy" data-testid="sim-reset" @click="resetWorld">
        Reset world
      </button>
    </div>
  </section>
</template>
