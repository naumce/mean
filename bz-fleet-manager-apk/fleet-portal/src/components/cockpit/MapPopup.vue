<script lang="ts">
import type { BreakMarker } from '../../lib/cockpit/mapData'
import type { BoardStop } from '../../stores/loadboard'

// T2 "Map as Navigation", Task 4: the one popup every clickable thing on the
// live map opens, so "what is this and what do I do about it" always has an
// answer and a way back to the board.
//
// The target is deliberately a thin pointer (which load / which driver /
// which stop), not a pre-flattened bag of display values — MapPopup resolves
// the rest itself from the loadboard store, the same way BrickPopover and
// MasterDrawer already do for the board's own popovers. That keeps FleetMap's
// click handlers trivial (they only know WHAT was clicked) and keeps every
// derived fact (ETAs, HOS, margin, risk) computed in exactly one place using
// the existing shared helpers — never re-derived here.
export interface TruckPopupTarget {
  kind: 'truck'
  loadId: string
}
export interface DriverPopupTarget {
  kind: 'driver'
  driverId: string
}
export interface StopPopupTarget {
  kind: 'stop'
  loadId: string
  /** Which end of the route this pin is — handed through by FleetMap exactly
   *  as it already decided when drawing the pin (see FleetMap.vue's `sync`),
   *  never re-derived from stop position/sequence here. */
  stopKind: 'pickup' | 'delivery'
  /** The exact BoardStop FleetMap resolved for this pin (mapData's
   *  `RouteInfo.a`/`.b`) — handed through rather than re-looked-up by index,
   *  since not every stop on a load is necessarily geocoded. */
  stop: BoardStop
}
/** T2 "Map as Navigation", Task 8: a trailer pin (Task 7). Deliberately NOT
 *  built alongside the other three in Task 4 — at that point nothing had
 *  ever written a trailer position, so a popup for one would have been dead
 *  code. Task 6 added the write, Task 7 added the pin; this is the popup. */
export interface TrailerPopupTarget {
  kind: 'trailer'
  trailerId: string
}
/** T2 "Map as Navigation", Task 8: a service-shop pin (the customer's OWN
 *  shop registry, stores/fleet.ts's ServiceShop — never third-party POI;
 *  see FleetMap.vue's own doc on why that pin is shown unconditionally).
 *  Same thin-pointer shape as every other target: just the id, resolved
 *  from the fleet store below. */
export interface ShopPopupTarget {
  kind: 'shop'
  shopId: string
}
/** T3 Break and Rest Planning, Task 8: a mandatory-break pin (Task 7's
 *  `breakPlan`, routed to the map per Ruling 7). `marker` is the FULL
 *  resolved `BreakMarker` — location, precision, coverage, ranked rest
 *  options — handed through by FleetMap exactly as it already resolved it
 *  when drawing the pin, the same "resolved record, not a thin pointer"
 *  precedent `StopPopupTarget.stop` set: a load can carry more than one
 *  break point, so "loadId alone" would leave this popup unable to tell
 *  which one was actually clicked. */
export interface BreakPopupTarget {
  kind: 'break'
  marker: BreakMarker
}
/** A fuel stop or rest area along the selected trip's route. Identified by id
 *  only; the row itself is read from the cockpit store, so the popup always
 *  shows the same values the marker was drawn from. */
export interface PoiPopupTarget {
  kind: 'poi'
  poiId: string
}

export type MapPopupTarget = TruckPopupTarget | DriverPopupTarget | StopPopupTarget | TrailerPopupTarget | ShopPopupTarget | BreakPopupTarget | PoiPopupTarget
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { ageLabel, fmtDT, hrsLabel } from '../../lib/cockpit/format'
import { needsService, nearestShop } from '../../lib/cockpit/serviceNeed'
import { stopEtas } from '../../lib/cockpit/stopEtas'
import { formatUsd } from '../../lib/money'
import { useCockpitStore } from '../../stores/cockpit'
import { useFleetStore } from '../../stores/fleet'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'

const props = defineProps<{ target: MapPopupTarget | null; anchor: HTMLElement | null; nowMs: number }>()
const emit = defineEmits<{ close: [] }>()
const ck = useCockpitStore()
const lb = useLoadboardStore()
const fleet = useFleetStore()

