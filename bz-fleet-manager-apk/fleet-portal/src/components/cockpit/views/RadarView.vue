<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { ageLabel, cityOf, hrsLabel, initials } from '../../../lib/cockpit/format'
import { progressShare } from '../../../lib/cockpit/lifecycle'
import {
  driverPositions as computeDriverPositions,
  extractRoutes,
  isFreshPing,
  mapboxToken,
  pingsByDriver,
  type RouteInfo,
} from '../../../lib/cockpit/mapData'
import { controlPoint, quadraticPoint } from '../../../lib/cockpit/mapGeometry'
import { useLoadboardStore, type LoadboardLane } from '../../../stores/loadboard'
import { useTrackingStore } from '../../../stores/tracking'

// Schematic network radar: real stop coordinates and real GPS pings projected
// into the bounding box of everything in view. When VITE_MAPBOX_TOKEN is
// configured, the real map (FleetMap) renders instead — see `useMap` below.
// Route/stop extraction, driver positions and the ping-freshness rule live in
// lib/cockpit/mapData.ts, shared with FleetMap so the two views can't drift.
//
// FleetMap pulls in mapbox-gl (~500KB gzipped — see its own module docs);
// loading it async keeps that cost out of every dispatcher's bundle when no
// token is configured (dev/CI today) — Vue never invokes the loader unless
// `useMap` actually renders the v-if branch below.
const FleetMap = defineAsyncComponent(() => import('./FleetMap.vue'))
const props = defineProps<{ nowMs: number }>()
const emit = defineEmits<{ open: [loadId: string] }>()
const lb = useLoadboardStore()
const tracking = useTrackingStore()
const MW = 1000
const MH = 520
const PAD = 0.6
const STROKE: Record<string, string> = { assigned: 'stroke-s-assigned', tendered: 'stroke-s-tendered', in_progress: 'stroke-s-progress', completed: 'stroke-s-completed', delivered: 'stroke-s-completed' }
const FILL: Record<string, string> = { assigned: 'fill-s-assigned', tendered: 'fill-s-tendered', in_progress: 'fill-s-progress', completed: 'fill-s-completed', delivered: 'fill-s-completed' }

const useMap = !!mapboxToken()

const routes = computed<RouteInfo[]>(() => extractRoutes(lb.loads))
const pings = computed(() => pingsByDriver(tracking.locations))
const rollingDrivers = computed(() => new Set(routes.value.filter((r) => r.status === 'in_progress').map((r) => r.load.assignment!.driverId)))
const driverPositions = computed(() => computeDriverPositions(lb.lanes, pings.value))
const box = computed(() => {
  const pts: Array<[number, number]> = []
  for (const r of routes.value) pts.push([r.a.lng!, r.a.lat!], [r.b.lng!, r.b.lat!])
  for (const pos of driverPositions.value.values()) pts.push([pos.lng, pos.lat])
  if (!pts.length) return { x0: -99, x1: -79, y0: 28.5, y1: 44 }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs) - PAD, x1: Math.max(...xs) + PAD, y0: Math.min(...ys) - PAD, y1: Math.max(...ys) + PAD }
})
const px = (lng: number): number => ((lng - box.value.x0) / (box.value.x1 - box.value.x0)) * MW
const py = (lat: number): number => ((box.value.y1 - lat) / (box.value.y1 - box.value.y0)) * MH
// The control point and the point-at-t formula come from mapGeometry.ts —
// the same functions FleetMap's live-map arcs use via `arcBetween`/
// `routePath` — so the schematic and the real map agree on what a route's
// curve looks like instead of each hand-rolling their own copy of this math.
function curve(r: RouteInfo) {
  const p1: [number, number] = [px(r.a.lng!), py(r.a.lat!)]
  const p2: [number, number] = [px(r.b.lng!), py(r.b.lat!)]
  const c = controlPoint(p1, p2)
  const t = progressShare(r.status, Date.parse(r.load.assignment!.plannedStart), Date.parse(r.load.assignment!.plannedEnd), props.nowMs)
  const [interpolatedX, interpolatedY] = quadraticPoint(p1, c, p2, t)
  // A measured position beats a projection: a fresh ping for this leg's driver
  // draws the rolling marker at the real fix instead of the time-interpolated
  // point on the curve. The curve itself, and the fallback, are unchanged.
  const ping = pings.value.get(r.load.assignment!.driverId)
  const freshPing = isFreshPing(ping, props.nowMs) ? ping : null
  const qx = freshPing ? px(freshPing.longitude) : interpolatedX
  const qy = freshPing ? py(freshPing.latitude) : interpolatedY
  return { d: `M${p1[0]},${p1[1]} Q${c[0]},${c[1]} ${p2[0]},${p2[1]}`, x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], qx, qy }
}
interface DriverPin { d: LoadboardLane; pos: { lat: number; lng: number } }
const drivers = computed((): DriverPin[] => {
  const out: DriverPin[] = []
  for (const d of lb.lanes) {
    if (rollingDrivers.value.has(d.id)) continue
    const pos = driverPositions.value.get(d.id)
    if (pos) out.push({ d, pos })
  }
  return out
})
const telemetry = computed(() =>
  lb.lanes.map((d) => {
    const p = pings.value.get(d.id)
    const live = isFreshPing(p, props.nowMs)
    return { d, text: live ? (p!.speed != null ? `${Math.round(p!.speed)} MPH` : 'MOVING') : p ? `last ping ${ageLabel(p.createdAt, props.nowMs)}` : 'no GPS', live }
  }),
)
</script>

