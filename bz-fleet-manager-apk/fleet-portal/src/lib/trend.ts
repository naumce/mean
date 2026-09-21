// Week-over-week direction for the KPI strip. Pure arithmetic; the caller
// decides which direction is good (revenue up = good, deadhead up = bad).

export interface TrendDelta {
  dir: 'up' | 'down' | 'flat'
  /** fractional change vs the previous value; null when there is no baseline */
  pct: number | null
}

export function trendDelta(current: number, previous: number): TrendDelta {
  if (current === previous) return { dir: 'flat', pct: previous === 0 ? null : 0 }
  const dir = current > previous ? 'up' : 'down'
  return { dir, pct: previous !== 0 ? (current - previous) / previous : null }
}

export function trendArrow(delta: TrendDelta): string {
  return delta.dir === 'up' ? '↑' : delta.dir === 'down' ? '↓' : '→'
}

export function trendPctLabel(delta: TrendDelta): string {
  if (delta.pct == null) return 'new'
  return `${Math.abs(Math.round(delta.pct * 100))}%`
}
