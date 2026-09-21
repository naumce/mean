import {
  asTrailerType,
  dispatchStatus,
  toDriverInput,
  toLoadInput,
  toTractorInput,
  toTrailerInput,
  UNKNOWN_HOS,
  type DriverRow,
  type LoadRow,
} from "../src/domain/dispatch/mapper.js";

const loadRow = (over: Partial<LoadRow> = {}): LoadRow => ({
  requiredEquip: "Reefer",
  hazmatClass: null,
  revenueCents: 30000,
  fscCents: 4000,
  stops: [
    {
      sequence: 1,
      type: "pickup",
      lat: 39.1,
      lng: -94.58,
      dwellMin: 45,
      appointment: { windowStart: new Date("2026-08-21T14:00:00Z"), windowEnd: new Date("2026-08-21T16:00:00Z") },
    },
    { sequence: 2, type: "delivery", lat: 41.26, lng: -95.93, dwellMin: null, appointment: null },
  ],
  ...over,
});

it("maps a load, summing linehaul + fsc into revenue and dates into ms", () => {
  const input = toLoadInput(loadRow());
  expect(input.revenueCents).toBe(34000);
  expect(input.requiredEquip).toBe("Reefer");
  expect(input.stops[0].windowStart).toBe(new Date("2026-08-21T14:00:00Z").getTime());
  expect(input.stops[0].windowEnd).toBe(new Date("2026-08-21T16:00:00Z").getTime());
  expect(input.stops[0].dwellMin).toBe(45);
  expect(input.stops[1].windowEnd).toBeNull();
});

it("rejects an ungeocoded stop and an unknown trailer type", () => {
  const bad = loadRow({ stops: [{ sequence: 1, type: "pickup", lat: null, lng: null, dwellMin: null, appointment: null }] });
  expect(() => toLoadInput(bad)).toThrow(/geocoded/);
  expect(() => asTrailerType("Spaceship")).toThrow();
});

it("treats mobile presence as availability: offline/online are dispatchable, only explicit-off is not", () => {
  expect(dispatchStatus("offline")).toBe("active");
  expect(dispatchStatus("online")).toBe("active");
  expect(dispatchStatus("off_duty")).toBe("inactive");
  expect(dispatchStatus("inactive")).toBe("inactive");
});

const driverRow = (over: Partial<DriverRow> = {}): DriverRow => ({
  status: "offline",
  hazmatEndorsed: true,
  lastLat: 39.1,
  lastLng: -94.58,
  hos: { driveRemainingMin: 300, windowRemainingMin: 500, cycleRemainingMin: 2000, minutesSinceBreak: 60 },
  ...over,
});

it("maps a driver with known HOS (hosKnown=true) and the supplied availableAt", () => {
  const { input, hosKnown } = toDriverInput(driverRow(), { availableAt: 123456 });
  expect(hosKnown).toBe(true);
  expect(input.status).toBe("active"); // offline presence -> dispatchable
  expect(input.availableAt).toBe(123456);
  expect(input.location).toEqual({ lat: 39.1, lng: -94.58 });
  expect(input.hos.driveRemainingMin).toBe(300);
});

it("defaults unknown HOS to full clocks and flags hosKnown=false", () => {
  const { input, hosKnown } = toDriverInput(driverRow({ hos: null }), { availableAt: 0 });
  expect(hosKnown).toBe(false);
  expect(input.hos).toEqual(UNKNOWN_HOS);
});

it("throws when a driver has no position for the deadhead origin", () => {
  expect(() => toDriverInput(driverRow({ lastLat: null }), { availableAt: 0 })).toThrow(/position/);
});

it("maps tractor and trailer status into engine buckets, with compliance clocks as epoch ms", () => {
  expect(toTractorInput({ status: "active" }).status).toBe("active");
  expect(toTractorInput({ status: "in_shop" }).status).toBe("in_shop");
  const trailer = toTrailerInput({ type: "DryVan", status: "idle" });
  expect(trailer.type).toBe("DryVan");
  expect(trailer.status).toBe("idle");
  expect(trailer.inspectionExpiresAt).toBeNull(); // untracked clocks map to null, never 0
  expect(toTrailerInput({ type: "Reefer", status: "rolling" }).status).toBe("active");

  const expiry = new Date("2027-01-01T00:00:00.000Z");
  const tracked = toTractorInput({ status: "active", inspectionExpiresAt: expiry, nextServiceAt: expiry });
  expect(tracked.inspectionExpiresAt).toBe(expiry.getTime());
  expect(tracked.serviceDueAt).toBe(expiry.getTime());
});
