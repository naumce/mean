import {
  checkEquipment,
  checkHazmat,
  checkDriverAvailable,
  checkTractorAvailable,
  checkTrailerAvailable,
  checkOverlap,
} from "../src/domain/dispatch/checks.js";
import type { DriverInput, LoadInput, TrailerInput } from "../src/domain/dispatch/types.js";

const load = (over: Partial<LoadInput> = {}): LoadInput => ({
  requiredEquip: "Reefer",
  hazmatClass: null,
  stops: [],
  ...over,
});

const driver = (over: Partial<DriverInput> = {}): DriverInput => ({
  status: "active",
  hazmatEndorsed: false,
  availableAt: 0,
  location: { lat: 0, lng: 0 },
  hos: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 },
  ...over,
});

it("passes equipment when the trailer type matches", () => {
  const t: TrailerInput = { type: "Reefer", status: "active" };
  expect(checkEquipment(load(), t)).toBeNull();
});

it("blocks equipment when the trailer type is wrong", () => {
  const t: TrailerInput = { type: "DryVan", status: "active" };
  expect(checkEquipment(load(), t)?.kind).toBe("equipment");
});

it("passes hazmat for a non-haz load regardless of endorsement", () => {
  expect(checkHazmat(load({ hazmatClass: null }), driver())).toBeNull();
});

it("blocks hazmat when load is hazardous and driver is not endorsed", () => {
  const c = checkHazmat(load({ hazmatClass: "8" }), driver({ hazmatEndorsed: false }));
  expect(c?.kind).toBe("hazmat");
});

it("passes hazmat when driver is endorsed", () => {
  expect(checkHazmat(load({ hazmatClass: "8" }), driver({ hazmatEndorsed: true }))).toBeNull();
});

it("blocks an off-duty driver / in-shop tractor / in-shop trailer", () => {
  expect(checkDriverAvailable(driver({ status: "off_duty" }))?.kind).toBe("driver_unavail");
  expect(checkTractorAvailable({ status: "in_shop" })?.kind).toBe("tractor_unavail");
  expect(checkTrailerAvailable({ type: "DryVan", status: "in_shop" })?.kind).toBe("trailer_unavail");
});

it("allows an idle trailer but blocks an in-shop one", () => {
  expect(checkTrailerAvailable({ type: "DryVan", status: "idle" })).toBeNull();
});

it("detects an overlapping committed interval", () => {
  const busy = [{ start: 100, end: 200 }];
  expect(checkOverlap(150, 250, busy, "overlap", "Driver")?.kind).toBe("overlap");
});

it("treats touching-but-not-overlapping intervals as free", () => {
  const busy = [{ start: 100, end: 200 }];
  expect(checkOverlap(200, 300, busy, "overlap", "Driver")).toBeNull();
});

it("is free when there are no committed intervals", () => {
  expect(checkOverlap(0, 100, undefined, "overlap", "Driver")).toBeNull();
});
