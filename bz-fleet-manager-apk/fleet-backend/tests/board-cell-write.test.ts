import { describe, expect, it } from "vitest";
import { planCellWrite } from "../src/lib/boardCellWrite.js";

// The board's GET turns a Load into two rows of cells. This is the inverse,
// as a plan the route executes: which field a cell belongs to, what its text
// parses to, and which cells are not a dispatcher's to type at all.
describe("planCellWrite — the customer line", () => {
  it("sends plain text straight to its own column", () => {
    expect(planCellWrite({ row: "top", key: "bol", value: "0500001" })).toEqual({ kind: "load", field: "bolNumber", value: "0500001" });
    expect(planCellWrite({ row: "top", key: "customer", value: "ACME FOODS" })).toEqual({ kind: "load", field: "customerName", value: "ACME FOODS" });
    expect(planCellWrite({ row: "top", key: "loadNo", value: "2026-34566-00" })).toEqual({ kind: "load", field: "orderRef", value: "2026-34566-00" });
  });

  it("stores what a human typed in UPDATE exactly as they typed it", () => {
    // Spec §5.3: free text is never rewritten, never parsed, never trimmed
    // into something tidier. The agent reads it; it does not own it.
    const messy = "  DELIVERED 07/15  —  waiting on POD  ";
    expect(planCellWrite({ row: "top", key: "update", value: messy })).toEqual({ kind: "load", field: "updateText", value: messy });
  });

  it("clears a column when the cell is emptied", () => {
    expect(planCellWrite({ row: "top", key: "bol", value: "" })).toEqual({ kind: "load", field: "bolNumber", value: null });
    expect(planCellWrite({ row: "top", key: "rate", value: "" })).toEqual({ kind: "money", field: "revenueCents", cents: null });
  });

  it("reads money the way their sheet writes it", () => {
    expect(planCellWrite({ row: "top", key: "rate", value: "$4,000.00" })).toEqual({ kind: "money", field: "revenueCents", cents: 400000 });
    expect(planCellWrite({ row: "top", key: "soldRate", value: "3600" })).toEqual({ kind: "money", field: "soldRateCents", cents: 360000 });
  });

  it("refuses money it cannot read rather than storing a guess", () => {
    const plan = planCellWrite({ row: "top", key: "rate", value: "call me" });
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.reason).toMatch(/RATE/);
  });

  it("reads a ship date, and refuses one it cannot", () => {
    expect(planCellWrite({ row: "top", key: "shipDate", value: "7/13/2026" })).toEqual({ kind: "date", field: "shipDate", at: new Date(Date.UTC(2026, 6, 13)) });
    expect(planCellWrite({ row: "top", key: "shipDate", value: "next tuesday" }).kind).toBe("refuse");
    expect(planCellWrite({ row: "top", key: "shipDate", value: "" })).toEqual({ kind: "date", field: "shipDate", at: null });
  });

  it("never lets PROFIT be typed", () => {
    // It is RATE − SOLD RATE at read time. A typed profit would be a number
    // the board shows and the arithmetic contradicts.
    const plan = planCellWrite({ row: "top", key: "profit", value: "400" });
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.reason).toMatch(/RATE minus SOLD RATE/i);
  });

  it("never lets the agent's own column be typed", () => {
    expect(planCellWrite({ row: "top", key: "agent", value: "all good" }).kind).toBe("refuse");
  });

  it("refuses the MC label on the customer line", () => {
    // Their sheet prints the literal word "MC" there; the number is on the
    // carrier line under it.
    expect(planCellWrite({ row: "top", key: "mc", value: "1000001" }).kind).toBe("refuse");
  });

  it("writes a city and a ZIP onto the stop they describe", () => {
    expect(planCellWrite({ row: "top", key: "pickupCity", value: "Henderson, NV" })).toEqual({ kind: "stop", stop: "pickup", part: "city", value: "Henderson, NV" });
    expect(planCellWrite({ row: "top", key: "delZip", value: "75236" })).toEqual({ kind: "stop", stop: "delivery", part: "zip", value: "75236" });
  });

  it("refuses a ZIP that is not one", () => {
    expect(planCellWrite({ row: "top", key: "puZip", value: "89O74" }).kind).toBe("refuse");
    expect(planCellWrite({ row: "top", key: "puZip", value: "" })).toEqual({ kind: "stop", stop: "pickup", part: "zip", value: "" });
  });

  it("puts the appointment text on its own line of the cell", () => {
    expect(planCellWrite({ row: "top", key: "appt", value: "PU: 07/13 - 13:00" })).toEqual({ kind: "appt", line: 0, value: "PU: 07/13 - 13:00" });
    expect(planCellWrite({ row: "bottom", key: "appt", value: "DEL: 07/15 - 11:00" })).toEqual({ kind: "appt", line: 1, value: "DEL: 07/15 - 11:00" });
  });
});

