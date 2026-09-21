import { describe, expect, it } from "vitest";
import { pointAlongRoute, projectOntoRoute, routeMiles } from "../src/core/geo.js";
import { buildPlan, expectedAlongMi, liveEtaMs, minutesBehindPlan, planLinePoint } from "../src/core/plan.js";
import type { Brief, LngLat, RouteAnswer } from "../src/core/types.js";

// Kansas City -> Des Moines, straight north-north-east, densified to one
// vertex per ~2 mi so vertex projection is meaningful.
const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 }; // 60 mph flat

const T0 = Date.UTC(2026, 8, 6, 11, 10); // 06:10 Central
const brief = (over: Partial<Brief> = {}): Brief => ({
  loadRef: "W-19",
  origin: { name: "Kansas City, MO", ...KC },
  destination: { name: "Des Moines, IA", ...DSM },
  equipment: "DryVan",
  departAtMs: T0,
  deadlineAtMs: T0 + 245 * 60_000, // 10:15
  driverName: "Jake Morrow",
  driverPhone: "+15550001",
  customerEmail: null,
  minutesSinceBreakAtDepart: 0,
  ...over,
});
const MIN = 60_000;

describe("geo", () => {
  it("measures the route and walks along it", () => {
    expect(routeMiles(ROUTE.geometry)).toBeCloseTo(179.5, 0);
    const half = pointAlongRoute(ROUTE.geometry, 0.5);
    expect(half.lat).toBeCloseTo((KC.lat + DSM.lat) / 2, 2);
  });
  it("projects a point to miles-along and miles-off", () => {
    const p = projectOntoRoute(ROUTE.geometry, pointAlongRoute(ROUTE.geometry, 0.25));
    expect(p.alongMi).toBeCloseTo(routeMiles(ROUTE.geometry) * 0.25, 0);
    expect(p.offRouteMi).toBeLessThan(0.1);
    const off = projectOntoRoute(ROUTE.geometry, { lat: 40.3, lng: -95.5 });
    expect(off.offRouteMi).toBeGreaterThan(40);
  });
});

describe("buildPlan", () => {
  it("plans every geocoded stop from the brief's context, so an intermediate stop is a planned stop; without context, origin and destination only", () => {
    const AMES = { name: "Ames, IA", lat: 42.03, lng: -93.63 };
    const withCtx = brief({ context: {
      driverId: "d1", hazmatClass: null, commodity: null, customerName: null, brokerName: null, notes: null, apptText: null, updateText: null, hos: null,
      stops: [
        { type: "pickup", name: "Kansas City, MO", ...KC, windowStartMs: null, windowEndMs: T0, dwellMin: 60 },
        { type: "intermediate", ...AMES, windowStartMs: null, windowEndMs: null, dwellMin: null },
        { type: "delivery", name: "Des Moines, IA", ...DSM, windowStartMs: null, windowEndMs: null, dwellMin: null },
      ],
    } });
    expect(buildPlan(withCtx, ROUTE, []).plannedStops.map((s) => s.name)).toEqual(["Kansas City, MO", "Ames, IA", "Des Moines, IA"]);
    expect(buildPlan(brief(), ROUTE, []).plannedStops.map((s) => s.name)).toEqual(["Kansas City, MO", "Des Moines, IA"]);
  });

  it("needs no break for a short run on a fresh clock", () => {
    const p = buildPlan(brief(), ROUTE, []);
    expect(p.breakWindow).toBeNull();
    expect(p.hosKnown).toBe(true);
    expect(p.etaAtMs).toBe(T0 + 180 * MIN);
  });

  it("plans NO break when the driver's hours are unknown, and says so", () => {
    // Null is not zero. A fresh clock is a measurement; no clock is an
    // absence, and inventing a break from it — or omitting one silently — is
    // how the agent ends up nagging a driver on his legal 30.
    const p = buildPlan(brief({ minutesSinceBreakAtDepart: null }), ROUTE, []);
    expect(p.hosKnown).toBe(false);
    expect(p.breakWindow).toBeNull();
    expect(p.etaAtMs).toBe(T0 + 180 * MIN);
  });

  it("places the mandatory break where the 8-hour mark falls, and adds 30 to the ETA", () => {
    // 6h10 already driven: the 480-min mark lands 110 min into this run.
    const p = buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, []);
    expect(p.breakWindow?.atDriveMin).toBe(110);
    expect(p.breakWindow?.startMs).toBe(T0 + (110 - 45) * MIN);
    expect(p.breakWindow?.endMs).toBe(T0 + (110 + 45) * MIN);
    expect(p.etaAtMs).toBe(T0 + 210 * MIN);
  });

  it("refuses a route with no length or no drive time, rather than computing on NaN", () => {
    // milesPerMin is distance/driveMin. A zero drive time makes every pace,
    // ETA and "minutes behind" NaN, and NaN compares false against every
    // threshold — the agent would run all night and never notice anything.
    expect(() => buildPlan(brief(), { ...ROUTE, driveMin: 0 }, [])).toThrow(/no length or drive time/);
    expect(() => buildPlan(brief(), { ...ROUTE, distanceMi: 0 }, [])).toThrow(/no length or drive time/);
  });

  it("recommends the nearest registered rest stop within range, or none", () => {
    const at = pointAlongRoute(ROUTE.geometry, 110 / 180);
    const nearStop = { name: "Love's I-35", lat: at.lat + 0.02, lng: at.lng };
    const farStop = { name: "Far away", lat: at.lat + 2, lng: at.lng };
    expect(buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, [farStop, nearStop]).breakWindow?.recommended?.name).toBe("Love's I-35");
    expect(buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, [farStop]).breakWindow?.recommended).toBeNull();
  });
});

