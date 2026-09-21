import { complianceStatus } from '../compliance'
import type { PillColor } from './lanes'

// Compliance clock chips ("DOT: Nov '26 ✓") and the status-pill palette.
export interface Chip {
  text: string
  cls: string
  level: 'expired' | 'soon' | 'ok' | 'untracked'
}

const CHIP_CLASS: Record<Chip['level'], string> = {
  expired: 'bg-red-500/15 border-red-500/50 text-red-500 font-bold',
  soon: 'bg-amber-500/15 border-amber-500/40 text-amber-500 font-bold',
  ok: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500 font-bold',
  untracked: 'bg-surface-3 border-line text-ink-3',
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function clockChip(prefix: string, iso: string | null | undefined, nowMs: number): Chip {
  const s = complianceStatus(iso, nowMs)
  if (s.level === 'untracked') return { text: `${prefix}: —`, cls: CHIP_CLASS.untracked, level: s.level }
  const d = new Date(Date.parse(iso!))
  const short = `${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`
  const mark = s.level === 'expired' ? ' ⚠ EXPIRED' : s.level === 'soon' ? ' ⚠' : ' ✓'
  return { text: `${prefix}: ${short}${mark}`, cls: CHIP_CLASS[s.level], level: s.level }
}

export const PILL_CLASSES: Record<PillColor, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  blue: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
  amber: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
  red: 'bg-red-500/20 text-red-500 border-red-500/40',
  slate: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  purple: 'bg-purple-500/10 text-purple-500 border-purple-500/30',
  cyan: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
}
