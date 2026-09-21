import { describe, expect, it } from "vitest";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import type { DriverInput, LoadInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

const T0 = Date.UTC(2026, 8, 1, 6, 0, 0);

const tractor: TractorInput = { status: "active" };
const trailer: TrailerInput = { type: "DryVan", status: "active" };

function driverAt(lat: number, lng: number, minutesSinceBreak = 0): DriverInput {
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

const twoStop: LoadInput = {
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: COLUMBIA, dwellMin: 60 },
  ],
};

const threeStop: LoadInput = {
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "intermediate", location: COLUMBIA, dwellMin: 30 },
    { sequence: 3, type: "delivery", location: MEMPHIS, dwellMin: 60 },
  ],
};

const oneStop: LoadInput = {
  requiredEquip: "DryVan",
  stops: [{ sequence: 1, type: "pickup", location: KC, dwellMin: 60 }],
};

describe("plan legs", () => {
  it("a two-stop plan yields exactly 2 legs, indices [-1, 0]", () => {
    const res = evaluate(twoStop, driverAt(CHICAGO.lat, CHICAGO.lng), tractor, trailer);
    expect(res.plan.legs).toHaveLength(2);
    expect(res.plan.legs.map((l) => l.index)).toEqual([-1, 0]);
  });

  it("sum(legs.miles) equals deadheadMi + loadedMi", () => {
    const res = evaluate(twoStop, driverAt(CHICAGO.lat, CHICAGO.lng), tractor, trailer);
    const sum = res.plan.legs.reduce((acc, l) => acc + l.miles, 0);
    expect(sum).toBeCloseTo(res.plan.deadheadMi + res.plan.loadedMi, 6);
  });

  it("legs[0].milesRemaining equals the plan total, and the last leg's equals its own miles", () => {
    const res = evaluate(twoStop, driverAt(CHICAGO.lat, CHICAGO.lng), tractor, trailer);
    const { legs, deadheadMi, loadedMi } = res.plan;
    expect(legs[0].milesRemaining).toBeCloseTo(deadheadMi + loadedMi, 6);
    const last = legs[legs.length - 1];
    expect(last.milesRemaining).toBeCloseTo(last.miles, 6);
  });

  it("milesRemaining is strictly decreasing across legs", () => {
    const res = evaluate(threeStop, driverAt(CHICAGO.lat, CHICAGO.lng), tractor, trailer);
    const remainings = res.plan.legs.map((l) => l.milesRemaining);
    for (let i = 1; i < remainings.length; i++) {
      expect(remainings[i]).toBeLessThan(remainings[i - 1]);
    }
  });

  it("a three-stop plan yields 3 legs with indices [-1, 0, 1]", () => {
    const res = evaluate(threeStop, driverAt(CHICAGO.lat, CHICAGO.lng), tractor, trailer);
    expect(res.plan.legs).toHaveLength(3);
    expect(res.plan.legs.map((l) => l.index)).toEqual([-1, 0, 1]);
    const sum = res.plan.legs.reduce((acc, l) => acc + l.miles, 0);
    expect(sum).toBeCloseTo(res.plan.deadheadMi + res.plan.loadedMi, 6);
  });

  it("a driver standing exactly on the first pickup produces a zero-mile deadhead leg that is still present", () => {
    const res = evaluate(twoStop, driverAt(KC.lat, KC.lng), tractor, trailer);
    expect(res.plan.deadheadMi).toBeCloseTo(0, 9);
    expect(res.plan.legs).toHaveLength(2);
    expect(res.plan.legs[0].index).toBe(-1);
    expect(res.plan.legs[0].miles).toBeCloseTo(0, 9);
    // absent != zero: the leg exists even though it carries no distance.
    expect(res.plan.legs[0].milesRemaining).toBeCloseTo(res.plan.loadedMi, 6);
  });

  it("invalid() paths (a one-stop load) return legs: []", () => {
    const res = evaluate(oneStop, driverAt(KC.lat, KC.lng), tractor, trailer);
    expect(res.feasible).toBe(false);
    expect(res.plan.legs).toEqual([]);
  });
});