const visible = computed(() => !!props.target && !!props.anchor)

// Narrowed per-kind views of the prop, computed once here rather than
// re-testing `target.kind === '...'` all over the template — see MasterDrawer/
// BrickPopover for the same "push branching into script" convention.
const truckTarget = computed(() => (props.target?.kind === 'truck' ? props.target : null))
const driverTarget = computed(() => (props.target?.kind === 'driver' ? props.target : null))
const stopTarget = computed(() => (props.target?.kind === 'stop' ? props.target : null))
const trailerTarget = computed(() => (props.target?.kind === 'trailer' ? props.target : null))
const shopTarget = computed(() => (props.target?.kind === 'shop' ? props.target : null))
const breakTarget = computed(() => (props.target?.kind === 'break' ? props.target : null))

const pos = computed(() => {
  if (!props.anchor) return { left: '0px', top: '0px' }
  const r = props.anchor.getBoundingClientRect()
  const left = Math.min(r.left, Math.max(8, window.innerWidth - 312))
  const top = r.bottom + 280 > window.innerHeight ? Math.max(8, r.top - 290) : r.bottom + 8
  return { left: `${left}px`, top: `${top}px` }
})

const load = computed<BoardLoad | null>(() => {
  const loadId = truckTarget.value?.loadId ?? stopTarget.value?.loadId ?? null
  return loadId ? (lb.loads.find((l) => l.id === loadId) ?? null) : null
})
const assignment = computed(() => load.value?.assignment ?? null)
const driver = computed(() => {
  const driverId = driverTarget.value?.driverId ?? assignment.value?.driverId ?? null
  return driverId ? (lb.lanes.find((d) => d.id === driverId) ?? null) : null
})
const tractor = computed(() => {
  const id = driver.value?.currentTractorId ?? driver.value?.defaultTractorId ?? null
  return id ? (lb.tractors.find((t) => t.id === id) ?? null) : null
})
const trailer = computed(() => {
  const id = driver.value?.currentTrailerId ?? driver.value?.defaultTrailerId ?? null
  return id ? (lb.trailers.find((t) => t.id === id) ?? null) : null
})

/** T2 Task 8: the CLICKED trailer's own record — distinct from `trailer`
 *  above, which resolves a driver's currently-paired trailer for the driver
 *  popup's Equipment row. This is the trailer-popup's own subject.
 *
 *  T2 Task 8 (follow-up): a trailer reaching this popup via a real map
 *  click is ALWAYS dropped now — `mapData.ts`'s `positionedTrailers` (the
 *  only thing that creates a trailer pin) excludes any trailer with a
 *  `currentDriverId` entirely, because a hooked trailer's stored position
 *  is its last DROP-OFF point, not where it is now: it may be hours down
 *  the highway on a truck that's since driven away. Rendering that as a pin
 *  was "stale shown as current" — the same lie as "absent shown as
 *  measured", just with a timestamp attached to make it look trustworthy.
 *  A trailer pin means exactly one thing: "this equipment is sitting
 *  somewhere with no tractor." There is therefore no "hooked" branch here
 *  any more (no Status row, no "Show on board" jump to the hauling driver's
 *  lane) — that code implied a state the map can no longer produce. */
const trailerRecord = computed(() => {
  const id = trailerTarget.value?.trailerId
  return id ? (lb.trailers.find((t) => t.id === id) ?? null) : null
})
/** "Nearest city" isn't available for a trailer the way it is for a driver
 *  (LoadboardLane's server-computed `lastCity` — Task 6 never added an
 *  equivalent column for Trailer), so coordinates are the honest fallback
 *  the brief calls out by name. Fixed to 4 decimals (~11m) — enough to be
 *  useful, not false GPS-trace precision this data doesn't actually have. */
const trailerPositionLabel = computed(() => {
  const t = trailerRecord.value
  if (!t || t.lastLat == null || t.lastLng == null) return 'position unknown'
  return `${t.lastLat.toFixed(4)}, ${t.lastLng.toFixed(4)}`
})

/** T2 Task 8: the clicked shop's own record — resolved from the fleet
 *  store's shop registry, the same "thin pointer in, real record out"
 *  pattern every other kind here already uses. */
