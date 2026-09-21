import type { BoardViewState } from '../../lib/api'

// The board's own visual state: the fills a dispatcher painted and the columns
// they split into two lines. Pure functions over an immutable value — the
// store owns the copy that is saved, and every edit here returns a new one.

/** A cell's fill is keyed by the load, the column, and (for the second line)
 *  the line number — the same shape the handoff's prototype uses. */
export const cellKey = (loadId: string, colId: string, line: 1 | 2 = 1): string => (line === 1 ? `${loadId}|${colId}` : `${loadId}|${colId}|2`)

export const EMPTY_VIEW: BoardViewState = { fills: {}, merges: {} }

/** Column, then row, then cell, in increasing priority: a dispatcher who
 *  paints one cell after painting the whole row means the cell. */
export function fillFor(view: BoardViewState, loadId: string, colId: string, line: 1 | 2 = 1): string | undefined {
  const f = view.fills ?? {}
  return f.cell?.[cellKey(loadId, colId, line)] ?? f.row?.[loadId] ?? f.col?.[colId]
}

export type FillTarget =
  | { kind: 'cell'; loadId: string; colId: string; line: 1 | 2 }
  | { kind: 'row'; loadId: string }
  | { kind: 'col'; colId: string }

/** `null` is "no fill": the key is removed rather than set to a color that
 *  happens to look like the default. */
export function withFill(view: BoardViewState, targets: readonly FillTarget[], color: string | null): BoardViewState {
  const fills = { row: { ...(view.fills?.row ?? {}) }, col: { ...(view.fills?.col ?? {}) }, cell: { ...(view.fills?.cell ?? {}) } }
  for (const t of targets) {
    const [bucket, key] = t.kind === 'cell' ? [fills.cell, cellKey(t.loadId, t.colId, t.line)] : t.kind === 'row' ? [fills.row, t.loadId] : [fills.col, t.colId]
    if (color === null) delete bucket[key]
    else bucket[key] = color
  }
  return { ...view, fills: prune(fills) }
}

/** Empty buckets are dropped so a board nobody painted stores `{}` rather
 *  than three empty objects that grow forever. */
function prune(fills: { row: Record<string, string>; col: Record<string, string>; cell: Record<string, string> }) {
  const out: BoardViewState['fills'] = {}
  if (Object.keys(fills.row).length) out.row = fills.row
  if (Object.keys(fills.col).length) out.col = fills.col
  if (Object.keys(fills.cell).length) out.cell = fills.cell
  return out
}

/** A load is expanded — drawn as two lines — exactly when at least one of its
 *  columns is unmerged. */
export const unmergedKeys = (view: BoardViewState, loadId: string): string[] => view.merges?.[loadId] ?? []
export const isUnmerged = (view: BoardViewState, loadId: string, colKey: string): boolean => unmergedKeys(view, loadId).includes(colKey)
export const isExpanded = (view: BoardViewState, loadId: string): boolean => unmergedKeys(view, loadId).length > 0

/** Store a load's split columns exactly, INCLUDING an empty list. A board with
 *  no entry for a load falls back to the shape its data implies (a column with
 *  a carrier-line value is split); once a dispatcher merges or unmerges
 *  anything, their decision is the whole answer for that load — so "merge
 *  everything" has to be storable as `[]` rather than as no entry at all,
 *  which would fall back to the derived shape and undo them. */
export function setUnmerged(view: BoardViewState, loadId: string, colKeys: readonly string[]): BoardViewState {
  return { ...view, merges: { ...(view.merges ?? {}), [loadId]: [...colKeys] } }
}

export function withMerge(view: BoardViewState, loadId: string, colKeys: readonly string[], unmerged: boolean): BoardViewState {
  const merges = { ...(view.merges ?? {}) }
  const next = new Set(merges[loadId] ?? [])
  for (const key of colKeys) {
    if (unmerged) next.add(key)
    else next.delete(key)
  }
  if (next.size === 0) delete merges[loadId]
  else merges[loadId] = [...next]
  return { ...view, merges }
}
