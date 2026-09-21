import { evaluate, snap15 } from "../src/domain/dispatch/evaluate.js";
import type {
  DriverInput,
  EvalContext,
  LoadInput,
  TractorInput,
  TrailerInput,
} from "../src/domain/dispatch/types.js";

const M = 60_000;
const H = 3_600_000;

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };

const baseLoad = (over: Partial<LoadInput> = {}): LoadInput => ({
  requiredEquip: "Reefer",
  hazmatClass: null,
  stops: [
    { sequence: 1, type: "pickup", location: KC, windowStart: null, windowEnd: 100 * H, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: OMAHA, windowStart: null, windowEnd: 100 * H, dwellMin: 60 },
  ],
  revenueCents: 34000,
  ...over,
});

const fresh = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

const baseDriver = (over: Partial<DriverInput> = {}): DriverInput => ({
  status: "active",
  hazmatEndorsed: false,
  availableAt: 0,
  location: KC, // parked at the pickup -> ~0 deadhead
  hos: fresh,
  ...over,
});

const tractor: TractorInput = { status: "active" };
const trailer: TrailerInput = { type: "Reefer", status: "active" };

it("a clean match is feasible with no conflicts and a sensible plan", () => {
  const r = evaluate(baseLoad(), baseDriver(), tractor, trailer);
  expect(r.feasible).toBe(true);
  expect(r.conflicts).toHaveLength(0);
  expect(r.plan.deadheadMi).toBeCloseTo(0, 3);
  expect(r.plan.loadedMi).toBeGreaterThan(180); // ~166mi great-circle * 1.2
  expect(r.plan.driveMin).toBeGreaterThan(220);
  expect(r.plan.needsBreak).toBe(false);
  expect(r.plan.proposedStart).toBe(0);
});

it("blocks on wrong equipment", () => {
  const r = evaluate(baseLoad(), baseDriver(), tractor, { type: "DryVan", status: "active" });
  expect(r.feasible).toBe(false);
  expect(r.conflicts.map((c) => c.kind)).toContain("equipment");
});

it("blocks a hazmat load for an unendorsed driver but clears an endorsed one", () => {
  const haz = baseLoad({ hazmatClass: "8" });
  expect(evaluate(haz, baseDriver({ hazmatEndorsed: false }), tractor, trailer).feasible).toBe(false);
  expect(evaluate(haz, baseDriver({ hazmatEndorsed: true }), tractor, trailer).feasible).toBe(true);
});

it("blocks when the driver lacks the driving hours", () => {
  const driver = baseDriver({ hos: { ...fresh, driveRemainingMin: 120 } });
  const r = evaluate(baseLoad(), driver, tractor, trailer);
  expect(r.feasible).toBe(false);
  expect(r.conflicts.map((c) => c.kind)).toContain("hos");
});

it("blocks when the load cannot reach its delivery appointment in time", () => {
  const load = baseLoad({
    stops: [
      { sequence: 1, type: "pickup", location: KC, windowEnd: 100 * H, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: OMAHA, windowEnd: 200 * M, dwellMin: 60 }, // arrives ~299m
    ],
  });
  const r = evaluate(load, baseDriver(), tractor, trailer);
  expect(r.feasible).toBe(false);
  expect(r.conflicts.map((c) => c.kind)).toContain("late_delivery");
});

it("warns (does not block) on a tight-but-makeable delivery", () => {
  const load = baseLoad({
    stops: [
      { sequence: 1, type: "pickup", location: KC, windowEnd: 100 * H, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: OMAHA, windowEnd: 310 * M, dwellMin: 60 }, // arrives ~299m, ~11m slack
    ],
  });
  const r = evaluate(load, baseDriver(), tractor, trailer);
  expect(r.feasible).toBe(true);
  const late = r.conflicts.find((c) => c.kind === "late_delivery");
  expect(late?.severity).toBe("warn");
});

it("blocks when the driver already has an overlapping commitment", () => {
  const ctx: EvalContext = { driverBusy: [{ start: 0, end: 400 * M }] };
  const r = evaluate(baseLoad(), baseDriver(), tractor, trailer, ctx);
  expect(r.feasible).toBe(false);
  expect(r.conflicts.map((c) => c.kind)).toContain("overlap");
});

it("accumulates multiple blocking conflicts at once", () => {
  const driver = baseDriver({ status: "off_duty", hos: { ...fresh, driveRemainingMin: 10 } });
  const r = evaluate(baseLoad({ hazmatClass: "3" }), driver, { status: "in_shop" }, { type: "DryVan", status: "active" });
  const kinds = r.conflicts.map((c) => c.kind);
  expect(kinds).toEqual(expect.arrayContaining(["equipment", "hazmat", "driver_unavail", "tractor_unavail", "hos"]));
  expect(r.feasible).toBe(false);
});

it("rejects a structurally invalid load", () => {
  const r = evaluate(
    baseLoad({ stops: [{ sequence: 1, type: "pickup", location: KC, dwellMin: 60 }] }),
    baseDriver(),
    tractor,
    trailer,
  );
  expect(r.feasible).toBe(false);
  expect(r.conflicts[0].kind).toBe("invalid_load");
});

