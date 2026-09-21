import { wallParts } from './geometry'

// Small, pure presentation helpers shared by the cockpit components.
export type ColorKey = 'emerald' | 'cyan' | 'amber' | 'violet' | 'blue' | 'slate' | 'purple' | 'red'

/** Tailwind accent classes per palette key — identical in light and dark. */
export const COLOR_CLASSES: Record<ColorKey, { av: string; dot: string; text: string }> = {
  emerald: { av: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30', dot: 'bg-emerald-400', text: 'text-emerald-500' },
  cyan: { av: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/30', dot: 'bg-cyan-400', text: 'text-cyan-500' },
  amber: { av: 'bg-amber-500/10 text-amber-500 border-amber-500/30', dot: 'bg-amber-400', text: 'text-amber-500' },
  violet: { av: 'bg-violet-500/10 text-violet-500 border-violet-500/30', dot: 'bg-violet-400', text: 'text-violet-500' },
  blue: { av: 'bg-blue-500/10 text-blue-500 border-blue-500/30', dot: 'bg-blue-400', text: 'text-blue-500' },
  slate: { av: 'bg-slate-500/10 text-slate-400 border-slate-500/30', dot: 'bg-slate-400', text: 'text-slate-400' },
  purple: { av: 'bg-purple-500/10 text-purple-500 border-purple-500/30', dot: 'bg-purple-400', text: 'text-purple-500' },
  red: { av: 'bg-red-500/10 text-red-500 border-red-500/30', dot: 'bg-red-500', text: 'text-red-500' },
}
const AVATAR_KEYS: ColorKey[] = ['emerald', 'cyan', 'amber', 'violet', 'blue', 'purple', 'slate', 'red']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number): string => String(n).padStart(2, '0')

export function hashId(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

export function avatarColor(id: string): ColorKey {
  return AVATAR_KEYS[hashId(id) % AVATAR_KEYS.length]
}

export function initials(name: string): string {
  return name
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

/** "8h 15m" from minutes; em dash when unknown. */
export function hrsLabel(min: number | null | undefined): string {
  if (min == null) return '—'
  const m = Math.max(0, Math.round(min))
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

export function fmtClock(ms: number, tz: string): string {
  const p = wallParts(ms, tz)
  return `${pad(p.h)}:${pad(p.min)}`
}

/** "FRI 28" */
export function fmtDayShort(ms: number, tz: string): string {
  const p = wallParts(ms, tz)
  return `${p.wd.toUpperCase()} ${p.d}`
}

/** "Aug 28 @ 14:32" */
export function fmtDT(ms: number, tz: string): string {
  const p = wallParts(ms, tz)
  return `${MONTHS[p.m - 1]} ${p.d} @ ${pad(p.h)}:${pad(p.min)}`
}

export function cityOf(address: string | null | undefined): string {
  return String(address ?? '').split(',')[0]?.trim() ?? ''
}

/** "4m" / "3h" / "2d" / "now" / "—" */
export function ageLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}
