// dispatchTools/limit.ts (AI Dispatch Foundation, Task 5): one shared "clamp
// an optional page size" rule for the list-shaped tools (searchLoads,
// searchDrivers, getDriverHistory) — a non-finite, fractional, or
// out-of-range value falls back to a safe one rather than reaching Prisma's
// `take` with something like 0, a negative number, or Infinity. Input
// validation lives here rather than trusting each call site to repeat it.

/** Row ceiling for every list tool and the manifest's LIMIT schema — one
 *  export so its importers cannot drift apart. */
export const MAX_LIST_LIMIT = 200;

export function clampLimit(raw: number | undefined, def: number, max: number): number {
  if (raw == null || !Number.isFinite(raw)) return def;
  return Math.min(max, Math.max(1, Math.trunc(raw)));
}