const shopRecord = computed(() => {
  const id = shopTarget.value?.shopId
  return id ? (fleet.shops.find((s) => s.id === id) ?? null) : null
})

/** T3 Break and Rest Planning, Task 8: the break point's own coordinates —
 *  same 4-decimal fallback `trailerPositionLabel` above already uses for
 *  "no honest city name available", prefixed with `≈` when
 *  `precision: 'estimated'` (Global Constraint 7 / Spec §7: "a break
 *  suggestion that is confidently wrong is worse than none" — an estimated
 *  point must never read exactly like a routed one). */
const breakLocationLabel = computed(() => {
  const bp = breakTarget.value?.marker
  if (!bp) return ''
  const coords = `${bp.at.lat.toFixed(4)}, ${bp.at.lng.toFixed(4)}`
  return bp.precision === 'estimated' ? `≈${coords}` : coords
})
/** T3 Break and Rest Planning, Task 8: the absent-vs-measured distinction
 *  this whole feature exists to get right, surfaced in the one place a
 *  dispatcher actually reads it. `hasCoverage: false` means the org has
 *  told us NOTHING about this corridor — "rest options unknown", never "no
 *  rest options" (that would claim a survey that never happened, Global
 *  Constraint 1). `hasCoverage: true` with an empty list is the other, real
 *  claim: the org DOES have coverage data reaching this corridor, and
 *  checked it — there just isn't a rest stop within reach. */
const breakCoverageLabel = computed(() => {
  const bp = breakTarget.value?.marker
  if (!bp) return ''
  if (!bp.hasCoverage) return 'rest options unknown'
  if (bp.options.length === 0) return 'no rest option within 35 mi'
  return `${bp.options.length} option${bp.options.length === 1 ? '' : 's'} nearby`
})

/** T2 "Map as Navigation", Task 8 (spec R4 — need-driven surfacing, never a
 *  "show all shops" toggle): does THIS popup's unit actually need a shop?
 *  A trailer popup's subject is the clicked trailer itself
 *  (`trailerRecord`); a truck/driver popup's subject is the driver's
 *  currently-paired tractor OR trailer (`tractor`/`trailer` above) — either
 *  one being due is enough. A stop pin isn't a unit at all and never
 *  surfaces this, even though `driver`/`tractor`/`trailer` above still
 *  resolve for a stop (they key off the load's assignment, same as a truck
 *  popup) — showing a compliance clock on a pickup/delivery location would
 *  attribute it to the wrong thing on the map.
 *  Reuses serviceNeed.ts's `needsService` — see that module's own doc for
 *  why an untracked (never-set) clock never counts as due here. Nor is a
 *  break point a unit — same exclusion as a stop pin, stated explicitly
 *  rather than left to fall out incidentally of `driver`/`tractor`/`trailer`
 *  all resolving to null for a break target (they key off `load`, which
 *  never resolves a break's loadId — see `load`'s own doc above). */
const unitNeedsService = computed(() => {
  if (stopTarget.value || breakTarget.value) return false
  if (trailerTarget.value) return !!trailerRecord.value && needsService(trailerRecord.value, props.nowMs)
  return (!!tractor.value && needsService(tractor.value, props.nowMs)) || (!!trailer.value && needsService(trailer.value, props.nowMs))
})

/** The position to search FROM for the nearest shop: the clicked trailer's
 *  own last-known fix for a trailer popup, or the driver's last-known fix
 *  for a truck/driver popup (LoadboardLane's lastLat/lastLng — the same
 *  snapshot `trailerPositionLabel` above already treats as the honest
 *  answer for "where is this", not a live-ping re-derivation FleetMap's own
 *  marker placement does; MapPopup resolves everything from the stores
 *  alone, same as every other field here). */
const serviceSearchPosition = computed(() => {
  if (trailerTarget.value) {
    const t = trailerRecord.value
    return t?.lastLat != null && t.lastLng != null ? { lat: t.lastLat, lng: t.lastLng } : null
  }
  const d = driver.value
  return d?.lastLat != null && d.lastLng != null ? { lat: d.lastLat, lng: d.lastLng } : null
})

