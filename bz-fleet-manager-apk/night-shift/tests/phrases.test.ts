import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/core/plan.js";
import { escalationBody, questionFor } from "../src/core/phrases.js";
import type { PhraseContext } from "../src/core/phrases.js";
import type { AgentEvent, Anomaly, Brief, LngLat, RouteAnswer } from "../src/core/types.js";

// Kansas City -> Des Moines, same fixture shape as plan.test.ts.
const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const dense = (n: number): LngLat[] =>
  Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 };

const T0 = Date.UTC(2026, 8, 6, 11, 10);
const brief: Brief = {
  loadRef: "W-19",
  origin: { name: "Kansas City, MO", ...KC },
  destination: { name: "Des Moines, IA", ...DSM },
  equipment: "DryVan",
  departAtMs: T0,
  deadlineAtMs: T0 + 245 * 60_000,
  driverName: "Jake",
  driverPhone: "+15550001",
  customerEmail: null,
  minutesSinceBreakAtDepart: 0,
};
const plan = buildPlan(brief, ROUTE, []);
const ctx: PhraseContext = { brief, plan, landmarks: [], tz: "America/Chicago" };

const delayAnomaly = (behindMin: number, behindPlan: boolean, fixAgeMin = 0, asOfMs = T0): Anomaly => ({
  kind: "delay",
  key: "delay",
  atMs: T0,
  evidence: { behindMin, behindPlan, fixAgeMin, asOfMs },
});

describe("questionFor delay", () => {
  it("never states a negative number of minutes behind, and says the delivery is at risk instead", () => {
    const text = questionFor(delayAnomaly(-4, false), ctx);
    expect(text).toMatch(/on pace/);
    expect(text).toContain("Des Moines, IA");
    expect(text).not.toMatch(/-\d/);
    expect(text).not.toMatch(/\d+ minutes behind/);
  });

  it("also treats a merely-past-deadline, not-actually-behind-pace anomaly as on pace", () => {
    // pastDeadline can be true while behindMin is still positive but small —
    // the honesty rule keys off behindPlan, not just the sign of behindMin.
    const text = questionFor(delayAnomaly(3, false), ctx);
    expect(text).toMatch(/on pace/);
    expect(text).not.toMatch(/\d+ minutes behind/);
  });

  it("keeps the plain sentence, with a positive whole number, when actually behind pace", () => {
    const text = questionFor(delayAnomaly(12, true), ctx);
    expect(text).toContain("12 minutes behind");
    expect(text).not.toMatch(/on pace/);
  });
});

describe("escalationBody's delay log line", () => {
  const anomalyEvent = (behindMin: number, behindPlan?: boolean): AgentEvent => ({
    atMs: T0,
    kind: "anomaly",
    evidence: { kind: "delay", behindMin, behindPlan, resolved: false },
  });

  it("never prints a negative '... min behind', writing the honest risk wording instead", () => {
    const body = escalationBody(brief, "delay", [anomalyEvent(-4)], null, false, "America/Chicago", true);
    expect(body).not.toMatch(/-\d+ min behind/);
    expect(body).toContain("at risk of missing its window");
  });

  it("still prints the positive minute count when genuinely behind", () => {
    const body = escalationBody(brief, "delay", [anomalyEvent(12, true)], null, false, "America/Chicago", true);
    expect(body).toContain("(12 min behind)");
    expect(body).not.toContain("at risk of missing its window");
  });

  // Same fixture as questionFor's "merely-past-deadline" test above: a
  // positive-but-small behindMin with behindPlan false. The dispatcher's
  // escalation email must not tell a different story than the driver heard —
  // it may not say "(3 min behind)" when the driver was told "on pace".
  it("prints the same 'at risk' wording as the driver's question when behindPlan is false, even with a positive behindMin", () => {
    const body = escalationBody(brief, "delay", [anomalyEvent(3, false)], null, false, "America/Chicago", true);
    expect(body).not.toMatch(/\d+ min behind/);
    expect(body).toContain("at risk of missing its window");
  });
});
