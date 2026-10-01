// Driver Supply (Task 9) formatting helpers — small, pure, single-purpose
// functions in the style of lib/hosFreshness.ts / lib/money.ts, not folded
// into lib/cockpit/format.ts because these thresholds/shapes are specific to
// this view (e.g. the 8h HOS staleness window below is deliberately
// different from lib/hosFreshness.ts's 24h/importedAt convention — see
// isHosStale's own comment).
import { ageLabel } from './cockpit/format'
import type { AvailabilityStatus, CurrentPing, NearPlace } from '../types/supply'

// --- Status chip / marker colour --------------------------------------------

export const STATUS_ORDER: Record<AvailabilityStatus, number> = {
  AVAILABLE: 0,
  AVAILABLE_SOON: 1,
  ON_LOAD: 2,
  OFF_DUTY: 3,
  UNAVAILABLE: 4,
}

/** "AVAILABLE_SOON" -> "Available Soon" — same split-and-capitalize rule as
 *  components/StatusPill.vue's formatLabel, kept local because this
 *  vocabulary (AVAILABLE/ON_LOAD/...) is disjoint from StatusPill's own
 *  (pending/assigned/completed/...) and mixing them into one lookup would
 *  make either caller able to render the other's statuses. */
export function statusLabel(status: AvailabilityStatus): string {
  return status
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

export const STATUS_CHIP_CLASS: Record<AvailabilityStatus, string> = {
  AVAILABLE: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200',
  AVAILABLE_SOON: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
  ON_LOAD: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200',
  OFF_DUTY: 'bg-surface-3 text-ink-2',
  UNAVAILABLE: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-200',
}

const STATUS_MARKER_COLOR: Record<AvailabilityStatus, string> = {
  AVAILABLE: '#10b981',
  AVAILABLE_SOON: '#f59e0b',
  ON_LOAD: '#3b82f6',
  OFF_DUTY: '#9ca3af',
  UNAVAILABLE: '#ef4444',
}

/** FleetMap's markerColor prop: one hex colour per availability status,
 *  independent of the map's own ping-freshness colouring. */
export function statusMarkerColor(status: AvailabilityStatus): string {
  return STATUS_MARKER_COLOR[status]
}

// --- CURRENT column ----------------------------------------------------------

/** A driver's filterable/displayable language set: `languages` plus
 *  `preferredLanguage` (every driver has one, defaulted server-side to
 *  "en") — so a driver whose `languages[]` was never populated during
 *  import still shows up under their actual communication language instead
 *  of vanishing from both the LANGUAGES cell and the language filter. */
export function driverLanguages(d: { languages: string[]; preferredLanguage: string }): string[] {
  return Array.from(new Set([...d.languages, d.preferredLanguage]))
}

const AT_THRESHOLD_MI = 3

/** Four CURRENT-column states, in order of how much we actually know:
 *   1. "at {city}, {state}"                — a ping within AT_THRESHOLD_MI of a known place
 *   2. "near {city}, {state} · {N} mi"      — a ping farther than that but still within
 *                                              nearestKnownPlace's 150-mi gazetteer ceiling
 *   3. "ping received"                      — a real ping exists but it's >150mi from any
 *                                              gazetteer place (near is null) — honest about
 *                                              having a position without inventing a place name
 *   4. (no ping at all)                     — handled by currentLabel below, not this function
 */
function nearPlaceText(place: NearPlace | null): string {
  if (!place) return 'ping received'
  return place.distanceMi <= AT_THRESHOLD_MI
    ? `at ${place.city}, ${place.state}`
    : `near ${place.city}, ${place.state} · ${Math.round(place.distanceMi)} mi`
}

/** "near Toledo, OH · 12 mi · 4m" / "at Toledo, OH · now" / "ping received ·
 *  4m" (see nearPlaceText above for when the third shows up) / "no ping"
 *  (no current ping at all — the fourth state). The trailing age tells the
 *  dispatcher how fresh the fix behind the place name is. */
export function currentLabel(current: CurrentPing | null, nowMs: number): string {
  if (!current) return 'no ping'
  return `${nearPlaceText(current.near)} · ${ageLabel(new Date(current.at).toISOString(), nowMs)}`
}

// --- PROJECTED AVAILABILITY column -------------------------------------------

/** "Kansas City, MO · now" / "Kansas City, MO · Aug 28 @ 14:32". `whenLabel`
 *  is injected (rather than this file importing fmtDT directly) so the
 *  caller supplies the org's own timezone-aware formatter — Driver Supply
 *  has no cockpit store of its own to read `tz` off. */
export function projectedAvailabilityLabel(
  available: { city: string | null; state: string | null },
  availableAt: number,
  nowMs: number,
  whenLabel: (ms: number) => string,
): string {
  const place =
    available.city && available.state
      ? `${available.city}, ${available.state}`
      : (available.city ?? available.state ?? 'Unknown location')
  const when = availableAt <= nowMs ? 'now' : whenLabel(availableAt)
  return `${place} · ${when}`
}

// --- HOS column ---------------------------------------------------------------

/** Minutes -> "h:mm" (e.g. 495 -> "8:15"). */
export function driveRemainingLabel(driveRemainingMin: number): string {
  const total = Math.max(0, Math.round(driveRemainingMin))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

/** Driver Supply's own staleness rule for the HOS column: `hos.updatedAt`
 *  (the row's own last-touched stamp) older than 8h, NOT
 *  lib/hosFreshness.ts's 24h/`importedAt` convention used elsewhere — the
 *  brief calls for this specific field and window for this specific column,
 *  and the two must not be conflated (`updatedAt` moves on any write to the
 *  row, `importedAt` only on real ELD/import data — see the schema's own
 *  comment on HosState.importedAt). */
const HOS_STALE_AFTER_MS = 8 * 60 * 60 * 1000

export function isHosStale(updatedAt: string, nowMs: number): boolean {
  return nowMs - Date.parse(updatedAt) > HOS_STALE_AFTER_MS
}