describe("planCellWrite — the carrier line", () => {
  it("routes the carrier's own columns to the carrier", () => {
    expect(planCellWrite({ row: "bottom", key: "customer", value: "Blue Road LLC" })).toEqual({ kind: "carrier", field: "name", value: "Blue Road LLC" });
    expect(planCellWrite({ row: "bottom", key: "mc", value: "1000001" })).toEqual({ kind: "carrier", field: "mcNumber", value: "1000001" });
  });

  it("keeps the carrier's phone and contact on the load, as typed", () => {
    // Extension and all — spec §4.1. These live on Load, not Carrier: the
    // same carrier answers on a different number for a different load.
    expect(planCellWrite({ row: "bottom", key: "phone", value: "(555) 010-0104 x12" })).toEqual({ kind: "load", field: "carrierPhone", value: "(555) 010-0104 x12" });
    expect(planCellWrite({ row: "bottom", key: "contact", value: "Contact A" })).toEqual({ kind: "load", field: "carrierContactName", value: "Contact A" });
  });

  it("writes the board's LOAD# to the board's own column, never to the TMS identity", () => {
    expect(planCellWrite({ row: "bottom", key: "loadNo", value: "145205" })).toEqual({ kind: "load", field: "boardLoadNo", value: "145205" });
  });
});

describe("planCellWrite — cells with nowhere else to go", () => {
  it("keeps an unmapped column under the header the sheet gave it", () => {
    expect(planCellWrite({ row: "top", key: "extra", source: "TRAILER TYPE", value: "REEFER" })).toEqual({ kind: "extras", key: "TRAILER TYPE", value: "REEFER" });
    expect(planCellWrite({ row: "bottom", key: "extra", source: "TRAILER TYPE", value: "53 REEFER" })).toEqual({ kind: "extras", key: "TRAILER TYPE:2", value: "53 REEFER" });
  });

  it("keeps a second line the schema has no field for, rather than dropping it", () => {
    // A paste can land anywhere. Nothing a dispatcher types disappears.
    expect(planCellWrite({ row: "bottom", key: "shipDate", value: "07/16/2026" })).toEqual({ kind: "extras", key: "shipDate:2", value: "07/16/2026" });
    expect(planCellWrite({ row: "bottom", key: "rate", value: "$4,100.00" })).toEqual({ kind: "extras", key: "rate:2", value: "$4,100.00" });
    expect(planCellWrite({ row: "top", key: "contact", value: "Buyer B" })).toEqual({ kind: "extras", key: "contact:1", value: "Buyer B" });
  });

  it("refuses a column it has never heard of", () => {
    expect(planCellWrite({ row: "top", key: "teleport" as never, value: "x" }).kind).toBe("refuse");
    // An `extra` column with no header text has no key to store under.
    expect(planCellWrite({ row: "top", key: "extra", value: "x" }).kind).toBe("refuse");
  });
});
