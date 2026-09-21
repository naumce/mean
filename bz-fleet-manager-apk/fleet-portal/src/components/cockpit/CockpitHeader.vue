<script setup lang="ts">
import { computed } from 'vue'
import { dayColumns } from '../../lib/cockpit/geometry'
import type { GroupBy } from '../../lib/cockpit/lanes'
import { useAuthStore } from '../../stores/auth'
import { useCockpitStore } from '../../stores/cockpit'
import { useThemeStore } from '../../stores/theme'

// The command bar: brand + dispatcher, spot search, the window controls,
// activity bell, theme toggle. Cockpit review 2026-09-19 cut the hotkey
// legend, wall clock, diesel price and the "GPS Radar" tab: the radar is
// reached from the drawer's "show on map" (ck.focusOnMap), and the only
// control it needs up here is the way back to the board.
const props = defineProps<{ nowMs: number; spotted: number }>()
const emit = defineEmits<{ toggleActivity: []; messages: [] }>()
const ck = useCockpitStore()
const auth = useAuthStore()
const theme = useThemeStore()

const GROUPS: Array<{ key: GroupBy; label: string }> = [
  { key: 'driver', label: 'Driver' },
  { key: 'tractor', label: 'Tractor' },
  { key: 'trailer', label: 'Trailer' },
  { key: 'carrier', label: 'Carrier' },
]
const DAYS = [1, 3, 5, 7]
const cols = computed(() => dayColumns(ck.config, props.nowMs))
const rangeLabel = computed(() => (cols.value.length > 1 ? `${cols.value[0].label} – ${cols.value[cols.value.length - 1].label}` : cols.value[0]?.label ?? ''))
const SEG_ON = 'rounded bg-surface-3 px-2 py-1 font-bold text-ink'
const SEG_OFF = 'rounded px-2 py-1 text-ink-3 hover:text-ink'
</script>

<template>
  <header class="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-2 shadow-2xl">
    <div class="flex items-center gap-2.5">
      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 font-black text-white shadow-lg ring-1 ring-white/20">⚡</div>
      <div>
        <div class="flex items-center gap-2 text-xs font-black tracking-tight text-ink">
          DISPATCH CONTROL TOWER
          <span class="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 text-[9px] font-bold text-emerald-500"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> COCKPIT</span>
        </div>
        <div class="font-mono text-[10px] text-ink-3">DISPATCHER: {{ (auth.dispatcher?.name ?? 'dispatcher').toUpperCase() }}</div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <div class="flex w-72 items-center gap-2 rounded-lg border border-line bg-surface-3 px-3 py-1.5 text-xs shadow-inner focus-within:border-spot">
        <span class="font-mono font-bold text-spot">🔍 Spot:</span>
        <input id="spotInput" type="text" :value="ck.search" placeholder="City, leg, trailer, driver…  (⌘K)" class="w-full bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-3" @input="ck.setSearch(($event.target as HTMLInputElement).value)" />
        <button v-if="ck.search" type="button" class="whitespace-nowrap rounded bg-spot/20 px-1.5 py-0.5 font-mono text-[9px] font-bold text-spot" data-testid="spot-clear" @click="ck.setSearch('')">{{ spotted }} ✕</button>
      </div>
      <button v-if="ck.view === 'radar'" type="button" class="rounded-lg border border-line bg-surface-3 px-2.5 py-1 text-xs font-bold text-ink hover:border-line-strong" data-view="board" @click="ck.setView('board')">📅 Back to board</button>
    </div>

    <div class="flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <div class="flex rounded-lg border border-line bg-surface-3 p-0.5">
        <button v-for="g in GROUPS" :key="g.key" type="button" :class="ck.groupBy === g.key ? SEG_ON : SEG_OFF" :data-group="g.key" @click="ck.setGroupBy(g.key)">{{ g.label }}</button>
      </div>
      <div class="flex rounded-lg border border-line bg-surface-3 p-0.5">
        <button v-for="d in DAYS" :key="d" type="button" :class="ck.days === d ? SEG_ON : SEG_OFF" :data-days="d" @click="ck.setDays(d)">{{ d }}-DAY</button>
      </div>
      <div class="flex items-center gap-1.5 rounded-lg border border-line bg-surface-3 px-2 py-1">
        <span class="text-[10px] font-bold uppercase text-ink-3">Zoom</span>
        <input type="range" min="10" max="72" :value="ck.pxPerHour" class="h-1 w-16 cursor-pointer accent-blue-500" data-testid="zoom" @input="ck.setZoom(Number(($event.target as HTMLInputElement).value))" />
        <span class="text-[10px] font-bold text-blue-500">{{ ck.pxPerHour }}px/h</span>
      </div>
      <div class="flex items-center gap-1 rounded-lg border border-line bg-surface-3 p-0.5">
        <button type="button" class="rounded px-2 py-1 text-ink-3 hover:bg-surface hover:text-ink" data-testid="prev-day" @click="ck.shiftDays(-1)">◀</button>
        <span class="px-2 font-bold text-ink" data-testid="range-label">{{ rangeLabel }}</span>
        <button type="button" class="rounded px-2 py-1 text-ink-3 hover:bg-surface hover:text-ink" data-testid="next-day" @click="ck.shiftDays(1)">▶</button>
      </div>
      <button type="button" class="rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-xs hover:border-line-strong" title="Driver messages" @click="emit('messages')">💬</button>
      <button type="button" class="relative rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-xs hover:border-line-strong" title="Activity" data-testid="bell" @click="emit('toggleActivity')">
        🔔<span v-if="ck.unreadActivity" class="absolute -right-1.5 -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white" data-testid="bell-badge">{{ ck.unreadActivity }}</span>
      </button>
      <button type="button" class="rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-xs hover:border-line-strong" :title="theme.isDark ? 'Light mode' : 'Dark mode'" data-testid="theme-toggle" @click="theme.toggle()">{{ theme.isDark ? '☀' : '◐' }}</button>
    </div>
  </header>
</template>
