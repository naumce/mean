// Slice 4 (2026-09-19): memory across trips — places, driver, lane — folded
// from past rows, and where it is read: the itinerary's dwell and the
// model's run facts.
import { describe, expect, it } from "vitest";
import { buildItinerary } from "../src/core/itinerary.js";
import { driverMemory, laneMemory, memoryLines, placeMemory, type TripMemory } from "../src/core/memory.js";
import type { Brief, BriefContext, LngLat, RouteAnswer } from "../src/core/types.js";
import { runFacts } from "../src/live/claudeConversation.js";

const MIN = 60_000;
const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };

/** Pings sitting at `at` for `min` minutes, one a minute, then one far away. */
const dwellPings = (at: { lat: number; lng: number }, min: number, t0 = 0) => [
  ...Array.from({ length: min + 1 }, (_, i) => ({ atMs: t0 + i * MIN, lat: at.lat, lng: at.lng })),
  { atMs: t0 + (min + 1) * MIN, lat: at.lat + 1, lng: at.lng + 1 },
];

describe("placeMemory", () => {
  it("takes the longest dwell of each visit and reports the median and max with the visit count", () => {
    const m = placeMemory("Kroger DC 42", [
      { address: "Kroger DC 42", at: KC, pings: dwellPings(KC, 40) },
      { address: "Kroger DC 42", at: KC, pings: dwellPings(KC, 90) },
      { address: "Kroger DC 42", at: KC, pings: dwellPings(KC, 120) },
    ]);
    expect(m).toEqual({ address: "Kroger DC 42", visits: 3, medianDwellMin: 90, maxDwellMin: 120 });
  });

  it("a visit whose pings never sat inside the radius contributes no dwell, but still counts as a visit", () => {
    const m = placeMemory("X", [{ address: "X", at: KC, pings: [{ atMs: 0, lat: 45, lng: -100 }] }]);
    expect(m).toEqual({ address: "X", visits: 1, medianDwellMin: null, maxDwellMin: null });
  });
});

describe("driverMemory", () => {
  it("counts calls placed/answered, texts asked/answered, and keeps the last five situations", () => {
    const m = driverMemory([
      { events: [
        { kind: "action", evidence: { kind: "message" } },
        { kind: "action", evidence: { kind: "sms" } },
        { kind: "call", evidence: { answered: false } },
        { kind: "call", evidence: { answered: true } },
        { kind: "reply", evidence: { channel: "call", situationKey: "customer" } },
      ] },
      { events: [
        { kind: "action", evidence: { kind: "message" } },
        { kind: "reply", evidence: { channel: "chat", situationKey: "traffic" } },
        { kind: "call", evidence: { failed: true } },
      ] },
    ]);
    expect(m).toEqual({ trips: 2, callsPlaced: 2, callsAnswered: 1, textsAsked: 3, textsAnswered: 1, recentSituations: ["customer", "traffic"] });
  });

  it("no past trips is null, not a driver who never answers", () => {
    expect(driverMemory([])).toBeNull();
  });
});

describe("laneMemory", () => {
  it("counts late arrivals against the deadline and ranks anomaly kinds", () => {
    const m = laneMemory("Kansas City", "Omaha", [
      { deadlineMs: 100, completedMs: 90, anomalyKinds: ["unplanned_stop"] },
      { deadlineMs: 100, completedMs: 130, anomalyKinds: ["delay", "unplanned_stop"] },
      { deadlineMs: 100, completedMs: null, anomalyKinds: [] },
    ]);
    expect(m).toEqual({ from: "Kansas City", to: "Omaha", runs: 3, lateArrivals: 1, commonAnomalies: [{ kind: "unplanned_stop", count: 2 }, { kind: "delay", count: 1 }] });
  });
});

const MEMORY: TripMemory = {
  places: { "Kansas City, MO": { address: "Kansas City, MO", visits: 4, medianDwellMin: 95, maxDwellMin: 140 } },
  driver: { trips: 3, callsPlaced: 4, callsAnswered: 3, textsAsked: 5, textsAnswered: 1, recentSituations: ["customer", "traffic"] },
  lane: { from: "Kansas City", to: "Des Moines", runs: 6, lateArrivals: 2, commonAnomalies: [{ kind: "delay", count: 3 }] },
};

describe("memoryLines", () => {
  it("quotes every figure with its count, and says nothing for an empty memory", () => {
    const lines = memoryLines(MEMORY);
    expect(lines).toEqual([
      "Kansas City, MO: median dwell 95 min over 4 past visits (longest 140).",
      "Driver: 3 past runs with this agent, answered 3 of 4 calls, replied to 1 of 5 texts.",
      "Driver's recent situations: customer, traffic.",
      "Lane Kansas City → Des Moines: 6 past runs, 2 late; seen: delay ×3.",
    ]);
    expect(memoryLines({ places: {}, driver: null, lane: null })).toEqual([]);
  });
});

const dense = (n: number): LngLat[] => Array.from({ length: n + 1 }, (_, i) => [KC.lng + ((DSM.lng - KC.lng) * i) / n, KC.lat + ((DSM.lat - KC.lat) * i) / n]);
const ROUTE: RouteAnswer = { geometry: dense(90), distanceMi: 180, driveMin: 180 };
const T0 = Date.UTC(2026, 8, 6, 11, 0);
const ctx = (memory?: TripMemory): BriefContext => ({
  driverId: "d1", hazmatClass: null, commodity: null, customerName: null, brokerName: null, notes: null, apptText: null, updateText: null, hos: null, memory,
  stops: [
    { type: "pickup", name: "Kansas City, MO", ...KC, windowStartMs: null, windowEndMs: T0, dwellMin: null },
    { type: "delivery", name: "Des Moines, IA", ...DSM, windowStartMs: null, windowEndMs: T0 + 400 * MIN, dwellMin: 30 },
  ],
});
const brief = (memory?: TripMemory): Brief => ({
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: T0 + 400 * MIN, driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0, context: ctx(memory),
});

describe("memory in the itinerary and the prompt", () => {
  it("a stop with no dwell on file takes the place's remembered median — still marked assumed, sourced from history", () => {
    const withMemory = buildItinerary(brief(MEMORY), ROUTE, []);
    const without = buildItinerary(brief(), ROUTE, []);
    expect(withMemory.legs[0].endMs - withMemory.legs[0].startMs).toBe(95 * MIN);
    expect(withMemory.legs[0]).toMatchObject({ assumed: true, dwellSource: "history" });
    expect(without.legs[0].endMs - without.legs[0].startMs).toBe(60 * MIN);
    expect(without.legs[0].dwellSource).toBeUndefined();
    // A dwell the dispatcher DID set is never overridden by history.
    expect(withMemory.legs[2].endMs - withMemory.legs[2].startMs).toBe(30 * MIN);
  });

  it("the model's run facts carry the memory lines", () => {
    const facts = runFacts(brief(MEMORY), "America/Chicago");
    expect(facts).toContain("From past runs:");
    expect(facts).toContain("- Driver: 3 past runs with this agent, answered 3 of 4 calls, replied to 1 of 5 texts.");
    expect(runFacts(brief(), "America/Chicago")).not.toContain("From past runs");
  });
});