describe("plan line and ETA", () => {
  const p = buildPlan(brief({ minutesSinceBreakAtDepart: 370 }), ROUTE, []);

  it("expects 60 miles covered after 60 minutes at 60 mph", () => {
    expect(expectedAlongMi(p, T0 + 60 * MIN)).toBeCloseTo(60, 0);
    expect(expectedAlongMi(p, T0 - 5 * MIN)).toBe(0);
  });

  it("holds the plan line still during the break", () => {
    // Minute 110 to 140 is the break: the truck is not expected to move.
    expect(expectedAlongMi(p, T0 + 125 * MIN)).toBeCloseTo(expectedAlongMi(p, T0 + 110 * MIN), 5);
    expect(expectedAlongMi(p, T0 + 150 * MIN)).toBeCloseTo(120, 0);
  });

  it("holds the plan line for an OBSERVED break, wherever it is taken", () => {
    // The window exists so a driver may take his legal 30 early, at a good
    // spot. Holding the line only at the PLANNED minute charges him for the
    // whole break as "behind plan" — and then messages him about it, at the
    // end of the one stop the law required.
    expect(expectedAlongMi(p, T0 + 95 * MIN, 30)).toBeCloseTo(65, 0);
    expect(expectedAlongMi(p, T0 + 95 * MIN)).toBeCloseTo(95, 0);
    // Behind-plan is measured against the same held line.
    const at65 = pointAlongRoute(ROUTE.geometry, 65 / 180);
    expect(minutesBehindPlan(p, at65, T0 + 95 * MIN, 30)).toBeCloseTo(0, 0);
    expect(minutesBehindPlan(p, at65, T0 + 95 * MIN)).toBeCloseTo(30, 0);
  });

  it("live ETA at the start equals the plan's ETA", () => {
    expect(liveEtaMs(p, KC, T0, false)).toBeCloseTo(p.etaAtMs, -3);
  });

  it("live ETA drops the break once it has been taken", () => {
    const at = pointAlongRoute(ROUTE.geometry, 0.5);
    const before = liveEtaMs(p, at, T0 + 100 * MIN, false);
    const after = liveEtaMs(p, at, T0 + 100 * MIN, true);
    expect(before - after).toBe(30 * MIN);
  });

  it("credits break time already taken — sixteen minutes in, fourteen are owed", () => {
    // Found by the replay: charging a driver the whole thirty while he is
    // sixteen minutes into it pushed the ETA past the deadline mid-break, and
    // the agent messaged him during the stop the plan required.
    const at = pointAlongRoute(ROUTE.geometry, 0.5);
    const full = liveEtaMs(p, at, T0 + 100 * MIN, false);
    const partial = liveEtaMs(p, at, T0 + 100 * MIN, false, 16);
    expect(full - partial).toBe(16 * MIN);
    // Over-crediting can never make the ETA earlier than the drive itself.
    expect(liveEtaMs(p, at, T0 + 100 * MIN, false, 45)).toBe(liveEtaMs(p, at, T0 + 100 * MIN, true));
  });

  it("reports minutes behind the plan line", () => {
    const at40 = pointAlongRoute(ROUTE.geometry, 40 / 180);
    expect(minutesBehindPlan(p, at40, T0 + 60 * MIN)).toBeCloseTo(20, 0);
    expect(minutesBehindPlan(p, pointAlongRoute(ROUTE.geometry, 70 / 180), T0 + 60 * MIN)).toBeCloseTo(-10, 0);
    expect(planLinePoint(p, T0 + 60 * MIN).lat).toBeCloseTo(at40.lat + (DSM.lat - KC.lat) * (20 / 180), 1);
  });
});
