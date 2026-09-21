import { haversineMi, roadMiles, driveMinutes } from "../src/domain/dispatch/distance.js";

// Kansas City (39.10, -94.58) -> Omaha (41.26, -95.93): ~166 great-circle miles.
const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };

it("haversine matches the known KC->Omaha great-circle distance (~166mi)", () => {
  const d = haversineMi(KC, OMAHA);
  expect(d).toBeGreaterThan(160);
  expect(d).toBeLessThan(172);
});

it("distance to self is zero", () => {
  expect(haversineMi(KC, KC)).toBeCloseTo(0, 6);
});

it("road miles inflate great-circle by the road factor", () => {
  expect(roadMiles(KC, OMAHA, 1.2)).toBeCloseTo(haversineMi(KC, OMAHA) * 1.2, 6);
});

it("drive minutes = miles / mph * 60", () => {
  expect(driveMinutes(100, 50)).toBeCloseTo(120, 6);
  expect(driveMinutes(0, 50)).toBe(0);
});

it("rejects a non-positive speed", () => {
  expect(() => driveMinutes(100, 0)).toThrow();
});
