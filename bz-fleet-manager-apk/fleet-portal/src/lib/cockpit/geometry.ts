// Org-timezone time↔pixel core for the cockpit. Pure: no Date.now(), no DOM.
// Instants are epoch-ms; wall-clock values come from Intl for the org tz, so
// the board reads "06:00 Chicago" even though the API speaks UTC.
export interface CockpitConfig {
  tz: string
  /** Wall date (YYYY-MM-DD, org tz) of the first visible day. */
  day0: string
  days: number
  dayStartHour: number
  dayEndHour: number
  pxPerHour: number
}

export interface WallParts {
  y: number
  m: number
  d: number
  h: number
  min: number
  wd: string
}

export interface DayColumn {
  index: number
  ymd: string
  label: string
  isToday: boolean
  isWeekend: boolean
  x: number
  width: number
}

const MIN_MS = 60_000
const DAY_MS = 86_400_000
const pad = (n: number): string => String(n).padStart(2, '0')
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  return f
}

export function wallParts(ms: number, tz: string): WallParts {
  const out: Record<string, string> = {}
  for (const p of formatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value
  return { y: +out.year, m: +out.month, d: +out.day, h: +out.hour % 24, min: +out.minute, wd: out.weekday }
}

export function wallYmd(ms: number, tz: string): string {
  const p = wallParts(ms, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

/** Minutes since local midnight. */
export function wallMinutes(ms: number, tz: string): number {
  const p = wallParts(ms, tz)
  return p.h * 60 + p.min
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (Chicago in August = -300). */
export function tzOffsetMin(ms: number, tz: string): number {
  const p = wallParts(ms, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
  return Math.round((asUtc - Math.floor(ms / MIN_MS) * MIN_MS) / MIN_MS)
}

/**
 * The instant at which `minutesFromMidnight` past `ymd`'s local midnight reads on
 * the wall clock in `tz`. Two-pass offset resolution: the first guess reads the
 * offset at the naive (wall-clock-as-UTC) instant, the second re-reads it at that
 * corrected instant — which is what makes this exact across a DST-transition day,
 * unlike adding real milliseconds to a fixed midnight anchor (correct only when no
 * transition falls between midnight and the target time). `zonedMidnightMs` and
 * `xToTime` both route through this rather than doing their own ms arithmetic.
 *
 * Boundary case — nonexistent wall-clock times: if `minutesFromMidnight` names a
 * moment that a spring-forward transition skips entirely (e.g. 2026-03-08 02:30
 * America/Chicago, or all of 00:00–00:59 on 2026-09-06 America/Santiago when the
 * gap coincides with midnight), the two passes settle on the offset from just
 * *before* the transition, so the returned instant reads back one DST delta
 * *earlier* than requested (`zonedMidnightMs('2026-09-06', 'America/Santiago')`
 * reads back as 2026-09-05 23:00). That's a deterministic fallback of the
 * arithmetic, not a validated policy for arbitrary time zones — this module
 * doesn't detect or special-case the gap. Fine for the US-only zones this product
 * targets today.
 */
function zonedWallMs(ymd: string, minutesFromMidnight: number, tz: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  const naive = Date.UTC(y, m - 1, d) + minutesFromMidnight * MIN_MS
  const first = naive - tzOffsetMin(naive, tz) * MIN_MS
  return naive - tzOffsetMin(first, tz) * MIN_MS
}

/** The instant of local midnight for a wall date; re-checked once for DST edges. */
export function zonedMidnightMs(ymd: string, tz: string): number {
  return zonedWallMs(ymd, 0, tz)
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Calendar days from `a` to `b` (b − a). */
export function diffDaysYmd(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS)
}

export const hoursPerDay = (cfg: CockpitConfig): number => cfg.dayEndHour - cfg.dayStartHour
export const dayWidth = (cfg: CockpitConfig): number => hoursPerDay(cfg) * cfg.pxPerHour
export const totalWidth = (cfg: CockpitConfig): number => dayWidth(cfg) * cfg.days

/** Pixel x of an instant, or null when its wall date is outside the window.
 *  Hours before dayStart / after dayEnd clamp to the day's edges. */
export function timeToX(ms: number, cfg: CockpitConfig): number | null {
  const dayIdx = diffDaysYmd(cfg.day0, wallYmd(ms, cfg.tz))
  if (dayIdx < 0 || dayIdx >= cfg.days) return null
  const hod = wallMinutes(ms, cfg.tz) / 60
  const into = clamp(hod - cfg.dayStartHour, 0, hoursPerDay(cfg))
  return dayIdx * dayWidth(cfg) + into * cfg.pxPerHour
}

/** Instant for a pixel x, snapped to 15 minutes, clamped to the window. */
export function xToTime(x: number, cfg: CockpitConfig): number {
  const dayIdx = clamp(Math.floor(x / dayWidth(cfg)), 0, cfg.days - 1)
  const within = clamp(x - dayIdx * dayWidth(cfg), 0, dayWidth(cfg))
  const mins = Math.round((cfg.dayStartHour * 60 + (within / cfg.pxPerHour) * 60) / 15) * 15
  return zonedWallMs(addDaysYmd(cfg.day0, dayIdx), mins, cfg.tz)
}

/** Whole org-days covering the window — what the API is asked for. */
export function windowRange(cfg: CockpitConfig): { fromMs: number; toMs: number } {
  return {
    fromMs: zonedMidnightMs(cfg.day0, cfg.tz),
    toMs: zonedMidnightMs(addDaysYmd(cfg.day0, cfg.days), cfg.tz),
  }
}

/** Horizontal extent of a leg, clipped to the window; null if fully outside. */
export function brickSpan(startMs: number, endMs: number, cfg: CockpitConfig): { x: number; w: number } | null {
  const a = timeToX(startMs, cfg)
  const b = timeToX(endMs, cfg)
  if (a === null && b === null) {
    const sd = diffDaysYmd(cfg.day0, wallYmd(startMs, cfg.tz))
    const ed = diffDaysYmd(cfg.day0, wallYmd(endMs, cfg.tz))
    if (sd < 0 && ed >= cfg.days) return { x: 0, w: totalWidth(cfg) }
    return null
  }
  const x = a ?? 0
  const right = b ?? totalWidth(cfg)
  return { x, w: Math.max(cfg.pxPerHour / 2, right - x) }
}

export function dayColumns(cfg: CockpitConfig, nowMs: number): DayColumn[] {
  const today = wallYmd(nowMs, cfg.tz)
  const cols: DayColumn[] = []
  for (let i = 0; i < cfg.days; i++) {
    const ymd = addDaysYmd(cfg.day0, i)
    const noon = zonedMidnightMs(ymd, cfg.tz) + 12 * 3_600_000
    const p = wallParts(noon, cfg.tz)
    cols.push({
      index: i,
      ymd,
      label: `${p.wd.toUpperCase()} ${p.d}`,
      isToday: ymd === today,
      isWeekend: p.wd === 'Sat' || p.wd === 'Sun',
      x: i * dayWidth(cfg),
      width: dayWidth(cfg),
    })
  }
  return cols
}
