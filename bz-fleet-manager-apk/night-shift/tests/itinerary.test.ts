import { describe, expect, it } from "vitest";
import { ASSUMED_DWELL_MIN, buildItinerary, DRIVE_LIMIT_MIN, FUEL_RANGE_MI, remainingItinerary, REST_DURATION_MIN } from "../src/core/itinerary.js";
import type { Brief, BriefContext, LngLat, RouteAnswer } from "../src/core/types.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 6, 11, 0);

/** A straight 180-mi / 180-min route (60 mph) — every mile is a minute. */
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 };
const midpoint = { name: "Bethany, MO", lat: (KC.lat + DSM.lat) / 2, lng: (KC.lng + DSM.lng) / 2 };

const ctx = (over: Partial<BriefContext> = {}): BriefContext => ({
  driverId: "d1", hazmatClass: null, commodity: null, customerName: null, brokerName: null, notes: null, apptText: null, updateText: null, hos: null,
  stops: [
    { type: "pickup", name: "Kansas City, MO", ...KC, windowStartMs: null, windowEndMs: T0, dwellMin: 60 },
    { type: "delivery", name: "Des Moines, IA", ...DSM, windowStartMs: null, windowEndMs: T0 + 6 * 60 * MIN, dwellMin: 30 },
  ],
  ...over,
});
const brief = (over: Partial<Brief> = {}): Brief => ({
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: T0 + 6 * 60 * MIN, driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
  context: ctx(),
  ...over,
});

describe("buildItinerary", () => {
  it("lays out pickup dwell, the drive, and the delivery with its planned arrival and slack", () => {
    const it = buildItinerary(brief(), ROUTE, []);
    expect(it.legs.map((l) => l.kind)).toEqual(["stop", "drive", "stop"]);
    // Arrive PU at T0, dwell 60, drive 180 -> at DEL T0+240; deadline T0+360 -> 120 slack.
    expect(it.etaAtMs).toBe(T0 + 240 * MIN);
    expect(it.slackMin).toBe(120);
    expect(it.breaks).toBe(0);
    expect(it.hasAssumptions).toBe(false);
    expect(it.legs[2].late).toBe(false);
  });

  it("a stop with no dwell on file gets the assumed dwell and says so", () => {
    const it = buildItinerary(brief({ context: ctx({ stops: ctx().stops.map((s) => ({ ...s, dwellMin: null })) }) }), ROUTE, []);
    expect(it.legs[0].assumed).toBe(true);
    expect(it.legs[0].endMs - it.legs[0].startMs).toBe(ASSUMED_DWELL_MIN * MIN);
    expect(it.hasAssumptions).toBe(true);
  });

  it("an intermediate stop is a leg of its own, and arriving before its window opens is a wait", () => {
    const stops = [ctx().stops[0], { type: "intermediate" as const, ...midpoint, windowStartMs: T0 + 200 * MIN, windowEndMs: T0 + 240 * MIN, dwellMin: 15 }, ctx().stops[1]];
    const it = buildItinerary(brief({ context: ctx({ stops }) }), ROUTE, []);
    expect(it.legs.map((l) => l.kind)).toEqual(["stop", "drive", "wait", "stop", "drive", "stop"]);
    // PU dwell to T0+60, 90 min drive -> T0+150, window opens T0+200 -> wait 50.
    // A mid-route point projects to within a few seconds of its planned minute.
    expect(it.legs[2].startMs).toBeCloseTo(T0 + 150 * MIN, -4);
    expect(it.legs[2].endMs).toBe(T0 + 200 * MIN);
    expect(it.legs[3].startMs).toBe(T0 + 200 * MIN);
  });

  it("a planned arrival after the window closes is flagged late, and slack goes negative", () => {
    const stops = [ctx().stops[0], { ...ctx().stops[1], windowEndMs: T0 + 200 * MIN }];
    const it = buildItinerary(brief({ context: ctx({ stops }), deadlineAtMs: T0 + 200 * MIN }), ROUTE, []);
    expect(it.legs[2].late).toBe(true);
    expect(it.slackMin).toBe(-40);
  });

  it("inserts a 30-minute break where the 8-hour rule falls, at the nearest registered rest stop", () => {
    // 420 minutes already on the clock: the break falls 60 min (= 60 mi) in.
    const stop = { name: "Love's Cameron", lat: KC.lat + (DSM.lat - KC.lat) / 3, lng: KC.lng + (DSM.lng - KC.lng) / 3 };
    const it = buildItinerary(brief({ minutesSinceBreakAtDepart: 420 }), ROUTE, [stop]);
    expect(it.legs.map((l) => l.kind)).toEqual(["stop", "drive", "break", "drive", "stop"]);
    expect(it.legs[2].alongMi).toBeCloseTo(60, 0);
    expect(it.legs[2].recommended?.name).toBe("Love's Cameron");
    expect(it.breaks).toBe(1);
    expect(it.etaAtMs).toBe(T0 + 270 * MIN); // 60 dwell + 180 drive + 30 break
  });

  it("plans no break at all when the driver's hours are unknown — never invents a clock", () => {
    const it = buildItinerary(brief({ minutesSinceBreakAtDepart: null }), ROUTE, []);
    expect(it.breaks).toBe(0);
    expect(it.hos).toBeNull();
  });

  it("with the full HOS clock, a run that outlasts the 11h drive limit gets a 10-hour rest and an infeasible verdict", () => {
    const long: RouteAnswer = { geometry: dense(400), distanceMi: 800, driveMin: 800 };
    const hos = { driveRemainingMin: 300, windowRemainingMin: 840, cycleRemainingMin: 3000, minutesSinceBreak: 0 };
    const stops = [ctx().stops[0], { ...ctx().stops[1], windowEndMs: T0 + 3000 * MIN }];
    const it = buildItinerary(brief({ context: ctx({ hos, stops }), deadlineAtMs: T0 + 3000 * MIN }), long, []);
    const rest = it.legs.find((l) => l.kind === "rest");
    expect(rest).toBeDefined();
    expect(rest!.alongMi).toBeCloseTo(300, 0);
    expect(rest!.endMs - rest!.startMs).toBe(REST_DURATION_MIN * MIN);
    expect(it.rests).toBe(1);
    expect(it.hos).toEqual({ feasible: false, reason: expect.stringContaining("10-hour rest") });
    expect(DRIVE_LIMIT_MIN).toBe(660);
  });

  it("a run inside every clock is feasible", () => {
    const hos = { driveRemainingMin: 600, windowRemainingMin: 800, cycleRemainingMin: 3000, minutesSinceBreak: 0 };
    const it = buildItinerary(brief({ context: ctx({ hos }) }), ROUTE, []);
    expect(it.hos).toEqual({ feasible: true, reason: null });
  });

  it("a run that fits the drive clock but not the 14h window says which", () => {
    const hos = { driveRemainingMin: 600, windowRemainingMin: 200, cycleRemainingMin: 3000, minutesSinceBreak: 0 };
    const it = buildItinerary(brief({ context: ctx({ hos }) }), ROUTE, []);
    expect(it.hos?.feasible).toBe(false);
    expect(it.hos?.reason).toContain("14h window");
  });

  it("a fuel stop is planned past the assumed range, and marked as an assumption", () => {
    const long: RouteAnswer = { geometry: dense(500), distanceMi: 1000, driveMin: 1000 };
    const stops = [ctx().stops[0], { ...ctx().stops[1], windowEndMs: T0 + 3000 * MIN }];
    const it = buildItinerary(brief({ minutesSinceBreakAtDepart: null, context: ctx({ stops }), deadlineAtMs: T0 + 3000 * MIN }), long, []);
    const fuel = it.legs.find((l) => l.kind === "fuel");
    expect(fuel?.alongMi).toBeCloseTo(FUEL_RANGE_MI, 0);
    expect(fuel?.assumed).toBe(true);
    expect(it.hasAssumptions).toBe(true);
  });

  it("without context it plans origin -> destination exactly like the old plan, plus the assumed dwells", () => {
    const it = buildItinerary(brief({ context: undefined }), ROUTE, []);
    expect(it.legs.map((l) => l.kind)).toEqual(["stop", "drive", "stop"]);
    expect(it.legs[0].at.name).toBe("Kansas City, MO");
  });

  it("refuses a route with no length", () => {
    expect(() => buildItinerary(brief(), { geometry: dense(2), distanceMi: 0, driveMin: 0 }, [])).toThrow(/no length/);
  });
});

