<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FRESH_MS, mapboxToken } from '../../lib/cockpit/mapData'
import { inBounds, project, US_OUTLINE } from '../../lib/map/usMap'
import { useThemeStore } from '../../stores/theme'
import type { DriverLocation } from '../../types/dispatcher'
import LiveMap, { type LiveMapPoint, type LiveMapShop } from '../map/LiveMap.vue'

// The mockup's Map view, real data only: each dot is a driver's latest GPS
// ping (polling + live driver_location pushes). Fresh pings (< 15 min) are
// emerald, stale ones gray. Optional service shops render as amber squares —
// the Fleet screen uses them to route a unit to the nearest wrench.
//
// This is the chooser: with a Mapbox token it renders the real LiveMap; without
// one it falls back to the hand-drawn canvas below (colours read from the theme
// CSS variables so the fallback is correct in dark mode too).
export interface MapShop {
  name: string
  lat: number | null
  lng: number | null
}

const props = defineProps<{
  locations: DriverLocation[]
  shops?: MapShop[]
  /** Per-marker colour override (Driver Supply: colour by availability
   *  status). Returning null for a location keeps today's freshness colour —
   *  the prop is additive and every existing caller that omits it draws
   *  exactly as before. */
  markerColor?: (location: DriverLocation) => string | null
}>()

const HEIGHT = 380
const FRESH_COLOR = '#10b981'
const STALE_COLOR = '#9ca3af'
// Mapbox dots are DOM, so the CSS variable resolves live and flips with the theme.
const STALE_DOT_COLOR = 'rgb(var(--tk-ink-3))'
const SHOP_COLOR = '#f59e0b'

// The Mapbox path is chosen once per mount: the token is a build-time env var.
const useMapbox = mapboxToken() !== undefined

const mapPoints = computed<LiveMapPoint[]>(() => {
  const now = Date.now()
  return props.locations.map((loc) => {
    const fresh = now - new Date(loc.createdAt).getTime() < FRESH_MS
    return {
      id: loc.driverId,
      label: loc.driverName ?? loc.driverId.slice(0, 6),
      lat: loc.latitude,
      lng: loc.longitude,
      color: props.markerColor?.(loc) ?? (fresh ? FRESH_COLOR : STALE_DOT_COLOR),
      stale: !fresh,
    }
  })
})

const mapShops = computed<LiveMapShop[]>(() =>
  (props.shops ?? []).flatMap((s) => (s.lat == null || s.lng == null ? [] : [{ name: s.name, lat: s.lat, lng: s.lng }])),
)

/** A theme token as a canvas colour. Tokens are space-separated RGB triplets;
 *  jsdom (and a missing stylesheet) yields '', so the light value is the
 *  fallback. */
function token(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw ? `rgb(${raw.split(/\s+/).join(',')})` : fallback
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const wrapEl = ref<HTMLElement | null>(null)

function draw(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const w = (canvas.width = Math.max(wrapEl.value?.clientWidth ?? 800, 320))
  const h = (canvas.height = HEIGHT)

  ctx.clearRect(0, 0, w, h)
  const surface = token('--tk-surface', '#ffffff')
  ctx.fillStyle = token('--tk-bg', '#f8fafc')
  ctx.fillRect(0, 0, w, h)

  // Continental silhouette.
  ctx.beginPath()
  US_OUTLINE.forEach(([lat, lng], i) => {
    const p = project(lat, lng, w, h)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.closePath()
  ctx.fillStyle = token('--tk-surface-2', '#f1f5f9')
  ctx.fill()
  ctx.strokeStyle = token('--tk-line-strong', '#cbd5e1')
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Service shops: amber squares under the driver layer.
  ctx.font = '11px system-ui, sans-serif'
  const labelInk = token('--tk-ink-2', '#374151')
  const staleInk = token('--tk-ink-3', STALE_COLOR)
  for (const shop of props.shops ?? []) {
    if (shop.lat == null || shop.lng == null || !inBounds(shop.lat, shop.lng)) continue
    const p = project(shop.lat, shop.lng, w, h)
    ctx.fillStyle = SHOP_COLOR
    ctx.fillRect(p.x - 5, p.y - 5, 10, 10)
    ctx.strokeStyle = surface
    ctx.lineWidth = 1.5
    ctx.strokeRect(p.x - 5, p.y - 5, 10, 10)
    ctx.fillStyle = labelInk
    ctx.fillText(shop.name, p.x + 9, p.y + 4)
  }

  // Driver dots + labels.
  const now = Date.now()
  for (const loc of props.locations) {
    if (!inBounds(loc.latitude, loc.longitude)) continue
    const p = project(loc.latitude, loc.longitude, w, h)
    const fresh = now - new Date(loc.createdAt).getTime() < FRESH_MS
    const customColor = props.markerColor?.(loc) ?? null
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = customColor ?? (fresh ? FRESH_COLOR : staleInk)
    ctx.fill()
    ctx.strokeStyle = surface
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = labelInk
    ctx.fillText(loc.driverName ?? loc.driverId.slice(0, 6), p.x + 8, p.y + 4)
  }
}

watch(() => [props.locations, props.shops], draw, { deep: true })
// The canvas reads the theme tokens only when it draws, so a flip must redraw.
const theme = useThemeStore()
watch(() => theme.isDark, () => draw())
onMounted(() => {
  if (useMapbox) return
  draw()
  window.addEventListener('resize', draw)
})
onBeforeUnmount(() => window.removeEventListener('resize', draw))
</script>

<template>
  <div ref="wrapEl" class="overflow-hidden rounded-lg border border-line" data-testid="fleet-map">
    <LiveMap v-if="useMapbox" :points="mapPoints" :shops="mapShops" :height="HEIGHT" :bordered="false" />
    <canvas v-else ref="canvasEl" :height="HEIGHT" class="block w-full" />
    <div class="flex items-center justify-between border-t border-line bg-surface px-3 py-1.5 text-xs text-ink-3">
      <span>
        <span class="mr-3"><span class="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />ping &lt; 15 min</span>
        <span class="mr-3"><span class="mr-1 inline-block h-2 w-2 rounded-full bg-ink-3" />stale</span>
        <span v-if="shops?.length"><span class="mr-1 inline-block h-2 w-2 bg-amber-500" />service shop</span>
      </span>
      <span v-if="locations.length === 0 && !shops?.length" data-testid="map-empty">
        No driver positions yet — pings appear here live.
      </span>
    </div>
  </div>
</template>
