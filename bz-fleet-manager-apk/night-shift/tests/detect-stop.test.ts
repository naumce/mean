import { describe, expect, it } from "vitest";
import { detectUnplannedStop } from "../src/core/detect.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { buildPlan } from "../src/core/plan.js";
import { STANDARD } from "../src/core/policy.js";
import type { Brief, LngLat, Ping, RouteAnswer } from "../src/core/types.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 };
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const MIN = 60_000;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "KC", ...KC }, destination: { name: "DSM", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: T0 + 245 * MIN, driverName: "Jake", driverPhone: "+1", customerEmail: null,
  minutesSinceBreakAtDepart: 370, // break due at drive-minute 110; window 65..155
};
const at = (frac: number) => pointAlongRoute(ROUTE.geometry, frac);

/** `n` pings a minute apart, all at the same spot, starting at `fromMin`. */
const parked = (spot: { lat: number; lng: number }, fromMin: number, n: number): Ping[] =>
  Array.from({ length: n }, (_, i) => ({ atMs: T0 + (fromMin + i) * MIN, ...spot }));

describe("detectUnplannedStop", () => {
  const restStop = { name: "Love's I-35", ...at(110 / 180) };
  const plan = buildPlan(brief, ROUTE, [restStop]);

  it("raises a 20-minute stop away from any planned stop, with the evidence", () => {
    // Bethany, MO: 62 min in, 20 minutes stationary, nowhere on the plan.
    const pings = parked(at(62 / 180), 62, 21);
    const a = detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 82 * MIN);
    expect(a?.kind).toBe("unplanned_stop");
    expect(a?.evidence.observedMin).toBe(20);
    expect(a?.evidence.thresholdMin).toBe(15);
    expect(a?.key).toBe("unplanned_stop@" + (T0 + 62 * MIN));
  });

  it("stays quiet under the threshold", () => {
    const pings = parked(at(62 / 180), 62, 11); // 10 minutes
    expect(detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 72 * MIN)).toBeNull();
  });

  it("stays quiet at a planned stop — the destination is not an incident", () => {
    const pings = parked(DSM, 200, 40);
    expect(detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 239 * MIN)).toBeNull();
  });

  it("THE rule: the mandatory break at the recommended rest stop is compliance, not an anomaly", () => {
    // Minute 110 to 140 at the Love's. Inside the window, at a registered
    // stop. Pinging him for this is how the link gets deleted.
    const pings = parked(restStop, 110, 31);
    expect(detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 140 * MIN)).toBeNull();
  });

  it("a stop at a registered fuel/rest stop outside the window is not an anomaly either", () => {
    // Fueling at minute 30 is legitimate. If it costs the deadline, the
    // delay rule says so; the stop rule does not nag.
    const pings = parked(restStop, 30, 25);
    expect(detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 54 * MIN)).toBeNull();
  });

  it("a stop inside the break window but NOT at a registered stop is still raised", () => {
    // Parked on a shoulder at minute 100. In the window, but nowhere the
    // registry knows — the agent may ask.
    const shoulder = { lat: at(100 / 180).lat, lng: at(100 / 180).lng + 0.05 };
    const pings = parked(shoulder, 100, 21);
    const a = detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 120 * MIN);
    expect(a?.kind).toBe("unplanned_stop");
    expect(a?.evidence.inBreakWindow).toBe(true);
  });

  it("does not raise a stop the truck has already left", () => {
    // Twenty minutes parked, then rolling again: the latest ping is not in
    // the fence, so there is no OPEN stop to ask about.
    const pings = [...parked(at(62 / 180), 62, 21), { atMs: T0 + 83 * MIN, ...at(64 / 180) }];
    expect(detectUnplannedStop(plan, STANDARD, pings, [restStop], T0 + 83 * MIN)).toBeNull();
  });

  it("returning to a spot it already left starts a NEW stop — the old one is not re-raised", () => {
    // Parked 20 min at A, drove off for 14 min, came back to A. dwellSegments
    // now holds TWO segments for A: the closed 20-minute one and the open one
    // that just began. Only the open one may be judged. A rule that took the
    // first segment it found would raise a 20-minute stop the moment the
    // truck reappeared — and it would carry the OLD stop's key.
    const A = at(62 / 180);
    const away = Array.from({ length: 14 }, (_, i) => ({ atMs: T0 + (82 + i) * MIN, ...at((64 + i) / 180) }));
    const back4 = [...parked(A, 62, 20), ...away, ...parked(A, 96, 5)];
    expect(detectUnplannedStop(plan, STANDARD, back4, [restStop], T0 + 100 * MIN)).toBeNull();
    // Fifteen minutes into the SECOND visit it is a stop again — keyed to it.
    const back15 = [...parked(A, 62, 20), ...away, ...parked(A, 96, 16)];
    const a = detectUnplannedStop(plan, STANDARD, back15, [restStop], T0 + 111 * MIN);
    expect(a?.key).toBe("unplanned_stop@" + (T0 + 96 * MIN));
    expect(a?.evidence.observedMin).toBe(15);
  });
});
