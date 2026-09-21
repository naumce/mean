// The trip card's data — the "what is this truck doing right now" summary a
// dispatcher reads off the map, modelled on what a rider-hailing app shows for
// a trip in progress: one hero ETA, who is driving, where they are going, and
// the single constraint that could change the plan.
//
// Pure: no DOM, no store, no clock of its own (`nowMs` is passed in) so the
// whole thing is unit-testable and renders identically in a test and on screen.
//
// Every field is nullable and every null has a MEANING that the card must
// render as unknown rather than as a number. A dispatcher who is told "0h to
// break" for a driver whose hours were never imported will send that driver
// into a violation. Absent is not zero.

import type { BoardLoad, LoadboardLane } from '../../stores/loadboard'
import { stopEtas } from './stopEtas'

/** A ping older than this is not where the truck is now. Mirrors mapData's
 *  FRESH_MS so the card and the marker agree about staleness. */
export const PING_FRESH_MS = 15 * 60_000

export interface TripStopSummary {
  label: string
  /** epoch ms; null when the leg has no computable arrival */
  etaMs: number | null
  /** appointment close, when the stop has one */
  windowEndMs: number | null
  /** true when the projected arrival is past the appointment */
  late: boolean
  /** always true today: the ETA is an interpolation of the committed window,
   *  not a routed arrival. The card renders "~" while this holds. */
  etaApprox: boolean
}

export interface TripSummary {
  loadId: string
  loadRef: string
  driverId: string
  driverName: string
  /** assignment status: assigned | tendered | in_progress | ... */
  status: string
  origin: string
  destination: string
  /** the next stop the truck has not reached, or null when all are done */
  nextStop: TripStopSummary | null
  /** minutes of driving left before this driver owes a 30-min break, or null
   *  when their HOS was never imported. NULL IS NOT ZERO — see module note. */
  minutesToBreak: number | null
  /** remaining drive-hours clock, or null when HOS is unknown */
  driveRemainingMin: number | null
  /** age of the last GPS ping in ms, or null when the driver has never pinged */
  pingAgeMs: number | null
  /** true when the last ping is too old to be treated as a live position */
  positionStale: boolean
}

/** FMCSA: a break is owed after 8 cumulative hours of driving. */
const BREAK_THRESHOLD_MIN = 480

function stopLabel(address: string | null | undefined, fallback: string): string {
  if (!address) return fallback
  // "Kansas City, MO 64106" -> "Kansas City, MO". The card is narrow and the
  // ZIP is never the thing a dispatcher is looking for.
  const m = /^(.*?,\s*[A-Za-z]{2})\b/.exec(address.trim())
  return m ? m[1] : address.trim()
}

/**
 * Build the card for one load. Returns null when the load is not something a
 * trip card can describe — no assignment, or fewer than two stops.
 */
export function buildTripSummary(
  load: BoardLoad,
  lane: LoadboardLane | undefined,
  lastPingMs: number | null,
  nowMs: number,
): TripSummary | null {
  const a = load.assignment
  if (!a) return null
  const stops = (load.stops ?? []).filter((s) => s.lat != null && s.lng != null)
  if (stops.length < 2) return null

  const startMs = a.plannedStart ? new Date(a.plannedStart).getTime() : nowMs
  const endMs = a.plannedEnd ? new Date(a.plannedEnd).getTime() : nowMs
  // stopEtas interpolates the COMMITTED window across the stops by distance
  // and dwell. Its own doc is explicit that these are not routed ETAs — no
  // road network, no traffic, no HOS break inserted — and that callers must
  // hedge them. `etaApprox` below carries that obligation to the card, which
  // prefixes "~". Do not drop it just because the map now draws real roads:
  // the geometry is routed, this arrival time still is not.
  const etas = stopEtas(
    stops.map((s) => ({ lat: s.lat, lng: s.lng, dwellMin: s.dwellMin })),
    startMs,
    endMs,
  )

  // The next stop is the first whose projected arrival is still ahead of now.
  // All arrivals in the past means the trip is effectively complete and there
  // is nothing to count down to — the card says so rather than showing a
  // negative ETA.
  let nextStop: TripStopSummary | null = null
  for (let i = 0; i < stops.length; i++) {
    const eta = etas[i] ?? null
    if (eta == null || eta <= nowMs) continue
    const windowEndMs = stops[i].windowEnd ? new Date(stops[i].windowEnd as string).getTime() : null
    nextStop = {
      label: stopLabel(stops[i].address, `Stop ${i + 1}`),
      etaMs: eta,
      windowEndMs,
      late: windowEndMs != null && eta > windowEndMs,
      etaApprox: true,
    }
    break
  }

  // HOS: only from an imported clock. `hosKnown === false` means nobody told
  // us, and the card must not fill that in with a comfortable number.
  const hosKnown = lane?.hosKnown === true
  const minutesToBreak =
    hosKnown && typeof lane?.minutesSinceBreak === 'number'
      ? Math.max(0, BREAK_THRESHOLD_MIN - lane.minutesSinceBreak)
      : null
  const driveRemainingMin =
    hosKnown && typeof lane?.driveRemainingMin === 'number' ? lane.driveRemainingMin : null

  const pingAgeMs = lastPingMs == null ? null : Math.max(0, nowMs - lastPingMs)

  return {
    loadId: load.id,
    loadRef: load.reference ?? load.id.slice(0, 8),
    driverId: a.driverId,
    driverName: lane?.name ?? 'Unknown driver',
    status: a.status ?? load.status,
    origin: load.origin ?? stopLabel(stops[0].address, 'Origin'),
    destination: load.destination ?? stopLabel(stops[stops.length - 1].address, 'Destination'),
    nextStop,
    minutesToBreak,
    driveRemainingMin,
    pingAgeMs,
    // No ping at all is stale in the sense the card cares about: we cannot
    // claim to know where this truck is.
    positionStale: pingAgeMs == null || pingAgeMs > PING_FRESH_MS,
  }
}

/** "3h 12m" / "48m". Null renders as an em dash at the call site, never "0m". */
export function durationLabel(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
