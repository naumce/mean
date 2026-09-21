import { describe, expect, it } from "vitest";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import type { DriverInput, LoadInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

const T0 = Date.UTC(2026, 8, 1, 6, 0, 0);

const tractor: TractorInput = { status: "active" };
const trailer: TrailerInput = { type: "DryVan", status: "active" };

/** 7 driving hours already banked: any leg over 1h forces a break. */
function driverAt(lat: number, lng: number, minutesSinceBreak = 420): DriverInput {
  return {
    status: "active",
    hazmatEndorsed: false,
    availableAt: T0,
    location: { lat, lng },
    hos: {
      driveRemainingMin: 660,
      windowRemainingMin: 840,
      cycleRemainingMin: 3600,
      minutesSinceBreak,
    },
  };
}

const KC = { lat: 39.0997, lng: -94.5786 };
const COLUMBIA = { lat: 38.9517, lng: -92.3341 };
const MEMPHIS = { lat: 35.1495, lng: -90.049 };
const CHICAGO = { lat: 41.878, lng: -87.6298 };

/** KC -> Columbia MO: ~120 mi great-circle, ~145 road mi, ~173 driving min.
 *  Short enough that a rested driver needs NO break — which is what makes it
 *  usable as the negative case. (KC -> Memphis is ~533 driving minutes and
 *  crosses 480 even from zero banked, so it cannot serve that role.) */
const shortHaul: LoadInput = {
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: COLUMBIA, dwellMin: 60 },
  ],
};

/** KC -> Memphis: ~370 mi great-circle, ~444 road mi, ~533 driving min. */
const longHaul: LoadInput = {
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: MEMPHIS, dwellMin: 60 },
  ],
};

describe("break points", () => {
  it("emits no breaks when the trip never crosses the 8h boundary", () => {
    // Driver sits on the pickup (no deadhead), 173 min of driving, nothing
    // banked: 173 < 480, so no crossing.
    const res = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 0), tractor, trailer);
    expect(res.plan.breaks).toEqual([]);
    expect(res.plan.needsBreak).toBe(false);
  });

  it("emits one break on the loaded leg, positioned by fraction", () => {
    const res = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 420), tractor, trailer);
    expect(res.plan.needsBreak).toBe(true);
    expect(res.plan.breaks).toHaveLength(1);
    const b = res.plan.breaks[0];
    // 420 banked + 60 more driving = 480. Deadhead is 0, so the break lands
    // 60 driving-minutes into the loaded leg — roughly a third of the way.
    expect(b.afterDriveMin).toBeCloseTo(60, 5);
    expect(b.legIndex).toBe(0);
    expect(b.fraction).toBeGreaterThan(0.2);
    expect(b.fraction).toBeLessThan(0.5);
    expect(b.precision).toBe("estimated");
    // Break lands on leg 0 (KC -> Columbia): its position must be strictly
    // between the two stops' latitudes, not merely present.
    expect(b.at).not.toBeNull();
    const lo = Math.min(KC.lat, COLUMBIA.lat);
    const hi = Math.max(KC.lat, COLUMBIA.lat);
    expect(b.at!.lat).toBeGreaterThan(lo);
    expect(b.at!.lat).toBeLessThan(hi);
  });

  it("places the break on the deadhead leg when the clock expires before pickup", () => {
    // Chicago -> KC deadhead (~590 driving min) with 7h50m banked: the
    // crossing happens 10 min in, en route to the pickup. This plan is HOS-
    // infeasible overall, which is fine — breaks are emitted from the
    // timeline walk regardless of the verdict, and asserting on an
    // infeasible plan proves that.
    const res = evaluate(shortHaul, driverAt(CHICAGO.lat, CHICAGO.lng, 470), tractor, trailer);
    expect(res.plan.breaks.length).toBeGreaterThanOrEqual(1);
    expect(res.plan.breaks[0].legIndex).toBe(-1);
    expect(res.plan.breaks[0].afterDriveMin).toBeCloseTo(10, 5);
  });

  it("agrees with the timeline: the break adds exactly 30 min to proposedEnd", () => {
    // Same load, same driver, same origin — the ONLY difference is banked
    // minutes, so the whole delta is the inserted break.
    const withBreak = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 420), tractor, trailer);
    const without = evaluate(shortHaul, driverAt(KC.lat, KC.lng, 0), tractor, trailer);
    expect(withBreak.plan.breaks).toHaveLength(1);
    expect(without.plan.breaks).toHaveLength(0);
    const deltaMin = (withBreak.plan.proposedEnd - without.plan.proposedEnd) / 60_000;
    expect(deltaMin).toBeCloseTo(30, 5);
  });

  it("needsBreak is exactly breaks.length > 0", () => {
    for (const since of [0, 100, 306, 307, 420, 479, 480, 600]) {
      const res = evaluate(shortHaul, driverAt(KC.lat, KC.lng, since), tractor, trailer);
      expect(res.plan.needsBreak).toBe(res.plan.breaks.length > 0);
    }
  });

  it("orders breaks by time and matches the count evaluateHos reports", () => {
    const res = evaluate(longHaul, driverAt(CHICAGO.lat, CHICAGO.lng, 400), tractor, trailer);
    const times = res.plan.breaks.map((b) => b.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // onDutyMin includes BREAK_DURATION_MIN per break; the two counters must
    // never disagree (Global Constraint 2 — one definition per concept).
    const impliedBreaks = (res.plan.onDutyMin - res.plan.driveMin - 120) / 30;
    expect(res.plan.breaks).toHaveLength(impliedBreaks);
  });
});
