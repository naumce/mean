import { describe, expect, it } from 'vitest'
import { arcBetween, routePath, splitAtProgress, type LngLat } from './mapGeometry'

const KC: [number, number] = [-94.58, 39.1]
const MEM: [number, number] = [-90.05, 35.15]

describe('arcBetween', () => {
  it('starts and ends exactly on its endpoints', () => {
    const p = arcBetween(KC, MEM)
    expect(p[0]).toEqual(KC)
    expect(p[p.length - 1]).toEqual(MEM)
  })

  it('bows away from the straight chord — that is the whole point', () => {
    const p = arcBetween(KC, MEM)
    const mid = p[Math.floor(p.length / 2)]
    // The chord's midpoint, for comparison.
    const chordMid = [(KC[0] + MEM[0]) / 2, (KC[1] + MEM[1]) / 2]
    const off = Math.hypot(mid[0] - chordMid[0], mid[1] - chordMid[1])
    expect(off).toBeGreaterThan(0.05)
  })

  it('bends consistently, not randomly — same input, same output', () => {
    expect(arcBetween(KC, MEM)).toEqual(arcBetween(KC, MEM))
  })

  it('degenerates safely when both endpoints are the same point', () => {
    // A load whose pickup and delivery geocode identically must not produce
    // NaN coordinates — mapbox-gl throws on those and the map dies.
    const p = arcBetween(KC, KC)
    for (const [lng, lat] of p) {
      expect(Number.isFinite(lng)).toBe(true)
      expect(Number.isFinite(lat)).toBe(true)
    }
  })
})

describe('routePath', () => {
  it('passes THROUGH every intermediate stop, not just the ends', () => {
    const STL: [number, number] = [-90.2, 38.63]
    const path = routePath([KC, STL, MEM])
    const hits = path.filter((p) => Math.hypot(p[0] - STL[0], p[1] - STL[1]) < 0.001)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('returns an empty path for fewer than two stops rather than a half-drawn line', () => {
    expect(routePath([KC])).toEqual([])
    expect(routePath([])).toEqual([])
  })
})

describe('splitAtProgress', () => {
  const path = routePath([KC, MEM])

  it('t=0: nothing driven yet — empty done, the whole path remaining', () => {
    const { done, remaining } = splitAtProgress(path, 0)
    expect(done).toEqual([])
    expect(remaining).toEqual(path)
  })

  it('t=1: fully driven — the reverse of t=0', () => {
    const { done, remaining } = splitAtProgress(path, 1)
    expect(done).toEqual(path)
    expect(remaining).toEqual([])
  })

  it('t=0.5: both halves share the split point — no gap at the truck', () => {
    const { done, remaining } = splitAtProgress(path, 0.5)
    expect(done.length).toBeGreaterThan(0)
    expect(remaining.length).toBeGreaterThan(0)
    // THE discriminating assertion: a split that drops the shared point (an
    // off-by-one slice on either half) renders as a visible gap in the line
    // right at the truck — the exact defect this function exists to avoid.
    // Verified live: with `path` here (33 points, the default steps=32),
    // t=0.5 lands exactly on sample index 16, taking splitAtProgress's
    // "frac===0" branch. Temporarily changing that branch's
    // `remaining: path.slice(index)` to `path.slice(index + 1)` (dropping
    // the shared point) makes this exact assertion fail — 2 tests red, the
    // other 12 in this file still green — restored immediately after.
    expect(done[done.length - 1]).toEqual(remaining[0])
  })

  it('a fractional t (not landing on an existing sample point) still shares an interpolated split point', () => {
    // t=0.5 above only exercises the "t lands exactly on a sample" branch;
    // this pins the interpolating branch the same way.
    const { done, remaining } = splitAtProgress(path, 0.3)
    expect(done.length).toBeGreaterThan(0)
    expect(remaining.length).toBeGreaterThan(0)
    expect(done[done.length - 1]).toEqual(remaining[0])
    // The interpolated split point sits strictly between its two bracketing
    // samples — not equal to either — so it's a genuinely new point, not one
    // of the original path's own vertices reused.
    const split = done[done.length - 1]
    expect(path).not.toContainEqual(split)
  })

  it('reassembling the two halves (without double-counting the shared point) reproduces the original path', () => {
    const { done, remaining } = splitAtProgress(path, 0.5)
    const reassembled = [...done, ...remaining.slice(1)]
    expect(reassembled).toEqual(path)
  })

  it('starts done exactly on the path start and ends remaining exactly on the path end', () => {
    const { done, remaining } = splitAtProgress(path, 0.5)
    expect(done[0]).toEqual(path[0])
    expect(remaining[remaining.length - 1]).toEqual(path[path.length - 1])
  })

  it('clamps an out-of-range t rather than throwing', () => {
    expect(() => splitAtProgress(path, 1.5)).not.toThrow()
    expect(splitAtProgress(path, 1.5)).toEqual(splitAtProgress(path, 1))
    expect(() => splitAtProgress(path, -0.3)).not.toThrow()
    expect(splitAtProgress(path, -0.3)).toEqual(splitAtProgress(path, 0))
  })

  it('a path of fewer than two points returns empty/empty, not a half-drawn line', () => {
    expect(splitAtProgress([], 0.5)).toEqual({ done: [], remaining: [] })
    const onePoint: LngLat[] = [KC]
    expect(splitAtProgress(onePoint, 0.5)).toEqual({ done: [], remaining: [] })
  })

  it('a not-yet-started leg (t=0) must show no completed portion at all, not a sliver', () => {
    // Pinned explicitly, not just covered by the generic t=0 case above:
    // this is the exact scenario the brief calls out — an `assigned` leg
    // that hasn't started must never draw even a few percent as "driven".
    const { done } = splitAtProgress(path, 0)
    expect(done).toHaveLength(0)
  })
})
