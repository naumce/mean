// Cover-by urgency for uncovered backlog loads, derived from the first
// pickup's real appointment window. No appointment -> no chip: silence is
// honest when there is no clock to race.

export interface BacklogUrgency {
  level: 'missed' | 'now' | 'soon'
  label: string
}

const HOUR_MS = 3_600_000
const NOW_THRESHOLD_MS = 4 * HOUR_MS
const SOON_THRESHOLD_MS = 12 * HOUR_MS

function remaining(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export function backlogUrgency(pickupWindowEnd: string | null | undefined, nowMs: number): BacklogUrgency | null {
  if (!pickupWindowEnd) return null
  const end = Date.parse(pickupWindowEnd)
  if (Number.isNaN(end)) return null
  const left = end - nowMs
  if (left < 0) return { level: 'missed', label: 'pickup window missed' }
  if (left < NOW_THRESHOLD_MS) return { level: 'now', label: `cover now · ${remaining(left)}` }
  if (left < SOON_THRESHOLD_MS) return { level: 'soon', label: `cover soon · ${remaining(left)}` }
  return null
}

/** Sort key for the backlog: tightest pickup window first, no-appointment last. */
export function pickupDeadlineMs(pickupWindowEnd: string | null | undefined): number {
  if (!pickupWindowEnd) return Number.MAX_SAFE_INTEGER
  const end = Date.parse(pickupWindowEnd)
  return Number.isNaN(end) ? Number.MAX_SAFE_INTEGER : end
}
