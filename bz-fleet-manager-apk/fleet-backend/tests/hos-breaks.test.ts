import { evaluateHos } from "../src/domain/dispatch/hos.js";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import type { DriverInput, LoadInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

// Multi-break honesty: every strict crossing of the 480-min cumulative
// driving boundary costs one 30-min break, and the projected timeline
// carries every one of them.

const fresh = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

describe("evaluateHos break counting", () => {
  it("budgets two breaks when the trip crosses two boundaries", () => {
    const r = evaluateHos({ driveMin: 660, dwellMin: 0, hos: { ...fresh, minutesSinceBreak: 470 } });
    expect(r.needsBreak).toBe(true);
    expect(r.requiredOnDutyMin).toBe(660 + 60); // 2 × 30-min breaks
  });

  it("exactly 480 cumulative minutes needs no break (strict boundary)", () => {
    const r = evaluateHos({ driveMin: 480, dwellMin: 0, hos: fresh });
    expect(r.needsBreak).toBe(false);
    expect(r.requiredOnDutyMin).toBe(480);
  });

  it("one minute past the boundary needs one break", () => {
    const r = evaluateHos({ driveMin: 481, dwellMin: 0, hos: fresh });
    expect(r.needsBreak).toBe(true);
    expect(r.requiredOnDutyMin).toBe(481 + 30);
  });
});

describe("evaluate timeline with multiple breaks", () => {
  const KC = { lat: 39.0997, lng: -94.5786 };
  const OMAHA = { lat: 41.2565, lng: -95.9345 };
  const M = 60_000;

  it("a 19h driving leg carries both 30-min breaks into proposedEnd", () => {
    const load: LoadInput = {
      requiredEquip: "DryVan", hazmatClass: null, revenueCents: 30000,
      stops: [
        { sequence: 1, type: "pickup", location: KC, windowStart: null, windowEnd: null, dwellMin: 60 },
        { sequence: 2, type: "delivery", location: OMAHA, windowStart: null, windowEnd: null, dwellMin: 60 },
      ],
    };
    const driver: DriverInput = {
      status: "active", hazmatEndorsed: true, location: KC, availableAt: 0, hos: fresh,
    };
    const tractor: TractorInput = { status: "active" };
    const trailer: TrailerInput = { type: "DryVan", status: "active" };

    // Deterministic distances: 0 for the co-located deadhead, 190 mi loaded;
    // at 10 mph that's 1140 driving minutes -> crossings at 480 and 960.
    const r = evaluate(load, driver, tractor, trailer, {
      avgSpeedMph: 10,
      roadMilesFn: (a, b) => (a.lat === b.lat && a.lng === b.lng ? 0 : 190),
    });

    // dwell 60 + drive 1140 + breaks 60 + dwell 60 = 1320 minutes wall-clock.
    expect(r.plan.needsBreak).toBe(true);
    expect(r.plan.proposedEnd - r.plan.proposedStart).toBe(1320 * M);
    // The HOS on-duty requirement agrees with the projected wall-clock time.
    expect(r.plan.onDutyMin).toBe(1320);
  });
});
