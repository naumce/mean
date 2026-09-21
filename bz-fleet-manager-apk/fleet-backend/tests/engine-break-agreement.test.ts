import { describe, expect, it } from "vitest";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import { breaksRequired, evaluateHos } from "../src/domain/dispatch/hos.js";
import type { DriverInput, LoadInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

const KC = { lat: 39.0997, lng: -94.5786 };
const COLUMBIA = { lat: 38.9517, lng: -92.3341 };
const MEMPHIS = { lat: 35.1495, lng: -90.049 };
const CHICAGO = { lat: 41.878, lng: -87.6298 };
const T0 = Date.UTC(2026, 8, 1, 6, 0, 0);

const tractor: TractorInput = { status: "active" };
const trailer: TrailerInput = { type: "DryVan", status: "active" };

const loadTo = (dest: { lat: number; lng: number }): LoadInput => ({
  requiredEquip: "DryVan",
  stops: [
    { sequence: 1, type: "pickup", location: KC, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: dest, dwellMin: 60 },
  ],
});

// Deliberately huge clocks: this file tests break COUNTING, not legality, and
// an HOS block would stop the fixtures short of the interesting cases.
const driverAt = (p: { lat: number; lng: number }, since: number): DriverInput => ({
  status: "active",
  hazmatEndorsed: false,
  availableAt: T0,
  location: p,
  hos: {
    driveRemainingMin: 5000,
    windowRemainingMin: 5000,
    cycleRemainingMin: 9000,
    minutesSinceBreak: since,
  },
});

describe("breaksRequired is the single definition", () => {
  it("agrees with the timeline walk across a wide sweep", () => {
    for (const origin of [KC, CHICAGO]) {
      for (const dest of [COLUMBIA, MEMPHIS]) {
        for (const since of [0, 1, 100, 305, 306, 307, 420, 479, 480, 481, 600, 900, 1000]) {
          const res = evaluate(loadTo(dest), driverAt(origin, since), tractor, trailer);
          const closed = breaksRequired(since, res.plan.driveMin);
          expect(
            res.plan.breaks.length,
            `origin=${origin.lat} dest=${dest.lat} since=${since} drive=${res.plan.driveMin}`,
          ).toBe(closed);
          expect(res.plan.needsBreak).toBe(res.plan.breaks.length > 0);
        }
      }
    }
  });

  it("onDutyMin accounts for exactly the breaks the plan contains", () => {
    for (const since of [0, 306, 420, 600, 1000]) {
      const res = evaluate(loadTo(MEMPHIS), driverAt(CHICAGO, since), tractor, trailer);
      // dwell is 120 across the two stops and these fixtures have no dock waits
      expect(res.plan.onDutyMin).toBeCloseTo(res.plan.driveMin + 120 + 30 * res.plan.breaks.length, 5);
    }
  });

  it("never emits a break before the trip starts", () => {
    // The since>480 defect: untilBreak went negative and placed a break 120
    // minutes ahead of proposedStart.
    for (const since of [481, 600, 1000]) {
      const res = evaluate(loadTo(COLUMBIA), driverAt(KC, since), tractor, trailer);
      for (const b of res.plan.breaks) {
        expect(b.afterDriveMin).toBeGreaterThanOrEqual(0);
        expect(b.fraction).toBeGreaterThanOrEqual(0);
        expect(b.atMs).toBeGreaterThanOrEqual(res.plan.proposedStart);
      }
    }
  });

  it("no driving needs no break, however overdue the driver is", () => {
    expect(breaksRequired(1000, 0)).toBe(0);
    expect(breaksRequired(0, 0)).toBe(0);
  });

  it("holds the FMCSA boundary: due after MORE than 8h, not at exactly 8h", () => {
    expect(breaksRequired(0, 480)).toBe(0);
    expect(breaksRequired(0, 480.001)).toBe(1);
    expect(breaksRequired(479, 1)).toBe(0);
    expect(breaksRequired(479, 1.001)).toBe(1);
  });

  it("evaluateHos reports the same count it charges for", () => {
    const e = evaluateHos({
      driveMin: 174.105,
      dwellMin: 120,
      hos: {
        driveRemainingMin: 5000,
        windowRemainingMin: 5000,
        cycleRemainingMin: 9000,
        minutesSinceBreak: 306,
      },
    });
    expect(e.needsBreak).toBe(true);
    expect(e.requiredOnDutyMin).toBeCloseTo(174.105 + 120 + 30, 5);
  });
});
