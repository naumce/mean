// Route geometry shared by both GPS views (T2 "Map as Navigation", Task 1).
//
// A load's stops used to be joined with a dead-straight line from the first
// stop to the last — on real Mapbox tiles a Kansas City -> Memphis chord
// cuts across country and reads as obviously fake, and a multi-stop load
// lies about its own shape. This module is the one definition of "what a
// route looks like": a quadratic Bezier per leg, bowed away from the chord,
// concatenated leg-to-leg so the path actually passes through every stop.
//
// This is the same curve RadarView's schematic already drew (its own
// `curve()` used to hand-roll this math in pixel space) — RadarView now
// calls `controlPoint`/`quadraticPoint` from here too, so the schematic and
// the live map can't drift the way this codebase's shared concepts have
// drifted before.

/** A [lng, lat] pair — Mapbox/GeoJSON coordinate order. */
export type LngLat = [number, number]

/** How far the curve bows off the straight chord, as a fraction of the
 *  chord's own length. Matches RadarView's original hand-rolled constant. */
export const DEFAULT_BEND_RATIO = 0.12

/** How many line segments approximate one leg's Bezier curve. SVG (RadarView)
 *  renders the curve natively via a `Q` path command and doesn't need this;
 *  Mapbox only draws straight `LineString` segments, so the live map needs
 *  the curve discretized into enough points to read as smooth. */
export const DEFAULT_STEPS = 32

/** The control point of the quadratic Bezier from `a` to `b`: the chord's
 *  midpoint, pushed perpendicular to the chord by `bendRatio` times the
 *  chord's own length.
 *
 *  A zero-length chord (a load whose pickup and delivery geocode
 *  identically) has no perpendicular direction to normalise — dividing by
 *  its zero length would produce NaN, and mapbox-gl throws on non-finite
 *  coordinates. Guarded here: a degenerate chord's control point simply
 *  collapses onto the shared point, same as its "arc" does. */
export function controlPoint(a: LngLat, b: LngLat, bendRatio: number = DEFAULT_BEND_RATIO): LngLat {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const chordLen = Math.hypot(dx, dy)
  const [ux, uy] = chordLen === 0 ? [0, 0] : [dy / chordLen, -dx / chordLen]
  const midX = (a[0] + b[0]) / 2
  const midY = (a[1] + b[1]) / 2
  return [midX + ux * bendRatio * chordLen, midY + uy * bendRatio * chordLen]
}

/** A point at parameter `t` (0..1) along the quadratic Bezier defined by
 *  endpoints `a`/`b` and control point `c`. */
export function quadraticPoint(a: LngLat, c: LngLat, b: LngLat, t: number): LngLat {
  const mt = 1 - t
  const x = mt * mt * a[0] + 2 * mt * t * c[0] + t * t * b[0]
  const y = mt * mt * a[1] + 2 * mt * t * c[1] + t * t * b[1]
  return [x, y]
}

/** The curved path from `a` to `b`: `steps + 1` points sampled along the
 *  quadratic Bezier, starting exactly on `a` and ending exactly on `b`. */
export function arcBetween(a: LngLat, b: LngLat, bendRatio: number = DEFAULT_BEND_RATIO, steps: number = DEFAULT_STEPS): LngLat[] {
  const c = controlPoint(a, b, bendRatio)
  const pts: LngLat[] = []
  for (let i = 0; i <= steps; i++) {
    pts.push(quadraticPoint(a, c, b, i / steps))
  }
  return pts
}

/** The full multi-stop route: one bowed arc per leg, concatenated so the
 *  path passes through every intermediate stop (not just the first and
 *  last). The point shared by two consecutive legs is included once, not
 *  duplicated. Fewer than two stops has no line to draw — an empty path
 *  rather than a half-drawn one. */
export function routePath(stops: LngLat[], bendRatio: number = DEFAULT_BEND_RATIO, steps: number = DEFAULT_STEPS): LngLat[] {
  if (stops.length < 2) return []
  const path: LngLat[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const leg = arcBetween(stops[i], stops[i + 1], bendRatio, steps)
    path.push(...(i === 0 ? leg : leg.slice(1)))
  }
  return path
}

/** Splits a route path (as produced by `arcBetween`/`routePath`) at
 *  progress `t` (0..1) into the portion already covered (`done`) and what's
 *  left (`remaining`) — the geometry half of "how far along is this load",
 *  the single most common question a dispatcher asks a map.
 *
 *  Both halves include the point at `t`: `done`'s last point equals
 *  `remaining`'s first point exactly. Splitting the array in two without
 *  duplicating that point would leave neither half owning it, and a line
 *  layer drawn from each half would then render with a visible gap right at
 *  the truck — the exact artifact this function exists to prevent.
 *
 *  `t` is clamped to [0, 1] rather than thrown on out-of-range input — a
 *  clock skew or a leg whose `plannedEnd` has already passed can otherwise
 *  hand this a value outside that range, and a map should degrade
 *  gracefully rather than crash. A path shorter than two points has no line
 *  to split in the first place: empty/empty, not a half-drawn one. */
export function splitAtProgress(path: LngLat[], t: number): { done: LngLat[]; remaining: LngLat[] } {
  if (path.length < 2) return { done: [], remaining: [] }

  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  if (clamped === 0) return { done: [], remaining: path.slice() }
  if (clamped === 1) return { done: path.slice(), remaining: [] }

  // Treat the path as `path.length - 1` equal-length segments (the same
  // approximation `progressShare`/`rollingPosition` already make elsewhere:
  // elapsed *time* share, not measured road distance) and locate `t` within
  // them.
  const segments = path.length - 1
  const scaled = clamped * segments
  const index = Math.min(Math.floor(scaled), segments - 1)
  const frac = scaled - index

  if (frac === 0) {
    // `t` lands exactly on an existing sample point — that point is the
    // split point already, shared by construction; no interpolation (and no
    // duplicate point) needed.
    return { done: path.slice(0, index + 1), remaining: path.slice(index) }
  }

  const a = path[index]
  const b = path[index + 1]
  const split: LngLat = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
  return { done: [...path.slice(0, index + 1), split], remaining: [split, ...path.slice(index + 1)] }
}
