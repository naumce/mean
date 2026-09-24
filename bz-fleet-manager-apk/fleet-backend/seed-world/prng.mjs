// Deterministic randomness for the whole demo world (Task 7): every
// call site in seed-world/* draws from ONE mulberry32 stream seeded from the
// fixed string "fleet-world-2026" — never Math.random(). Two runs with the
// same `scale`/`now` must be byte-identical, so every helper here is a pure
// function of the stream's current state (or, for stableId, of a caller-
// supplied semantic key — never of call order), and nothing in this file
// touches the network, the clock, or the database.
//
// Compute-then-write discipline (see seed-world.mjs's own header comment):
// every function in this module is synchronous. Calling any of them from
// inside a `Promise.all` of concurrent DB writes would make the STREAM's
// position depend on I/O timing, which is exactly the non-determinism this
// module exists to rule out — all random draws must happen during the
// synchronous "build" phase, before any `await`.
import crypto from "node:crypto";

/** FNV-1a-ish string hash -> uint32. Only used to turn the seed STRING into
 *  mulberry32's numeric internal state; not itself a source of "randomness"
 *  callers draw from. */
export function hashStringToUint32(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 2654435761);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG. Returns a zero-arg function
 *  producing floats in [0, 1) — every other helper in this file is built on
 *  calling that function some number of times, so the ENTIRE world's
 *  randomness reduces to "how many times was rand() called, and with what
 *  inputs downstream" — both fixed by the generation code's own fixed
 *  control flow, which is what makes a rerun byte-identical. */
export function mulberry32(seedStr) {
  let a = hashStringToUint32(seedStr);
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], inclusive both ends. */
export function randInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

/** Float in [min, max). */
export function randFloat(rand, min, max) {
  return rand() * (max - min) + min;
}

/** true with probability `p` (default 0.5). */
export function chance(rand, p = 0.5) {
  return rand() < p;
}

/** One element of `arr`, uniformly. */
export function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

/** One `.value` from `entries` (`[{ value, weight }]`), weighted. Every
 *  weight must be > 0; the last entry is the floating-point-safe fallback so
 *  rounding at the boundary can never fall through with nothing chosen. */
export function pickWeighted(rand, entries) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let r = rand() * total;
  for (const entry of entries) {
    if (r < entry.weight) return entry.value;
    r -= entry.weight;
  }
  return entries[entries.length - 1].value;
}

/** A new, shuffled array — `arr` itself is never touched (hard rule: never
 *  mutate a shared array in place). Schwartzian-transform shuffle: map each
 *  element to a random sort key, sort the (fresh) pairs, unwrap. */
export function shuffle(rand, arr) {
  return arr
    .map((value) => ({ value, sortKey: rand() }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.value);
}

/** `count` distinct elements of `arr` (no repeats), order randomized. Caps at
 *  `arr.length` rather than throwing — a caller asking for more than exist
 *  gets everything, which is always the right answer for a demo population. */
export function sampleDistinct(rand, arr, count) {
  return shuffle(rand, arr).slice(0, Math.max(0, Math.min(count, arr.length)));
}

/** Deterministic id from a stable semantic key (e.g. "driver:WD-014" or
 *  "load:W-A-RELIABLE"), NOT from the PRNG stream — a UUID-shaped sha1 of the
 *  key, so re-running the generator with the same inputs reproduces the
 *  identical id for the identical row every time (byte-identical reruns,
 *  verified by the seed-world test's "identical scenario driver ids" check),
 *  independent of call order, Promise.all scheduling, or Prisma's own random
 *  `@default(uuid())` (which this deliberately bypasses by always passing an
 *  explicit `id` on create). Every id domain (driver/load/stop/...) must
 *  prefix its key so two different rows can never collide on the same hash
 *  input by accident. */
export function stableId(key) {
  const hex = crypto.createHash("sha1").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
