// Pure time<->pixel core for the dispatch board, ported in spirit from the
// mockup / Bertschi's useBrick. No DOM, no clock — every function takes an
// explicit BoardConfig, so it is deterministic and unit-testable. Days are
// counted in UTC to match the API's ISO timestamps; timezone-aware windows
// are a later concern.
export interface BoardConfig {
  fromDate: Date
  toDate: Date
  dayStartHour: number
  dayEndHour: number
  boardWidthPx: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function daysInWindow(cfg: BoardConfig): number {
  return Math.round((utcMidnight(cfg.toDate) - utcMidnight(cfg.fromDate)) / MS_PER_DAY) + 1
}

function hoursPerDay(cfg: BoardConfig): number {
  return cfg.dayEndHour - cfg.dayStartHour
}

export function hourWidth(cfg: BoardConfig): number {
  return cfg.boardWidthPx / (hoursPerDay(cfg) * daysInWindow(cfg))
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function timeToX(t: Date, cfg: BoardConfig): number {
  const dayIndex = Math.round((utcMidnight(t) - utcMidnight(cfg.fromDate)) / MS_PER_DAY)
  const hourOfDay = t.getUTCHours() + t.getUTCMinutes() / 60
  const hoursIntoDay = clamp(hourOfDay - cfg.dayStartHour, 0, hoursPerDay(cfg))
  const totalHours = dayIndex * hoursPerDay(cfg) + hoursIntoDay
  return clamp(totalHours * hourWidth(cfg), 0, cfg.boardWidthPx)
}

export function xToTime(x: number, cfg: BoardConfig): Date {
  const totalHours = clamp(x, 0, cfg.boardWidthPx) / hourWidth(cfg)
  // The exact right edge would otherwise compute dayIndex === daysInWindow —
  // a time on the day AFTER the visible window.
  const dayIndex = Math.min(Math.floor(totalHours / hoursPerDay(cfg)), daysInWindow(cfg) - 1)
  const hoursIntoDay = Math.min(totalHours - dayIndex * hoursPerDay(cfg), hoursPerDay(cfg))
  const rawMinutes = (cfg.dayStartHour + hoursIntoDay) * 60
  const snapped = Math.round(rawMinutes / 15) * 15
  const base = utcMidnight(cfg.fromDate) + dayIndex * MS_PER_DAY
  return new Date(base + snapped * 60 * 1000)
}

export function brickWidth(start: Date, end: Date, cfg: BoardConfig): number {
  const w = timeToX(end, cfg) - timeToX(start, cfg)
  const quarterHour = hourWidth(cfg) / 4
  return Math.max(quarterHour, w)
}
