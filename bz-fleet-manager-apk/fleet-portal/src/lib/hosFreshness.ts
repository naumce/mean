// How old is the driver's HOS data? The stamp comes from importedAt — set
// only when real clock data arrives (import/ELD), never by our own planning
// decrements. Week-old clocks read as fresh are how fleets plan on fiction.

export interface HosFreshness {
  label: string
  stale: boolean
}

const HOUR_MS = 3_600_000
export const STALE_AFTER_MS = 24 * HOUR_MS

export function hosFreshness(importedAt: string | null | undefined, nowMs: number): HosFreshness {
  const at = importedAt ? Date.parse(importedAt) : Number.NaN
  if (Number.isNaN(at)) return { label: 'HOS age unknown', stale: true }
  const age = Math.max(0, nowMs - at)
  if (age >= STALE_AFTER_MS) {
    const days = Math.floor(age / (24 * HOUR_MS))
    return { label: days >= 1 ? `HOS as of ${days}d ago` : 'HOS as of 1d ago', stale: true }
  }
  if (age >= HOUR_MS) return { label: `HOS as of ${Math.floor(age / HOUR_MS)}h ago`, stale: false }
  return { label: `HOS as of ${Math.max(1, Math.round(age / 60_000))}m ago`, stale: false }
}