/** null whenever the unit doesn't need service OR its position is unknown —
 *  never a nearest shop offered with nothing honest to base it on. */
const nearestShopResult = computed(() => {
  if (!unitNeedsService.value || !serviceSearchPosition.value) return null
  return nearestShop(serviceSearchPosition.value, fleet.shops)
})
/** A trailer has no lane and no load of its own — there is nothing honest
 *  for "Show on board" to jump to (the same reasoning the doc on
 *  `showOnBoard` below gives for a parked driver, applied here with no
 *  exception: unlike a parked DRIVER, a trailer never has its own lane
 *  row). The button is omitted for every trailer target, unconditionally.
 *  A break point DOES belong to a load (`breakTarget.marker.loadId`), so it
 *  gets the button too — same jump a stop pin's own load gets. */
const poiTarget = computed(() => (props.target?.kind === 'poi' ? props.target : null))
const poi = computed(() => {
  const t = poiTarget.value
  if (!t) return null
  return ck.routePois.items.find((p) => p.id === t.poiId) ?? null
})

const showOnBoardVisible = computed(() => !!(truckTarget.value || driverTarget.value || stopTarget.value || breakTarget.value))

const title = computed(() => {
  if (truckTarget.value) return load.value?.reference ?? truckTarget.value.loadId
  if (driverTarget.value) return driver.value?.name ?? 'Driver'
  if (stopTarget.value) return stopTarget.value.stopKind === 'pickup' ? 'Pickup' : 'Delivery'
  if (trailerTarget.value) {
    const t = trailerRecord.value
    if (!t) return trailerTarget.value.trailerId
    const typeAndLength = t.length ? `${t.type} ${t.length}` : t.type
    return `${t.unit} · ${typeAndLength}`
  }
  if (shopTarget.value) return shopRecord.value?.name ?? shopTarget.value.shopId
  if (breakTarget.value) return 'Mandatory break'
  return ''
})

// Next stop + ETA — computed with the SAME shared stopEtas() the board's own
// MasterDrawer milestones use (lib/cockpit/stopEtas.ts), never a second copy
// of the distance/dwell math. Null when the load's full stop detail isn't
// loaded (BoardLoad.stops is optional — a load can appear on the map from a
// lighter payload than the drawer's) or the assignment window is missing;
// the template renders that as "—", never a guessed time.
const nextStop = computed(() => {
  if (!truckTarget.value || !assignment.value || !load.value?.stops?.length) return null
  const stops = load.value.stops
  const startMs = Date.parse(assignment.value.plannedStart)
  const endMs = Date.parse(assignment.value.plannedEnd)
  const etas = stopEtas(stops, startMs, endMs)
  let idx = etas.findIndex((eta) => eta > props.nowMs)
  if (idx === -1) idx = stops.length - 1
  const etaMs = etas[idx]
  return etaMs != null ? { stop: stops[idx], etaMs } : null
})

// The live risk feed's own words for this load (lb.risks, already computed
// server-side) — reused verbatim rather than re-deriving a "late by Xm"
// string from slackMin ourselves. Absence here means "not currently flagged
// at risk", a real state, not an unknown one.
const riskDetail = computed(() => (load.value ? (lb.risks.find((r) => r.loadId === load.value!.id)?.detail ?? null) : null))
const atRiskSeverity = computed(() => (load.value ? (lb.riskByLoadId[load.value.id] ?? null) : null))

// The committed rate snapshot, verbatim — null means never priced, and must
// render as "—", never $0.00. See stores/loadboard.ts's LoadAssignment.economics
// doc and MasterDrawer's identical handling.
const economics = computed(() => assignment.value?.economics ?? null)
const carrierName = computed(() => driver.value?.carrierName ?? null)

/** The most honest signal this data model has for "when did this driver go
 *  idle": the latest completedAt among their legs currently loaded into the
 *  board's window. A real timestamp, never a guess — but window-scoped, same
 *  caveat as lanes.ts's laneMoneyInView/committedGrossCents: a driver whose
 *  last delivery fell outside the loaded window, or who has never completed
 *  a tracked leg here, has no honest answer and reads as unknown. */
