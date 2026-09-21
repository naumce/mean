import { evaluateHos } from "../src/domain/dispatch/hos.js";
import type { HosStateInput } from "../src/domain/dispatch/types.js";

const fresh: HosStateInput = {
  driveRemainingMin: 660, // 11h
  windowRemainingMin: 840, // 14h
  cycleRemainingMin: 4200, // 70h
  minutesSinceBreak: 0,
};

it("a short trip well within all clocks is feasible with no break", () => {
  const r = evaluateHos({ driveMin: 120, dwellMin: 60, hos: fresh });
  expect(r.feasible).toBe(true);
  expect(r.needsBreak).toBe(false);
  expect(r.requiredDriveMin).toBe(120);
  expect(r.requiredOnDutyMin).toBe(180);
  expect(r.conflict).toBeUndefined();
});

it("triggers the 30-min break once cumulative driving passes 8h", () => {
  // 400 already + 120 this trip = 520 > 480 -> break required
  const hos = { ...fresh, minutesSinceBreak: 400 };
  const r = evaluateHos({ driveMin: 120, dwellMin: 60, hos });
  expect(r.needsBreak).toBe(true);
  expect(r.requiredOnDutyMin).toBe(120 + 60 + 30);
});

it("blocks when required driving exceeds the 11h driving clock", () => {
  const hos = { ...fresh, driveRemainingMin: 200 };
  const r = evaluateHos({ driveMin: 275, dwellMin: 60, hos });
  expect(r.feasible).toBe(false);
  expect(r.conflict?.kind).toBe("hos");
  expect(r.conflict?.severity).toBe("block");
  expect(r.conflict?.detail).toContain("drive");
});

it("blocks when on-duty exceeds the 14h window even if driving fits", () => {
  const hos = { ...fresh, windowRemainingMin: 150 };
  const r = evaluateHos({ driveMin: 120, dwellMin: 60, hos }); // onDuty 180 > 150
  expect(r.feasible).toBe(false);
  expect(r.conflict?.detail).toContain("14h window");
});

it("blocks when the weekly cycle is the binding limit", () => {
  const hos = { ...fresh, cycleRemainingMin: 150 };
  const r = evaluateHos({ driveMin: 120, dwellMin: 60, hos }); // onDuty 180 > 150
  expect(r.feasible).toBe(false);
  expect(r.conflict?.detail).toContain("cycle");
});

it("is exactly-feasible at the boundary (equal, not over)", () => {
  const hos: HosStateInput = {
    driveRemainingMin: 120,
    windowRemainingMin: 180,
    cycleRemainingMin: 180,
    minutesSinceBreak: 0,
  };
  const r = evaluateHos({ driveMin: 120, dwellMin: 60, hos });
  expect(r.feasible).toBe(true);
});
