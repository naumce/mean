<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { inBounds, project, US_OUTLINE } from '../../lib/map/usMap'
import type { DriverLocation } from '../../types/dispatcher'

// The mockup's Map view, real data only: each dot is a driver's latest GPS
// ping (polling + live driver_location pushes). Fresh pings (< 15 min) are
// emerald, stale ones gray. Optional service shops render as amber squares —
// the Fleet screen uses them to route a unit to the nearest wrench.
export interface MapShop {
  name: string
  lat: number | null
  lng: number | null
}

const props = defineProps<{ locations: DriverLocation[]; shops?: MapShop[] }>()

const FRESH_MS = 15 * 60_000
const HEIGHT = 380

const canvasEl = ref<HTMLCanvasElement | null>(null)
const wrapEl = ref<HTMLElement | null>(null)

function draw(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const w = (canvas.width = Math.max(wrapEl.value?.clientWidth ?? 800, 320))
  const h = (canvas.height = HEIGHT)

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(0, 0, w, h)

  // Continental silhouette.
  ctx.beginPath()
  US_OUTLINE.forEach(([lat, lng], i) => {
    const p = project(lat, lng, w, h)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.closePath()
  ctx.fillStyle = '#f1f5f9'
  ctx.fill()
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Service shops: amber squares under the driver layer.
  ctx.font = '11px system-ui, sans-serif'
  for (const shop of props.shops ?? []) {
    if (shop.lat == null || shop.lng == null || !inBounds(shop.lat, shop.lng)) continue
    const p = project(shop.lat, shop.lng, w, h)
    ctx.fillStyle = '#f59e0b'
    ctx.fillRect(p.x - 5, p.y - 5, 10, 10)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.strokeRect(p.x - 5, p.y - 5, 10, 10)
    ctx.fillStyle = '#92400e'
    ctx.fillText(shop.name, p.x + 9, p.y + 4)
  }

  // Driver dots + labels.
  const now = Date.now()
  for (const loc of props.locations) {
    if (!inBounds(loc.latitude, loc.longitude)) continue
    const p = project(loc.latitude, loc.longitude, w, h)
    const fresh = now - new Date(loc.createdAt).getTime() < FRESH_MS
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = fresh ? '#10b981' : '#9ca3af'
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = '#374151'
    ctx.fillText(loc.driverName ?? loc.driverId.slice(0, 6), p.x + 8, p.y + 4)
  }
}

watch(() => [props.locations, props.shops], draw, { deep: true })
onMounted(() => {
  draw()
  window.addEventListener('resize', draw)
})
onBeforeUnmount(() => window.removeEventListener('resize', draw))
</script>

<template>
  <div ref="wrapEl" class="overflow-hidden rounded-lg border border-gray-200" data-testid="fleet-map">
    <canvas ref="canvasEl" :height="HEIGHT" class="block w-full" />
    <div class="flex items-center justify-between border-t border-gray-100 bg-white px-3 py-1.5 text-xs text-gray-500">
      <span>
        <span class="mr-3"><span class="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />ping &lt; 15 min</span>
        <span class="mr-3"><span class="mr-1 inline-block h-2 w-2 rounded-full bg-gray-400" />stale</span>
        <span v-if="shops?.length"><span class="mr-1 inline-block h-2 w-2 bg-amber-500" />service shop</span>
      </span>
      <span v-if="locations.length === 0 && !shops?.length" data-testid="map-empty">
        No driver positions yet — pings appear here live.
      </span>
    </div>
  </div>
</template>
