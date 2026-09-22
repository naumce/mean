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
    // Two-rows-per-load sheets: a lone appointment-ish column is proposed
    // for BOTH keys, so it is no longer "missing pickupAppt" — see the
    // shared-header describe below. Two columns still map one each.
    expect(proposeSheetMapping(["Load #", "Driver Cell", "Origin", "Destination", "Del Appt"]).missing).toEqual([]);
    expect(proposeSheetMapping(["Load #", "Driver Cell", "Origin", "Destination"]).missing).toEqual(["pickupAppt", "deliveryAppt"]);
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

// Two-rows-per-load sheets: the broker layout has ONE appointment column.
describe("a shared appointment header", () => {
  const header = ["LOAD#", "TELEPHONE#", "PICK UP", "DELIVERY", "APPT SCHEDULE"];
  const shared = { loadRef: "LOAD#", driverPhone: "TELEPHONE#", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE" };

  it("validateMapping allows pickupAppt and deliveryAppt to share one header", () => {
    expect(validateMapping(header, shared)).toEqual({ ok: true });
  });

  it("any other shared header is still refused", () => {
    expect(validateMapping(header, { ...shared, notes: "APPT SCHEDULE" })).toEqual({ ok: false, errors: ['"APPT SCHEDULE" is used for both pickupAppt and deliveryAppt and notes'] });
    expect(validateMapping(header, { ...shared, driverPhone: "LOAD#" })).toEqual({ ok: false, errors: ['"LOAD#" is used for both loadRef and driverPhone'] });
  });

  it("proposeSheetMapping maps a lone APPT SCHEDULE to both keys", () => {
    const r = proposeSheetMapping(["BOL#", "CUSTOMER /CARRIER", "TELEPHONE#", "CONTACT NAME", "PICK UP", "DELIVERY", "RATE", "LOAD#", "APPT SCHEDULE"]);
    expect(r.mapping.pickupAppt).toBe("APPT SCHEDULE");
    expect(r.mapping.deliveryAppt).toBe("APPT SCHEDULE");
    expect(r.missing).not.toContain("pickupAppt");
    expect(r.missing).not.toContain("deliveryAppt");
    expect(r.extras).not.toContain("APPT SCHEDULE");
  });

  it("proposeSheetMapping keeps two appointment columns apart", () => {
    const r = proposeSheetMapping(["LOAD#", "PU Appt", "Del Appt"]);
    expect(r.mapping.pickupAppt).toBe("PU Appt");
    expect(r.mapping.deliveryAppt).toBe("Del Appt");
  });
});