describe("remainingItinerary", () => {
  it("drops what is behind the truck, keeps the rest of the current drive, and re-times everything from now", () => {
    const it = buildItinerary(brief(), ROUTE, []);
    // 60 mi along (a third of the way), and 30 min behind the plan.
    const at = { lat: KC.lat + (DSM.lat - KC.lat) / 3, lng: KC.lng + (DSM.lng - KC.lng) / 3 };
    const now = T0 + 150 * MIN; // plan had him here at T0+120
    const rest = remainingItinerary(it, ROUTE, at, now, false);
    expect(rest.legs.map((l) => l.kind)).toEqual(["drive", "stop"]);
    expect(rest.legs[0].endMs - rest.legs[0].startMs).toBeCloseTo(120 * MIN, -4);
    expect(rest.etaAtMs).toBeCloseTo(now + 120 * MIN, -4);
    expect(rest.slackMin).toBeCloseTo(90, 0);
  });

  it("an observed break is not planned again", () => {
    const it = buildItinerary(brief({ minutesSinceBreakAtDepart: 420 }), ROUTE, []);
    const at = { lat: KC.lat + (DSM.lat - KC.lat) / 6, lng: KC.lng + (DSM.lng - KC.lng) / 6 }; // 30 mi in, before the break point
    const withBreak = remainingItinerary(it, ROUTE, at, T0 + 90 * MIN, false);
    const taken = remainingItinerary(it, ROUTE, at, T0 + 90 * MIN, true);
    expect(withBreak.legs.some((l) => l.kind === "break")).toBe(true);
    expect(taken.legs.some((l) => l.kind === "break")).toBe(false);
    expect(withBreak.etaAtMs - taken.etaAtMs).toBe(30 * MIN);
  });

  it("past the last stop there is nothing left", () => {
    const it = buildItinerary(brief(), ROUTE, []);
    const rest = remainingItinerary(it, ROUTE, DSM, T0 + 300 * MIN, false);
    expect(rest.legs).toEqual([]);
  });
});