const idleSinceMs = computed(() => {
  if (!driver.value) return null
  const stamps = lb.loads
    .filter((l) => l.assignment?.driverId === driver.value!.id && l.assignment.status === 'completed' && l.assignment.completedAt)
    .map((l) => Date.parse(l.assignment!.completedAt!))
  return stamps.length ? Math.max(...stamps) : null
})

/** "Show on board" for a truck/stop popup jumps straight to that load — it
 *  already has one. A parked driver has NO active load, by definition
 *  (that's what "parked" means — see mapData.ts's driverActivity): an
 *  earlier version of this picked "the nearest load in time" for a parked
 *  driver, which is exactly the wrong thing — it sends a dispatcher to a
 *  brick that has nothing to do with the driver they clicked. There is
 *  nothing honest to select for a driver with no load, so a parked driver's
 *  button instead scrolls to that driver's OWN lane row on the board
 *  (`ck.focusLaneOnBoard`, keyed off GanttBoard.vue's `data-lane` — the same
 *  DOM hook `focusOnBoard` uses for `data-load`) and leaves selection alone
 *  rather than selecting a load that isn't theirs. */
// No trailer branch: `showOnBoardVisible` above keeps this button off the
// page entirely for a trailer target, so this function is never called for
// one — see `trailerRecord`'s doc for why there is no honest jump to offer.
function showOnBoard(): void {
  if (truckTarget.value) ck.focusOnBoard(truckTarget.value.loadId)
  else if (stopTarget.value) ck.focusOnBoard(stopTarget.value.loadId)
  else if (breakTarget.value) ck.focusOnBoard(breakTarget.value.marker.loadId)
  else if (driverTarget.value) ck.focusLaneOnBoard(driverTarget.value.driverId)
  emit('close')
}
</script>

