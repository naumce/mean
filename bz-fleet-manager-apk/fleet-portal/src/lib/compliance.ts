// Compliance chip states for fleet clocks (inspection / registration /
// service / medical). Mirrors the engine's stance: expired is a hard problem,
// approaching (30 days) deserves eyes, untracked is honestly labeled — never
// painted green.

export interface ComplianceStatus {
  level: 'expired' | 'soon' | 'ok' | 'untracked'
  label: string
}

const DAY_MS = 24 * 3_600_000
export const SOON_WINDOW_MS = 30 * DAY_MS

export function complianceStatus(expiresAt: string | null | undefined, nowMs: number): ComplianceStatus {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (Number.isNaN(at)) return { level: 'untracked', label: 'not tracked' }
  const left = at - nowMs
  const date = new Date(at).toISOString().slice(0, 10)
  if (left < 0) return { level: 'expired', label: `expired ${date}` }
  if (left < SOON_WINDOW_MS) {
    const days = Math.ceil(left / DAY_MS)
    return { level: 'soon', label: `${days}d left (${date})` }
  }
  return { level: 'ok', label: date }
}

/** The single expiry predicate for the whole app. Defined *through*
 *  `complianceStatus` rather than beside it, so the pill/brick/lane checks and
 *  the compliance chip can never disagree at the boundary: at exactly
 *  `nowMs === expiry` nothing has expired yet (0 ms left is "soon", not
 *  "expired"). An unset or unparseable clock is untracked, never expired. */
export function isExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  return complianceStatus(expiresAt, nowMs).level === 'expired'
}
