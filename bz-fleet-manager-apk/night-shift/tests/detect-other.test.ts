import { describe, expect, it } from "vitest";
import { detectAnomalies, detectDelay, detectGoneDark, detectOffRoute } from "../src/core/detect.js";
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
  minutesSinceBreakAtDepart: 370,
};
const at = (frac: number) => pointAlongRoute(ROUTE.geometry, frac);
const restStop = { name: "Love's I-35", ...at(110 / 180) };
const plan = buildPlan(brief, ROUTE, [restStop]); // plan ETA 09:40 (min 210); deadline 10:15 (min 245)
const t = (min: number) => T0 + min * MIN;

describe("detectDelay", () => {
  it("fires when the live ETA passes the deadline, and says by how much it is behind", () => {
    // Minute 150, break taken, only 80 mi covered: 100 mi to go = ETA min 250.
    const a = detectDelay(plan, STANDARD, at(80 / 180), t(150), t(150), true);
    expect(a?.kind).toBe("delay");
    expect(a?.key).toBe("delay");
    expect(a?.evidence.pastDeadline).toBe(true);
    expect(a?.evidence.behindMin).toBeCloseTo(40, 0);
  });

  it("fires on 30+ minutes behind the plan line even with the deadline still safe", () => {
    // Minute 60 at mile 28: 32 behind, but ETA = 60 + 152 + 30 = min 242, still
    // inside the 245 deadline. (Mile 25 would land 0.1 min PAST it on the real
    // great-circle length — a fixture inside its own ambiguity.)
    const a = detectDelay(plan, STANDARD, at(28 / 180), t(60), t(60), false);
    expect(a?.evidence.behindPlan).toBe(true);
    expect(a?.evidence.pastDeadline).toBe(false);
  });

  it("is quiet when merely a little behind", () => {
    // Minute 150 at mile 100: 20 behind, ETA min 230.
    expect(detectDelay(plan, STANDARD, at(100 / 180), t(150), t(150), true)).toBeNull();
  });

  it("does not call a driver late for the minutes of a break he is in the middle of", () => {
    // Deadline tight enough that the full thirty tips the ETA past it.
    const tight = buildPlan({ ...brief, deadlineAtMs: t(220) }, ROUTE, [restStop]);
    // Sixteen minutes into the mandatory break, at the recommended stop.
    // Uncredited, the whole thirty is still charged and this would fire.
    expect(detectDelay(tight, STANDARD, restStop, t(126), t(126), false, 16)).toBeNull();
  });
});

describe("detectGoneDark", () => {
  const rolling: Ping[] = [{ atMs: t(100), ...at(100 / 180) }];
  it("fires after 20 minutes without a ping on the road", () => {
    expect(detectGoneDark(plan, STANDARD, rolling, [restStop], t(115))).toBeNull();
    const a = detectGoneDark(plan, STANDARD, rolling, [restStop], t(121));
    expect(a?.kind).toBe("gone_dark");
    expect(a?.evidence.gapMin).toBeCloseTo(21, 0);
    expect(a?.evidence.limitMin).toBe(20);
  });

  it("gives a phone at a known stop an hour — GPS dies indoors", () => {
    const parkedAtRest: Ping[] = [{ atMs: t(110), ...restStop }];
    expect(detectGoneDark(plan, STANDARD, parkedAtRest, [restStop], t(160))).toBeNull();
    const a = detectGoneDark(plan, STANDARD, parkedAtRest, [restStop], t(171));
    expect(a?.evidence.atStop).toBe(true);
    expect(a?.evidence.limitMin).toBe(60);
  });
});

describe("detectOffRoute", () => {
  const east = (frac: number, mi: number) => ({ lat: at(frac).lat, lng: at(frac).lng + mi / 54 }); // ~54 mi per degree lng here
  const off = (fromMin: number, n: number): Ping[] =>
    Array.from({ length: n }, (_, i) => ({ atMs: t(fromMin + i), ...east((fromMin + i) / 180, 5) }));

  it("fires after 10 minutes continuously more than 3.1 mi off the line", () => {
    const a = detectOffRoute(plan, STANDARD, off(60, 11), t(70));
    expect(a?.kind).toBe("off_route");
    expect(a?.evidence.minOffRouteMi).toBeGreaterThan(3.1);
  });

  it("is quiet for a shorter excursion", () => {
    expect(detectOffRoute(plan, STANDARD, off(60, 6), t(65))).toBeNull();
  });

  it("is quiet once any recent ping is back on the route", () => {
    const pings = [...off(60, 10), { atMs: t(70), ...at(70 / 180) }];
    expect(detectOffRoute(plan, STANDARD, pings, t(70))).toBeNull();
  });

  it("keeps ONE key for the whole excursion, so the ladder is never restarted", () => {
    // Evaluated every minute across a 30-minute excursion, the key must stay
    // anchored to the first off-route ping. A key taken from a trailing
    // window slides a minute per tick, and the agent's per-key ladder would
    // start over from rung 1 on every evaluation.
    const pings = off(60, 31);
    const keys = new Set<string>();
    for (let m = 70; m <= 90; m += 1) {
      const a = detectOffRoute(plan, STANDARD, pings.filter((p) => p.atMs <= t(m)), t(m));
      if (a) keys.add(a.key);
    }
    expect(keys).toEqual(new Set(["off_route@" + t(60)]));
  });
});

describe("detectAnomalies", () => {
  it("returns every rule that fires, stop first", () => {
    // Parked 20 min at mile 62 at minute 150, which is also 40+ behind plan.
    const parked: Ping[] = Array.from({ length: 21 }, (_, i) => ({ atMs: t(130 + i), ...at(62 / 180) }));
    const kinds = detectAnomalies(plan, STANDARD, parked, [restStop], t(150), true).map((a) => a.kind);
    expect(kinds[0]).toBe("unplanned_stop");
    expect(kinds).toContain("delay");
    expect(kinds).not.toContain("gone_dark");
  });
});
