// Column state is a per-browser convenience. The server's layout is the
// truth; "Reset to their layout" clears this.
export interface ColumnPrefs {
  visibility: Record<string, boolean>
  order: string[]
  sizing: Record<string, number>
  density: 'theirs' | 'tight'
}
export const PREFS_KEY = 'brokerBoard.columns.v1'

export function loadPrefs(): ColumnPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<ColumnPrefs>
    if (!p || typeof p !== 'object') return null
    return { visibility: p.visibility ?? {}, order: p.order ?? [], sizing: p.sizing ?? {}, density: p.density === 'tight' ? 'tight' : 'theirs' }
  } catch { return null }
}
export function savePrefs(p: ColumnPrefs): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* storage unavailable: a convenience, not a requirement */ } }
export function clearPrefs(): void { try { localStorage.removeItem(PREFS_KEY) } catch { /* same */ } }