it("delays the start so the driver doesn't arrive before the pickup window opens", () => {
  const load = baseLoad({
    stops: [
      { sequence: 1, type: "pickup", location: OMAHA, windowStart: 10 * H, windowEnd: 100 * H, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: KC, windowEnd: 100 * H, dwellMin: 60 },
    ],
  });
  // driver parked at the pickup -> ~0 deadhead -> start should snap to the window open (10h)
  const r = evaluate(load, baseDriver({ location: OMAHA }), tractor, trailer);
  expect(r.plan.proposedStart).toBe(10 * H);
});

it("snap15 rounds to the nearest quarter hour", () => {
  expect(snap15(7 * M)).toBe(0);
  expect(snap15(8 * M)).toBe(15 * M);
  expect(snap15(22 * M)).toBe(15 * M);
  expect(snap15(23 * M)).toBe(30 * M);
});

// A point appointment — the shape every board-typed "PU: 09/13 - 08:00"
// produces (windowStart === windowEnd). Found live: with the departure
// snapped UP to the 15-minute grid, a driver fifteen miles out arrived
// "4m late" for an instant nothing could land on, and no board load could
// ever be assigned. Arriving a few minutes early is what a driver does.
describe("a point appointment (windowStart === windowEnd)", () => {
  // ~15 road miles from KC at 50 mph ≈ 18 min deadhead; an appointment at
  // 10:07 puts the raw departure at ~9:49, which ceil-snaps to 10:00 and
  // arrives ~10:18 — eleven minutes past the instant.
  const NEAR = { lat: 39.0997, lng: -94.30 };
  const appt = 10 * H + 7 * M;
  const pointLoad = baseLoad({
    stops: [
      { sequence: 1, type: "pickup", location: KC, windowStart: appt, windowEnd: appt, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: OMAHA, windowStart: null, windowEnd: 100 * H, dwellMin: 60 },
    ],
  });

  it("is feasible for a driver who could have made it without the snap", () => {
    const r = evaluate(pointLoad, baseDriver({ location: NEAR }), tractor, trailer);
    expect(r.conflicts.filter((c) => c.severity === "block")).toEqual([]);
    expect(r.feasible).toBe(true);
    // The plan backed off one grid step rather than departing late.
    expect(r.plan.proposedStart % (15 * M)).toBe(0);
    expect(r.plan.proposedStart).toBeLessThan(appt);
  });

  it("still blocks a driver who genuinely cannot arrive by the instant", () => {
    // Available only 5 minutes before the appointment, 18 minutes away.
    const r = evaluate(pointLoad, baseDriver({ location: NEAR, availableAt: appt - 5 * M }), tractor, trailer);
    expect(r.feasible).toBe(false);
    expect(r.conflicts.some((c) => c.detail.includes("late deadline"))).toBe(true);
  });

  it("leaves a real range window exactly as before", () => {
    const ranged = baseLoad({
      stops: [
        { sequence: 1, type: "pickup", location: KC, windowStart: 10 * H, windowEnd: 12 * H, dwellMin: 60 },
        { sequence: 2, type: "delivery", location: OMAHA, windowStart: null, windowEnd: 100 * H, dwellMin: 60 },
      ],
    });
    const r = evaluate(ranged, baseDriver({ location: NEAR }), tractor, trailer);
    expect(r.feasible).toBe(true);
    // Ceil-snapped as always: departs on or after the window-floor, never before.
    expect(r.plan.proposedStart).toBeGreaterThanOrEqual(10 * H - 20 * M);
  });
});

// A deadhead long enough to need the 30-minute break. Found live: the walk
// inserts the break, but the departure was planned from bare driving
// minutes, so every driver more than ~480 road miles out arrived at the
// pickup exactly one break late — "arrives stop 1 after its 22m-late
// deadline" for four of six drivers on the same load.
describe("a deadhead that crosses the 8-hour break threshold", () => {
  // ~560 road miles from the pickup at 50 mph ≈ 672 min of driving.
  const FAR = { lat: 39.0997, lng: -103.5 };
  const appt = 30 * H;
  const load = baseLoad({
    stops: [
      { sequence: 1, type: "pickup", location: KC, windowStart: appt, windowEnd: appt + 2 * H, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: OMAHA, windowStart: null, windowEnd: 100 * H, dwellMin: 60 },
    ],
  });

  it("plans the departure early enough to absorb the break and still arrive in the window", () => {
    const r = evaluate(load, baseDriver({ location: FAR }), tractor, trailer);
    const late = r.conflicts.filter((c) => c.detail.includes("late deadline"));
    expect(late).toEqual([]);
    expect(r.plan.needsBreak).toBe(true);
    // Departed at least one break-length before the bare-driving departure would have.
    const bareDeparture = appt - r.plan.deadheadMi / 50 * H * 1; // ≈ driving only
    expect(r.plan.proposedStart).toBeLessThanOrEqual(bareDeparture);
  });
});
