import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DEFAULT_BROKER_LAYOUT, layoutFor, normalizeHeader, proposeLayout, saveLayout } from "../src/lib/boardLayout.js";
import { resetDb } from "./helpers.js";

// The customer's header row, exactly as typed, stars and all.
const THEIR_HEADER = ["BOL#", "CUSTOMER /CARRIER", "TELEPHONE#", "CONTACT NAME", "PICK UP", "PU ZIP", "DEL ZIP", "DELIVERY", "RATE", "SOLD RATE", "PROFIT", "M.C. #", "LOAD#", "SHIP DATE", "****UPDATE****", "APPT SCHEDULE"];

describe("normalizeHeader", () => {
  it("strips decoration so 'their' spelling matches ours", () => {
    expect(normalizeHeader("****UPDATE****")).toBe("update");
    expect(normalizeHeader("M.C. #")).toBe("mc");
    expect(normalizeHeader("CUSTOMER /CARRIER")).toBe("customer carrier");
    expect(normalizeHeader("  BOL# ")).toBe("bol");
    expect(normalizeHeader("Rate ($)")).toBe("rate");
  });
});

describe("proposeLayout", () => {
  it("maps every one of the customer's columns, in their order, and appends the agent pill", () => {
    const { columns, unmatched, missing } = proposeLayout(THEIR_HEADER);
    expect(columns.map((c) => c.key)).toEqual(["bol", "customer", "phone", "contact", "pickupCity", "puZip", "delZip", "deliveryCity", "rate", "soldRate", "profit", "mc", "loadNo", "shipDate", "update", "appt", "agent"]);
    expect(columns.map((c) => c.label).slice(0, 16)).toEqual(THEIR_HEADER);
    expect(unmatched).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("keeps a column it does not know as extra text, and names what a board is missing", () => {
    const { columns, unmatched, missing } = proposeLayout(["BOL#", "CUSTOMER", "NOTES", "PICK UP", "DELIVERY", "RATE"]);
    expect(columns.find((c) => c.key === "extra")).toEqual({ key: "extra", label: "NOTES", source: "NOTES" });
    expect(unmatched).toEqual(["NOTES"]);
    expect(missing).toContain("loadNo");
    expect(missing).toContain("appt");
  });

  it("recognizes common alternative spellings", () => {
    const { columns } = proposeLayout(["BOL", "Customer/Carrier", "Phone", "Contact", "Origin", "Origin Zip", "Dest Zip", "Destination", "Rate ($)", "Sold Rate ($)", "Margin", "MC#", "Load #", "Ship Date", "Update", "Appointments"]);
    expect(columns.map((c) => c.key)).toEqual(["bol", "customer", "phone", "contact", "pickupCity", "puZip", "delZip", "deliveryCity", "rate", "soldRate", "profit", "mc", "loadNo", "shipDate", "update", "appt", "agent"]);
  });

  it("claims the agent key for a header that already means agent, instead of appending a second one", () => {
    const { columns } = proposeLayout(["BOL#", "AGENT", "RATE"]);
    expect(columns.map((c) => c.key)).toEqual(["bol", "agent", "rate"]);
    expect(columns.find((c) => c.key === "agent")?.label).toBe("AGENT");
  });
});

describe("layoutFor / saveLayout", () => {
  beforeEach(resetDb);
  it("falls back to the default layout and returns what was saved afterwards", async () => {
    const org = await prisma.org.create({ data: { name: "B", timezone: "America/Chicago" } });
    expect(await layoutFor(org.id)).toEqual(DEFAULT_BROKER_LAYOUT);
    const theirs = proposeLayout(THEIR_HEADER).columns;
    await saveLayout(org.id, theirs);
    expect(await layoutFor(org.id)).toEqual(theirs);
    await saveLayout(org.id, theirs.slice(0, 3));
    expect((await layoutFor(org.id)).length).toBe(3);
  });

  it("never hands out the shared default array by reference", async () => {
    const org = await prisma.org.create({ data: { name: "C", timezone: "America/Chicago" } });
    const first = await layoutFor(org.id);
    first.push({ key: "extra", label: "BOGUS" });
    const second = await layoutFor(org.id);
    expect(second).toEqual(DEFAULT_BROKER_LAYOUT);
    expect(second.length).toBe(17);
  });
});
