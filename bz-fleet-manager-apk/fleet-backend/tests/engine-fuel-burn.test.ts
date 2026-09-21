import { describe, expect, it } from "vitest";
import { fuelBurn } from "../src/domain/dispatch/fuel.js";

describe("fuelBurn", () => {
  it("divides loaded and deadhead miles by mpg separately", () => {
    const b = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 6.5);
    expect(b.deadheadGal).toBeCloseTo(15.38, 2);
    expect(b.loadedGal).toBeCloseTo(92.31, 2);
    expect(b.totalGal).toBeCloseTo(107.69, 2);
    expect(b.mpgUsed).toBe(6.5);
  });

  it("totalGal is always exactly the sum of the two legs", () => {
    const b = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 6.5);
    expect(b.totalGal).toBe(b.deadheadGal + b.loadedGal);
  });

  it("refuses an mpg of 0 — all-null/zero, never Infinity", () => {
    const b = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, 0);
    expect(b).toEqual({ deadheadGal: 0, loadedGal: 0, totalGal: 0, mpgUsed: null });
  });

  it("refuses a negative mpg — all-null/zero, never a negative gallon figure", () => {
    const b = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, -6.5);
    expect(b).toEqual({ deadheadGal: 0, loadedGal: 0, totalGal: 0, mpgUsed: null });
  });

  it("refuses an mpg of NaN the same way as <= 0", () => {
    const b = fuelBurn({ deadheadMi: 100, loadedMi: 600 }, NaN);
    expect(b).toEqual({ deadheadGal: 0, loadedGal: 0, totalGal: 0, mpgUsed: null });
  });

  it("zero miles gives zero gallons but keeps a non-null mpgUsed", () => {
    const b = fuelBurn({ deadheadMi: 0, loadedMi: 0 }, 6.5);
    expect(b.deadheadGal).toBe(0);
    expect(b.loadedGal).toBe(0);
    expect(b.totalGal).toBe(0);
    expect(b.mpgUsed).toBe(6.5);
  });
});
