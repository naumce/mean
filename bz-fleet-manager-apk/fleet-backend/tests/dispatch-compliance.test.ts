import { checkCompliance } from "../src/domain/dispatch/compliance.js";
import type { DriverInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

// Pure-rule tests with a fixed clock: expired at departure blocks, expiring
// mid-trip warns, service-due only ever warns, untracked stays silent.

const START = Date.parse("2026-08-22T08:00:00.000Z");
const END = Date.parse("2026-08-22T20:00:00.000Z");
const plan = { proposedStart: START, proposedEnd: END };
const HOUR = 3_600_000;

const driver: DriverInput = {
  status: "active", hazmatEndorsed: true, availableAt: START,
  location: { lat: 39.1, lng: -94.6 },
  hos: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 },
};
const tractor: TractorInput = { status: "active" };
const trailer: TrailerInput = { type: "DryVan", status: "active" };

it("stays silent when nothing is tracked or everything is in date", () => {
  expect(checkCompliance(driver, tractor, trailer, plan)).toEqual([]);
  const healthy = checkCompliance(
    { ...driver, medicalExpiresAt: END + 30 * 24 * HOUR },
    { ...tractor, inspectionExpiresAt: END + HOUR, registrationExpiresAt: END + HOUR, serviceDueAt: END + HOUR },
    { ...trailer, inspectionExpiresAt: END + HOUR },
    plan,
  );
  expect(healthy).toEqual([]);
});

it("blocks a unit whose inspection expired before departure", () => {
  const [c] = checkCompliance(driver, { ...tractor, inspectionExpiresAt: START - HOUR }, trailer, plan);
  expect(c.kind).toBe("inspection");
  expect(c.severity).toBe("block");
  expect(c.detail).toContain("before departure");
});

it("warns when registration runs out mid-trip", () => {
  const [c] = checkCompliance(driver, { ...tractor, registrationExpiresAt: START + 4 * HOUR }, trailer, plan);
  expect(c.kind).toBe("registration");
  expect(c.severity).toBe("warn");
  expect(c.detail).toContain("during this trip");
});

it("service due never blocks — it warns whenever the due date precedes trip end", () => {
  const [c] = checkCompliance(driver, { ...tractor, serviceDueAt: START - 24 * HOUR }, trailer, plan);
  expect(c.severity).toBe("warn");
  expect(c.kind).toBe("service_due");
});

it("applies the same clock rules to the driver's medical certificate", () => {
  const [expired] = checkCompliance({ ...driver, medicalExpiresAt: START }, tractor, trailer, plan);
  expect(expired.kind).toBe("medical");
  expect(expired.severity).toBe("block");
  const [midTrip] = checkCompliance({ ...driver, medicalExpiresAt: END - HOUR }, tractor, trailer, plan);
  expect(midTrip.severity).toBe("warn");
});

it("covers the trailer's clocks independently of the tractor's", () => {
  const conflicts = checkCompliance(
    driver,
    { ...tractor, inspectionExpiresAt: END + HOUR },
    { ...trailer, inspectionExpiresAt: START - HOUR, serviceDueAt: START + HOUR },
    plan,
  );
  expect(conflicts.map((c) => [c.kind, c.severity])).toEqual([
    ["inspection", "block"],
    ["service_due", "warn"],
  ]);
  expect(conflicts[0].detail).toContain("Trailer inspection");
});