<template>
  <div v-if="visible && target" class="fixed z-[60] w-[300px] rounded-lg border border-line-strong bg-surface font-mono text-xs shadow-2xl" :style="pos" data-testid="map-popup" :data-kind="target.kind">
    <div class="flex items-center justify-between border-b border-line px-3 py-2">
      <span class="truncate font-bold text-ink" data-testid="popup-title">{{ title }}</span>
      <button type="button" class="shrink-0 text-ink-3 hover:text-ink" data-testid="popup-close" @click="emit('close')">✕</button>
    </div>

    <div class="grid grid-cols-[84px_1fr] gap-x-2 gap-y-1 px-3 py-2 text-[11px]">
      <template v-if="truckTarget">
        <span class="text-ink-3">Route</span>
        <span class="text-ink" data-testid="popup-route">{{ load?.origin ?? '—' }} ➔ {{ load?.destination ?? '—' }}</span>

        <span class="text-ink-3">Next stop</span>
        <span class="text-ink" data-testid="popup-next-stop">
          <template v-if="nextStop">{{ nextStop.stop.address }} · ETA ~{{ fmtDT(nextStop.etaMs, ck.tz) }}</template>
          <template v-else>—</template>
        </span>

        <template v-if="riskDetail">
          <span class="text-ink-3">Status</span>
          <span class="font-bold text-red-500" data-testid="popup-late">⏰ {{ riskDetail }}</span>
        </template>

        <span class="text-ink-3">Driver</span>
        <span class="text-ink" data-testid="popup-driver">{{ driver?.name ?? '—' }}</span>

        <span class="text-ink-3">Carrier</span>
        <span class="text-ink" data-testid="popup-carrier">{{ carrierName ?? 'No carrier' }}</span>

        <span class="text-ink-3">Margin</span>
        <span :class="economics ? (economics.marginCents >= 0 ? 'text-emerald-500' : 'text-red-500') : 'text-ink-3'" data-testid="popup-margin">
          <template v-if="economics">{{ formatUsd(economics.marginCents) }}</template>
          <template v-else>— not priced</template>
        </span>
      </template>

      <template v-else-if="driverTarget">
        <span class="text-ink-3">Idle since</span>
        <span class="text-ink" data-testid="popup-idle-since">
          <template v-if="idleSinceMs != null">{{ ageLabel(new Date(idleSinceMs).toISOString(), nowMs) }} ago</template>
          <template v-else>—</template>
        </span>

        <span class="text-ink-3">Drive left</span>
        <span class="text-ink" data-testid="popup-hos-drive">{{ driver?.hosKnown ? hrsLabel(driver.driveRemainingMin) : 'not imported' }}</span>

        <span class="text-ink-3">Cycle left</span>
        <span class="text-ink" data-testid="popup-hos-cycle">{{ driver?.hosKnown ? hrsLabel(driver.cycleRemainingMin) : 'not imported' }}</span>

        <span class="text-ink-3">Position</span>
        <span class="text-ink" data-testid="popup-city">{{ driver?.lastCity ?? 'position unknown' }}</span>

        <span class="text-ink-3">Equipment</span>
        <span class="text-ink" data-testid="popup-equipment">{{ tractor ? `#${tractor.unit}` : '— bobtail —' }} / {{ trailer ? trailer.unit : '— none —' }}</span>
      </template>

      <template v-else-if="stopTarget">
        <span class="text-ink-3">Type</span>
        <span class="text-ink" data-testid="popup-stop-type">{{ stopTarget.stopKind === 'pickup' ? 'Pickup' : 'Delivery' }}</span>

        <span class="text-ink-3">Address</span>
        <span class="text-ink" data-testid="popup-address">{{ stopTarget.stop.address }}</span>

        <span class="text-ink-3">Window</span>
        <span class="text-ink" data-testid="popup-window">
          <template v-if="stopTarget.stop.windowStart && stopTarget.stop.windowEnd">{{ fmtDT(Date.parse(stopTarget.stop.windowStart), ck.tz) }} – {{ fmtDT(Date.parse(stopTarget.stop.windowEnd), ck.tz) }}</template>
          <template v-else>— no appointment window</template>
        </span>

        <span class="text-ink-3">At risk</span>
        <span :class="atRiskSeverity ? (atRiskSeverity === 'block' ? 'text-red-500' : 'text-amber-500') : 'text-ink-3'" data-testid="popup-risk">
          <template v-if="riskDetail">⚠ {{ riskDetail }}</template>
          <template v-else>No risk flagged</template>
        </span>
      </template>

      <!-- T2 Task 8: the headline fact for a trailer is how long it's been
           sitting — a dropped trailer with a stale position is either
           billable detention or a lost asset, not a footnote next to its
           unit number. Rendered first and visually heavier (text-sm/bold)
           than the other rows for exactly that reason.
           No "hooked/dropped" status row: a trailer pin can now only ever
           mean "dropped" — see `trailerRecord`'s doc — so a status line
           that could only ever say one fixed thing would tell a dispatcher
           nothing they didn't already know from the pin's mere existence. -->
      <template v-else-if="trailerTarget">
        <span class="text-ink-3">Sitting</span>
        <span class="text-sm font-bold text-ink" data-testid="popup-trailer-age">
          <template v-if="trailerRecord?.lastSeenAt">{{ ageLabel(trailerRecord.lastSeenAt, nowMs) }}</template>
          <template v-else>—</template>
        </span>

        <span class="text-ink-3">Position</span>
        <span class="text-ink" data-testid="popup-trailer-position">{{ trailerPositionLabel }}</span>
      </template>

      <!-- T2 Task 8: the org's OWN service shop (stores/fleet.ts's
           ServiceShop) — free to show because it's the customer's own small,
           curated registry, not third-party POI. Name and phone are the two
           facts a dispatcher actually needs to route a driver there. -->
      <template v-else-if="shopTarget">
        <span class="text-ink-3">Name</span>
        <span class="text-ink" data-testid="popup-shop-name">{{ shopRecord?.name ?? shopTarget.shopId }}</span>

        <span class="text-ink-3">Phone</span>
        <span class="text-ink" data-testid="popup-shop-phone">{{ shopRecord?.phone ?? '—' }}</span>
      </template>

      <!-- A fuel stop or rest area along the selected trip's route. The
           category shown is the PROVIDER's, and the wording stays literal:
           "Rest area" / "Fuel", never "truck stop". This provider makes no
           promise of truck access, diesel lanes or overnight parking, and
           returns nothing at all for weigh stations or truck repair — so the
           popup states what was actually returned and no more. -->
      <template v-else-if="poiTarget">
        <span class="text-ink-3">Name</span>
        <span class="text-ink" data-testid="popup-poi-name">{{ poi?.name ?? poiTarget.poiId }}</span>

        <span class="text-ink-3">Kind</span>
        <span class="text-ink" data-testid="popup-poi-kind">{{ poi?.category === 'rest_area' ? 'Rest area' : 'Fuel' }}</span>

        <span class="text-ink-3">Along route</span>
        <span class="text-ink" data-testid="popup-poi-along">
          <template v-if="poi">{{ Math.round(poi.distanceAlongMi) }} mi in · {{ poi.offRouteMi < 0.1 ? 'on route' : poi.offRouteMi.toFixed(1) + ' mi off' }}</template>
          <template v-else>—</template>
        </span>

        <span class="text-ink-3">Address</span>
        <span class="text-ink" data-testid="popup-poi-address">{{ poi?.address ?? '—' }}</span>
      </template>

      <!-- T3 Break and Rest Planning, Task 8: the mandatory-break pin's own
           popup content. `breakLocationLabel`/`breakCoverageLabel` (script
           above) carry the absent-vs-measured distinction this whole
           feature exists to get right: "rest options unknown" (no coverage
           data for this corridor at all) is never conflated with "no rest
           option within 35 mi" (coverage checked, genuinely nothing in
           range) — collapsing those two into one string is the exact
           mistake this codebase has already made five times. -->
      <template v-else-if="breakTarget">
        <span class="text-ink-3">At</span>
        <span class="text-ink" data-testid="popup-break-location">{{ breakLocationLabel }}</span>

        <span class="text-ink-3">Rest options</span>
        <span class="text-ink" data-testid="popup-break-coverage">{{ breakCoverageLabel }}</span>

        <template v-if="breakTarget.marker.options.length">
          <span class="text-ink-3">Nearby</span>
          <span class="text-ink">
            <div v-for="opt in breakTarget.marker.options" :key="opt.id" class="py-0.5" data-testid="popup-break-option" :data-option-id="opt.id">
              {{ opt.name }} · {{ Math.round(opt.detourMi) }} mi detour · spaces {{ opt.spaces == null ? '—' : opt.spaces }}
            </div>
          </span>
        </template>
      </template>

      <!-- T2 Task 8 (spec R4 — need-driven, not a "show all shops" toggle):
           shown ONLY when this popup's own unit (the paired tractor/trailer
           for a truck/driver popup, or the clicked trailer itself for a
           trailer popup) has an overdue or near-due clock AND a known
           position — see `unitNeedsService`/`nearestShopResult` above. Never
           shown for a stop pin (not a unit) or a shop pin (already IS the
           shop). This is the differentiated half of the task: knowing WHICH
           unit needs service and WHERE it is, something no third-party POI
           layer could ever know. -->
      <template v-if="nearestShopResult">
        <span class="text-ink-3">Service due</span>
        <span class="font-bold text-amber-500" data-testid="popup-nearest-shop">{{ nearestShopResult.shop.name }} · {{ Math.round(nearestShopResult.miles) }} mi</span>
      </template>
    </div>

    <!-- The drawn line is a bezier arc through the stops (mapGeometry.ts's
         routePath/arcBetween), not a routed road path — ROUTER_URL is unset
         and the distance cache stores no polyline. Said plainly here so a
         dispatcher never infers a driven route from what's really an
         estimate — the standing ruling this task exists to finally surface. -->
    <div v-if="truckTarget || stopTarget" class="border-t border-line px-3 py-1.5 text-[9px] leading-relaxed text-ink-3" data-testid="popup-route-note">
      Route shown is an estimated curve through the stops, not a driven road route.
    </div>

    <!-- T2 Task 8: a trailer has no lane and no load of its own — nothing
         honest to jump to, so the button is omitted entirely for every
         trailer target rather than landing somewhere arbitrary (see
         `showOnBoardVisible`'s doc). -->
    <div v-if="showOnBoardVisible" class="border-t border-line px-3 py-2">
      <button type="button" class="w-full rounded border border-brand bg-brand/20 px-2 py-1.5 text-[10px] font-bold text-brand-ink hover:bg-brand/30" data-testid="popup-show-on-board" @click="showOnBoard">Show on board →</button>
    </div>
  </div>
</template>
