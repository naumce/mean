import { nearestCity } from "../src/lib/usCities.js";

it("maps a coordinate to the nearest known freight market, formatted for a lane label", () => {
  expect(nearestCity(39.1, -94.58)).toEqual({ label: "Kansas City, MO", miles: expect.any(Number) });
  expect(nearestCity(38.63, -90.2)?.label).toBe("St. Louis, MO");
  expect(nearestCity(38.63, -90.2)!.miles).toBeLessThan(1);
});

it("returns null when nothing in the gazetteer is within range", () => {
  expect(nearestCity(0, 0)).toBeNull();
  expect(nearestCity(64.8, -147.7, 100)).toBeNull(); // Fairbanks: no Alaska entries
});
