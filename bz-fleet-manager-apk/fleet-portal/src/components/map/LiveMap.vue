<script setup lang="ts">
import mapboxgl from 'mapbox-gl'
import type { Map as MapboxMap, Marker as MapboxMarker, Popup as MapboxPopup } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { mapboxToken, mapStyleFor } from '../../lib/cockpit/mapData'
import { useThemeStore } from '../../stores/theme'

// A standalone Mapbox map of labelled dots (fleet pings) and amber shop
// squares. No store reads beyond the theme: callers hand in plain points.
// Markers are created once per id and moved in place on every change — never
// rebuilt — so a GPS tick doesn't flicker or re-request tiles.
export interface LiveMapPoint {
  id: string
  label: string
  lat: number
  lng: number
  color?: string
  stale?: boolean
}
export interface LiveMapShop {
  name: string
  lat: number
  lng: number
}

const props = withDefaults(
  defineProps<{ points: LiveMapPoint[]; shops?: LiveMapShop[]; height?: number; bordered?: boolean }>(),
  { shops: () => [], height: 380, bordered: true },
)

const US_CENTER: [number, number] = [-96, 38]
const US_ZOOM = 3
const FIT_PADDING = 40
const FIT_MAX_ZOOM = 7
// Below this zoom the labels pile up into an unreadable smear; the dots stay.
const LABEL_MIN_ZOOM = 5.5
const STALE_OPACITY = '0.6'
const BRAND = 'rgb(var(--tk-brand))'
const SHOP_COLOR = '#f59e0b'

interface Entry {
  marker: MapboxMarker
  popup: MapboxPopup
  dot: HTMLElement
  label: HTMLElement
  text: string
}

const theme = useThemeStore()
const container = ref<HTMLElement | null>(null)
const labelsOn = ref(false)
let map: MapboxMap | null = null
const pointEntries = new Map<string, Entry>()
const shopEntries = new Map<string, Entry>()
let fittedKey = ''

function isFiniteLngLat(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng)
}

function buildEntry(m: MapboxMap, text: string, shape: 'dot' | 'shop', lat: number, lng: number): Entry {
  const el = document.createElement('div')
  el.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:default'
  const dot = document.createElement('div')
  dot.style.cssText =
    shape === 'dot'
      ? 'width:10px;height:10px;border-radius:9999px;border:1.5px solid rgb(var(--tk-surface))'
      : `width:10px;height:10px;background:${SHOP_COLOR};border:1.5px solid rgb(var(--tk-surface))`
  const label = document.createElement('span')
  label.className = 'lm-label'
  label.textContent = text
  label.style.cssText =
    'margin-top:2px;font:600 10px/1.1 system-ui,sans-serif;color:rgb(var(--tk-ink));text-shadow:0 0 3px rgb(var(--tk-surface)),0 0 3px rgb(var(--tk-surface));white-space:nowrap;pointer-events:none'
  el.append(dot, label)
  const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }).setText(text)
  const marker = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(m)
  el.addEventListener('mouseenter', () => popup.setLngLat(marker.getLngLat()).addTo(m))
  el.addEventListener('mouseleave', () => popup.remove())
  return { marker, popup, dot, label, text }
}

function applyPoint(entry: Entry, p: LiveMapPoint): void {
  entry.marker.setLngLat([p.lng, p.lat])
  entry.dot.style.background = p.color ?? BRAND
  entry.dot.style.opacity = p.stale ? STALE_OPACITY : '1'
  if (entry.text !== p.label) {
    entry.label.textContent = p.label
    entry.popup.setText(p.label)
    entry.text = p.label
  }
}

function dropEntry(entries: Map<string, Entry>, key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entry.popup.remove()
  entry.marker.remove()
  entries.delete(key)
}

function syncPoints(m: MapboxMap): void {
  const live = props.points.filter((p) => isFiniteLngLat(p.lat, p.lng))
  const ids = new Set(live.map((p) => p.id))
  for (const id of [...pointEntries.keys()]) if (!ids.has(id)) dropEntry(pointEntries, id)
  for (const p of live) {
    let entry = pointEntries.get(p.id)
    if (!entry) {
      entry = buildEntry(m, p.label, 'dot', p.lat, p.lng)
      pointEntries.set(p.id, entry)
    }
    applyPoint(entry, p)
  }
}

function syncShops(m: MapboxMap): void {
  const live = props.shops.filter((s) => isFiniteLngLat(s.lat, s.lng))
  const keyOf = (s: LiveMapShop): string => `${s.name}@${s.lat},${s.lng}`
  const keys = new Set(live.map(keyOf))
  for (const key of [...shopEntries.keys()]) if (!keys.has(key)) dropEntry(shopEntries, key)
  for (const s of live) {
    if (!shopEntries.has(keyOf(s))) shopEntries.set(keyOf(s), buildEntry(m, s.name, 'shop', s.lat, s.lng))
  }
}

// Refit only when the SET of points changes — a ping that merely moves a dot
// must not yank the camera away from wherever the dispatcher has panned to.
function fit(m: MapboxMap): void {
  const live = props.points.filter((p) => isFiniteLngLat(p.lat, p.lng))
  const key = live.map((p) => p.id).sort().join('|')
  if (key === fittedKey) return
  fittedKey = key
  if (live.length === 0) {
    m.jumpTo({ center: US_CENTER, zoom: US_ZOOM })
    return
  }
  const bounds = new mapboxgl.LngLatBounds()
  for (const p of live) bounds.extend([p.lng, p.lat])
  m.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 0 })
}

function syncLabels(): void {
  if (map) labelsOn.value = map.getZoom() >= LABEL_MIN_ZOOM
}

function sync(): void {
  if (!map) return
  syncPoints(map)
  syncShops(map)
  fit(map)
}

onMounted(() => {
  const token = mapboxToken()
  if (!container.value || !token) return
  map = new mapboxgl.Map({
    container: container.value,
    style: mapStyleFor(theme.isDark),
    accessToken: token,
    center: US_CENTER,
    zoom: US_ZOOM,
  })
  map.on('zoom', syncLabels)
  map.on('zoomend', syncLabels)
  syncLabels()
  sync()
  syncLabels()
})

onBeforeUnmount(() => {
  for (const key of [...pointEntries.keys()]) dropEntry(pointEntries, key)
  for (const key of [...shopEntries.keys()]) dropEntry(shopEntries, key)
  map?.remove()
  map = null
})

watch(() => [props.points, props.shops], sync, { deep: true })
// Markers are DOM children of the map, so they survive a style swap.
watch(
  () => theme.isDark,
  (dark) => map?.setStyle(mapStyleFor(dark), { diff: false } as Parameters<MapboxMap['setStyle']>[1]),
)
</script>

<template>
  <div class="overflow-hidden rounded-lg" :class="bordered ? 'border border-line' : ''" data-testid="live-map">
    <div ref="container" class="lm-map w-full" :class="{ 'lm-labels-on': labelsOn }" :style="{ height: `${height}px` }" />
  </div>
</template>

<style scoped>
.lm-map:not(.lm-labels-on) :deep(.lm-label) {
  display: none;
}
</style>
