import { describe, it, expect } from "vitest";
import { proposeSheetMapping, validateMapping, columnIndexes } from "../../src/lib/sheet/mapping.js";

describe("proposeSheetMapping", () => {
  it("proposes by header alias, lists extras and missing", () => {
    const r = proposeSheetMapping(["Load #", "Driver Cell", "Origin", "Destination", "PU Appt", "Del Appt", "Broker", "Rate"]);
    expect(r.mapping).toEqual({ loadRef: "Load #", driverPhone: "Driver Cell", pickup: "Origin", delivery: "Destination", pickupAppt: "PU Appt", deliveryAppt: "Del Appt", rate: "Rate" });
    expect(r.extras).toEqual(["Broker"]);
    expect(r.missing).toEqual([]);
  });

  // Final fix wave, I7: pickupAppt is required alongside deliveryAppt.
  it("reports missing required keys — pickupAppt included", () => {
    expect(proposeSheetMapping(["Load #", "Origin"]).missing).toEqual(["driverPhone", "delivery", "pickupAppt", "deliveryAppt"]);
    expect(proposeSheetMapping(["Load #", "Driver Cell", "Origin", "Destination", "Del Appt"]).missing).toEqual(["pickupAppt"]);
  });
});

describe("validateMapping", () => {
  it("refuses a header used twice, an unknown header, and a missing required key", () => {
    const header = ["Load #", "Driver Cell", "Origin", "Destination", "PU Appt", "Del Appt"];
    const full = { loadRef: "Load #", driverPhone: "Driver Cell", pickup: "Origin", delivery: "Destination", pickupAppt: "PU Appt", deliveryAppt: "Del Appt" };
    expect(validateMapping(header, full)).toEqual({ ok: true });
    expect(validateMapping(header, { ...full, driverPhone: "Load #" })).toEqual({ ok: false, errors: ['"Load #" is used for both loadRef and driverPhone'] });
    expect(validateMapping(header, { ...full, loadRef: "Nope" }).ok).toBe(false);
    expect(validateMapping(header, { loadRef: "Load #" }).ok).toBe(false);
  });

  it("refuses a mapping with no pickupAppt (final fix wave, I7)", () => {
    const header = ["Load #", "Driver Cell", "Origin", "Destination", "PU Appt", "Del Appt"];
    const r = validateMapping(header, { loadRef: "Load #", driverPhone: "Driver Cell", pickup: "Origin", delivery: "Destination", deliveryAppt: "Del Appt" });
    expect(r).toEqual({ ok: false, errors: ['missing required key "pickupAppt"'] });
  });
});

describe("columnIndexes", () => {
  it("resolves each mapped key to its 0-based header index", () => {
    const header = ["Load #", "Driver Cell", "Origin", "Destination", "Del Appt"];
    const mapping = { loadRef: "Load #", driverPhone: "Driver Cell", pickup: "Origin", delivery: "Destination", deliveryAppt: "Del Appt" };
    expect(columnIndexes(header, mapping)).toEqual({ loadRef: 0, driverPhone: 1, pickup: 2, delivery: 3, deliveryAppt: 4 });
  });

  it("omits a mapped key whose header is not actually in the header row", () => {
    const header = ["Load #", "Driver Cell"];
    expect(columnIndexes(header, { loadRef: "Load #", pickup: "Origin" })).toEqual({ loadRef: 0 });
  });
});
