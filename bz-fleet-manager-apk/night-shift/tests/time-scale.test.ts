import { afterEach, describe, expect, it, vi } from "vitest";
import type { Brief, LngLat, RouteAnswer } from "../src/core/types.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const MIN = 60_000;
const t = (min: number) => T0 + min * MIN;
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 }; // 1 mi/min, exactly
const brief: Brief = {
  loadRef: "W-SCALE", origin: { name: "KC", ...KC }, destination: { name: "DSM", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(300), driverName: "Jake", driverPhone: "+1", customerEmail: null,
  minutesSinceBreakAtDepart: 0,
};
const parked = (spot: { lat: number; lng: number }, fromMin: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ atMs: t(fromMin + i), ...spot }));

// The pitch cannot wait fifty minutes for the ladder. The scale shrinks the
// stop rule and the ladder's rung-gap cooldown together; road-truth rules
// (delay, gone-dark, off-route) do not move — they are claims about the
// road, not about patience. Every module that reads TIME_SCALE has to be
// re-imported fresh after stubbing the env var, because it is read once at
// module load — hence the dynamic imports and vi.resetModules() throughout.
describe("NIGHT_SHIFT_TIME_SCALE", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("defaults to 1: the minutes in constants.ts are the product", async () => {
    vi.resetModules();
    const C = await import("../src/core/constants.js");
    expect(C.TIME_SCALE).toBe(1);
  });

  it("refuses nonsense: zero, negative, above 1, or not a number fall back to 1", async () => {
    for (const bad of ["0", "-1", "3", "fast"]) {
      vi.stubEnv("NIGHT_SHIFT_TIME_SCALE", bad);
      vi.resetModules();
      const C = await import("../src/core/constants.js");
      expect(C.TIME_SCALE).toBe(1);
    }
  });

  it("at 0.2, the stop rule and the ladder's rung-gap cooldown shrink five-fold, and the delay rule does not move", async () => {
    // --- scale 1 (default: no env stub) ---
    vi.resetModules();
    {
      const { pointAlongRoute } = await import("../src/core/geo.js");
      const { buildPlan } = await import("../src/core/plan.js");
      const { detectUnplannedStop, detectDelay } = await import("../src/core/detect.js");
      const { initialLadder, applyAction, nextAction } = await import("../src/core/ladder.js");
      const { STANDARD } = await import("../src/core/policy.js");
      const plan = buildPlan(brief, ROUTE, []);

      // stopMin 15 * 1 = 15: a 3-minute dwell is nowhere near it.
      const spot = pointAlongRoute(ROUTE.geometry, 62 / 180);
      expect(detectUnplannedStop(plan, STANDARD, parked(spot, 62, 4), [], t(65))).toBeNull();

      // delayMin is NOT scaled: 25 behind is under the un-scaled 30, same as
      // it would be at any scale — mile 75 at minute 100, on a 1-mi/min
      // route, is exactly 25 miles (= 25 minutes) behind the plan line.
      const at75 = pointAlongRoute(ROUTE.geometry, 75 / 180);
      expect(detectDelay(plan, STANDARD, at75, t(100), t(100), false)).toBeNull();

      // rungGapMin 5 * 1 = 5: the retry is not ready after 1 minute, only
      // after 5.
      const afterCall = applyAction(initialLadder(), { rung: 3, kind: "call" }, t(0));
      expect(nextAction(afterCall, { nowMs: t(1), linkOpenedMs: t(0), policy: STANDARD })).toBeNull();
      expect(nextAction(afterCall, { nowMs: t(5), linkOpenedMs: t(0), policy: STANDARD })).toEqual({ rung: 3, kind: "call_retry" });
    }

    // --- scale 0.2 ---
    vi.stubEnv("NIGHT_SHIFT_TIME_SCALE", "0.2");
    vi.resetModules();
    {
      const { pointAlongRoute } = await import("../src/core/geo.js");
      const { buildPlan } = await import("../src/core/plan.js");
      const { detectUnplannedStop, detectDelay } = await import("../src/core/detect.js");
      const { initialLadder, applyAction, nextAction } = await import("../src/core/ladder.js");
      const { STANDARD } = await import("../src/core/policy.js");
      const plan = buildPlan(brief, ROUTE, []);

      // stopMin 15 * 0.2 = 3: the same 3-minute dwell now trips it.
      const spot = pointAlongRoute(ROUTE.geometry, 62 / 180);
      expect(detectUnplannedStop(plan, STANDARD, parked(spot, 62, 4), [], t(65))).not.toBeNull();

      // Still 25 behind, still under the still-30 threshold — a scaled
      // delayMin would have shrunk this to 6 and fired wrongly.
      const at75 = pointAlongRoute(ROUTE.geometry, 75 / 180);
      expect(detectDelay(plan, STANDARD, at75, t(100), t(100), false)).toBeNull();

      // rungGapMin 5 * 0.2 = 1: the same one minute that was too soon at
      // scale 1 is now enough.
      const afterCall = applyAction(initialLadder(), { rung: 3, kind: "call" }, t(0));
      expect(nextAction(afterCall, { nowMs: t(1), linkOpenedMs: t(0), policy: STANDARD })).toEqual({ rung: 3, kind: "call_retry" });
    }
  });
});
