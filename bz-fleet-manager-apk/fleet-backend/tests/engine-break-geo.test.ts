import { describe, expect, it } from "vitest";
import { interpolate } from "../src/domain/dispatch/breakGeo.js";
import { haversineMi } from "../src/domain/dispatch/distance.js";

const KC = { lat: 39.0997, lng: -94.5786 };
const MEM = { lat: 35.1495, lng: -90.049 };

describe("interpolate", () => {
  it("returns the endpoints at 0 and 1", () => {
    expect(interpolate(KC, MEM, 0)).toEqual(KC);
    expect(interpolate(KC, MEM, 1)).toEqual(MEM);
  });

  it("puts the midpoint within a mile of half the great-circle distance", () => {
    const mid = interpolate(KC, MEM, 0.5);
    const total = haversineMi(KC, MEM);
    expect(haversineMi(KC, mid)).toBeCloseTo(total / 2, 0);
    expect(haversineMi(mid, MEM)).toBeCloseTo(total / 2, 0);
  });

  it("clamps out-of-range fractions instead of extrapolating", () => {
    // A caller that computed 1.4 has a bug; extrapolating would place the
    // break somewhere the driver never goes.
    expect(interpolate(KC, MEM, -3)).toEqual(KC);
    expect(interpolate(KC, MEM, 42)).toEqual(MEM);
  });

  it("survives coincident endpoints without NaN", () => {
    const p = interpolate(KC, { ...KC }, 0.5);
    expect(Number.isFinite(p.lat)).toBe(true);
    expect(Number.isFinite(p.lng)).toBe(true);
  });

  it("crosses the antimeridian by the short way", () => {
    const mid = interpolate({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.5);
    // The short way is through 180, not back through 0.
    expect(Math.abs(mid.lng)).toBeGreaterThan(179.5);
  });
});