<template>
  <FleetMap v-if="useMap" :now-ms="nowMs" @open="emit('open', $event)" />
  <div v-else class="rounded-xl border border-line bg-surface p-3 shadow-2xl">
    <div class="flex items-center justify-between border-b border-line pb-2 text-xs">
      <div class="font-bold text-ink">🗺️ GPS Telemetry Radar <span class="font-mono text-[10px] font-normal text-ink-3">schematic · {{ routes.length }} legs in view · real tiles arrive with the live-map increment</span></div>
      <div class="flex gap-3 font-mono text-[10px] text-ink-3"><span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-assigned" />Assigned</span><span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-tendered" />Tendered</span><span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-progress" />Rolling</span><span class="flex items-center gap-1"><span class="inline-block h-[3px] w-3 rounded bg-s-completed" />Delivered</span><span class="flex items-center gap-1"><span class="inline-block h-3 w-3 rounded-sm bg-slate-400" />Idle unit</span></div>
    </div>
    <svg :viewBox="`0 0 ${MW} ${MH}`" class="mt-2 block w-full rounded-lg bg-surface-3">
      <template v-for="r in routes" :key="r.load.id">
        <path :d="curve(r).d" fill="none" stroke-width="2.6" stroke-linecap="round" opacity=".85" :class="STROKE[r.status] ?? STROKE.assigned" :stroke-dasharray="r.status === 'completed' ? '4 4' : r.status === 'tendered' ? '6 3' : undefined" :data-route="r.load.id" />
        <g class="cursor-pointer" :data-pin="r.load.id" @click="emit('open', r.load.id)">
          <template v-if="r.status === 'in_progress'">
            <circle :cx="curve(r).qx" :cy="curve(r).qy" r="11" opacity=".25" :class="FILL[r.status]"><animate attributeName="r" values="9;16;9" dur="2s" repeatCount="indefinite" /></circle>
            <circle :cx="curve(r).qx" :cy="curve(r).qy" r="8" stroke="white" stroke-width="2" :class="FILL[r.status]" />
            <text :x="curve(r).qx + 12" :y="curve(r).qy - 8" class="fill-ink font-mono text-[10px] font-bold">{{ r.load.reference }}</text>
          </template>
          <circle :cx="curve(r).x2" :cy="curve(r).y2" r="4.5" stroke="white" stroke-width="1.5" :class="FILL[r.status] ?? FILL.assigned" />
        </g>
        <text :x="curve(r).x1 + 6" :y="curve(r).y1 + 3" class="fill-ink-3 text-[10px]">{{ cityOf(r.a.address) }}</text>
        <text :x="curve(r).x2 + 6" :y="curve(r).y2 + 3" class="fill-ink-3 text-[10px]">{{ cityOf(r.b.address) }}</text>
      </template>
      <g v-for="entry in drivers" :key="entry.d.id" :data-driver="entry.d.id">
        <rect :x="px(entry.pos.lng) - 7" :y="py(entry.pos.lat) - 7" width="14" height="14" rx="3" class="fill-slate-400" opacity=".9" />
        <text :x="px(entry.pos.lng)" :y="py(entry.pos.lat) + 3.5" text-anchor="middle" class="fill-slate-900 font-mono text-[8px] font-extrabold">{{ initials(entry.d.name) }}</text>
        <text :x="px(entry.pos.lng) + 10" :y="py(entry.pos.lat) + 3" class="fill-ink-3 text-[10px]">{{ entry.d.lastCity ?? '' }}</text>
      </g>
    </svg>
    <div class="mt-3 overflow-x-auto">
      <table class="w-full font-mono text-[11px]">
        <thead><tr class="text-left text-[10px] uppercase tracking-wider text-ink-3"><th class="px-2 py-1.5">Unit</th><th class="px-2 py-1.5">Position</th><th class="px-2 py-1.5">Telemetry</th><th class="px-2 py-1.5">Clocks</th></tr></thead>
        <tbody>
          <tr v-for="t in telemetry" :key="t.d.id" class="border-t border-line/70">
            <td class="px-2 py-1.5 font-bold text-ink">{{ t.d.name }}</td>
            <td class="px-2 py-1.5 text-ink-2">{{ t.d.lastCity ?? 'position unknown' }}<span v-if="t.d.lastLocationAt" class="text-ink-3"> ({{ ageLabel(t.d.lastLocationAt, nowMs) }})</span></td>
            <td class="px-2 py-1.5 font-bold" :class="t.live ? 'text-emerald-500' : 'text-ink-3'">{{ t.text }}</td>
            <td class="px-2 py-1.5 text-ink-3">DRV {{ hrsLabel(t.d.hosKnown ? t.d.driveRemainingMin : null) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
