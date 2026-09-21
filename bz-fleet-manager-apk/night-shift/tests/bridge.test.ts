import { describe, expect, it } from "vitest";
import { breaksRequired, dwellSegments, haversineMi, interpolate, BREAK_THRESHOLD_MIN } from "../src/domain.js";

// The bridge is the ONLY path to fleet-backend's domain code. If it breaks,
// every rule in this package silently loses the definitions it shares with
// the dispatch platform, and "one definition per concept" becomes two.
describe("domain bridge", () => {
  it("reaches the HOS rule that dispatch already uses", () => {
    expect(BREAK_THRESHOLD_MIN).toBe(480);
    expect(breaksRequired(0, 500)).toBe(1);
  });

  it("reaches haversine and interpolate", () => {
    const a = { lat: 39.1, lng: -94.58 };
    const b = { lat: 41.59, lng: -93.62 };
    expect(haversineMi(a, b)).toBeGreaterThan(170);
    const mid = interpolate(a, b, 0.5);
    expect(mid.lat).toBeCloseTo((a.lat + b.lat) / 2, 1);
  });

  it("reaches dwellSegments", () => {
    const c = { lat: 40, lng: -94 };
    const segs = dwellSegments([{ atMs: 0, lat: 40, lng: -94 }, { atMs: 600_000, lat: 40, lng: -94 }], c);
    expect(segs[0].observedMin).toBe(10);
  });
});
