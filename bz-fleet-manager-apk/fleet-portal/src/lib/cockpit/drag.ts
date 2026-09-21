// Pure gesture arithmetic. No DOM, no store, no clock — every input is an
// argument so the whole module is unit-testable, which matters because a
// one-pixel error here silently reschedules a truck by minutes.
import { wallMinutes, xToTime, type CockpitConfig } from './geometry'

export const SNAP_MIN = 15

export interface DragProposal {
  startMs: number
  endMs: number
}

/** Snap to the nearest quarter hour *of wall time in the org's zone*, not of
 *  UTC — a board drawn in local hours must snap to the lines it draws. */
export function snapMs(ms: number, tz: string, snapMin: number = SNAP_MIN): number {
  const mins = wallMinutes(ms, tz)
  const delta = Math.round(mins / snapMin) * snapMin - mins
  return ms + delta * 60_000
}

const msPerPx = (cfg: CockpitConfig): number => 3_600_000 / cfg.pxPerHour

/** Move the whole leg. Duration is preserved in elapsed milliseconds, so a leg
 *  dragged across a DST boundary keeps its real length rather than gaining or
 *  losing an hour of driving. */
export function proposeMove(startMs: number, endMs: number, dxPx: number, cfg: CockpitConfig): DragProposal {
  const start = snapMs(startMs + dxPx * msPerPx(cfg), cfg.tz)
  return { startMs: start, endMs: start + (endMs - startMs) }
}

/** Drag one edge. Returns null when the gesture would invert the leg or shrink
 *  it below a single snap unit — the caller shows no ghost rather than
 *  proposing something the server must reject. */
export function proposeResize(
  startMs: number,
  endMs: number,
  dxPx: number,
  edge: 'l' | 'r',
  cfg: CockpitConfig,
): DragProposal | null {
  const shift = dxPx * msPerPx(cfg)
  const p =
    edge === 'r'
      ? { startMs, endMs: snapMs(endMs + shift, cfg.tz) }
      : { startMs: snapMs(startMs + shift, cfg.tz), endMs }
  return p.endMs - p.startMs >= SNAP_MIN * 60_000 ? p : null
}

/** Where a dropped backlog card starts. `xToTime` already rounds to 15-minute
 *  wall marks (geometry.ts:141) and clamps to the visible window, so this is a
 *  named pass-through — snapping again would be a no-op that reads as though
 *  the two rounding rules were independent. If SNAP_MIN ever diverges from
 *  geometry's 15, this is the seam to change. */
export function proposeDrop(xPx: number, cfg: CockpitConfig): number {
  return xToTime(xPx, cfg)
}

/** Hit-test a pointer y against laid-out lanes. Boundaries belong to the lower
 *  lane so adjacent lanes tile without a dead pixel between them; outside every
 *  lane returns null rather than snapping to the nearest, because dropping a
 *  load on "whichever lane was closest" is how you assign the wrong driver. */
export function laneAtY(yPx: number, lanes: Array<{ id: string; top: number; height: number }>): string | null {
  for (const l of lanes) if (yPx >= l.top && yPx < l.top + l.height) return l.id
  return null
}
