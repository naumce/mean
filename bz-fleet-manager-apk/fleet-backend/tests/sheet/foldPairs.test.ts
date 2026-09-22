import { describe, it, expect } from "vitest";
import { foldPairs, suggestRowsPerLoad } from "../../src/lib/sheet/foldPairs.js";
import type { RawRow } from "../../src/lib/sheet/connector.js";
import type { SheetMapping } from "../../src/lib/sheet/mapping.js";
import { BROKER_ROWS, THEIR_HEADER } from "../fixtures/brokerBoard.js";

// Two-rows-per-load sheets: the broker layout (tests/fixtures/brokerBoard.ts)
// puts the customer row on top and the carrier row under it. `foldPairs`
// turns each pair into ONE virtual RawRow the rest of the sheet layer reads
// exactly as it reads a one-row sheet.

const MAPPING: SheetMapping = {
  loadRef: "LOAD#", driverPhone: "TELEPHONE#", driverName: "CONTACT NAME", pickup: "PICK UP", delivery: "DELIVERY",
  pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE", carrierName: "CUSTOMER /CARRIER", rate: "RATE", notes: "****UPDATE****",
};

const col = (header: string[], name: string): number => header.indexOf(name);

/** What `readRows` hands the sync for the fixture: header = THEIR_HEADER
 *  (grid row 2, so `headerRow` 2), every non-blank row under it with its
 *  1-based sheet row index. */
function fixtureRows(grid: string[][] = BROKER_ROWS): RawRow[] {
  const headerPos = grid.indexOf(THEIR_HEADER);
  return grid
    .map((cells, i) => ({ rowIndex: i + 1, cells }))
    .slice(headerPos + 1)
    .filter((r) => r.cells.some((c) => c !== ""));
}

describe("foldPairs", () => {
  it("folds the broker fixture's 9 non-blank rows into 5 loads, bottom-row fields winning where they live", () => {
    const rows = fixtureRows();
    expect(rows).toHaveLength(9);

    const folded = foldPairs(rows, THEIR_HEADER, MAPPING);
    expect(folded.rows).toHaveLength(5);
    expect(folded.header).toEqual([...THEIR_HEADER, "ORDER REF"]);

    const h = folded.header;
    const first = folded.rows[0];
    expect(first.rowIndex).toBe(3); // the top row's own sheet row (title row 1, header row 2)
    expect(first.cells[col(h, "LOAD#")]).toBe("145205");
    expect(first.cells[col(h, "TELEPHONE#")]).toBe("(555) 010-0104"); // bottom wins over the tracking URL
    expect(first.cells[col(h, "CONTACT NAME")]).toBe("Contact A");
    expect(first.cells[col(h, "CUSTOMER /CARRIER")]).toBe("BLUE ROAD LLC");
    expect(first.cells[col(h, "APPT SCHEDULE")]).toBe("PU: 07/13 - 13:00\nDEL: 07/15 - 11:00");
    expect(first.cells[col(h, "ORDER REF")]).toBe("2026-34566-00");
    // top wins elsewhere; bottom fills a blank top
    expect(first.cells[col(h, "BOL#")]).toBe("0500001");
    expect(first.cells[col(h, "PICK UP")]).toBe("Henderson, NV");
    expect(first.cells[col(h, "RATE")]).toBe("$4,000.00");
    expect(first.cells[col(h, "M.C. #")]).toBe("MC"); // the top's placeholder wins over the bottom's number (top wins on an unmapped column)
    expect(first.cells[col(h, "SHIP DATE")]).toBe("7/13/2026");
    expect(first.cells).toHaveLength(h.length);

    expect(folded.rows.map((r) => r.cells[col(h, "LOAD#")])).toEqual(["145205", "145219", "145197", "145963", "2026-35100-00"]);
    expect(folded.rows.map((r) => r.rowIndex)).toEqual([3, 6, 9, 12, 15]);
  });

  it("a lone top (the unassigned Denver load) folds to itself, keeping its own LOAD# and no ORDER REF", () => {
    const folded = foldPairs(fixtureRows(), THEIR_HEADER, MAPPING);
    const denver = folded.rows[4];
    const h = folded.header;
    expect(denver.rowIndex).toBe(15);
    expect(denver.cells[col(h, "LOAD#")]).toBe("2026-35100-00");
    expect(denver.cells[col(h, "DELIVERY")]).toBe("Denver, CO");
    expect(denver.cells[col(h, "ORDER REF")]).toBe("");
    expect(denver.cells[col(h, "APPT SCHEDULE")]).toBe("PU: 07/15 - tbd");
    expect(denver.cells[col(h, "TELEPHONE#")]).toBe("");
  });

  it("never drops a row: a blank-cities top still folds with the bottom after it, and B keeps its own LOAD#/carrier", () => {
    const header = ["LOAD#", "CUSTOMER /CARRIER", "PICK UP", "DELIVERY"];
    const mapping: SheetMapping = { loadRef: "LOAD#", carrierName: "CUSTOMER /CARRIER", pickup: "PICK UP", delivery: "DELIVERY" };
    // TopA(cities), BottomA(blank cities), TopB(both cities blank), BottomB(blank cities)
    const rows: RawRow[] = [
      { rowIndex: 1, cells: ["A1", "Cust A", "Origin A", "Dest A"] },
      { rowIndex: 2, cells: ["B1", "Carrier A", "", ""] },
      { rowIndex: 3, cells: ["A2", "Cust B", "", ""] },
      { rowIndex: 4, cells: ["B2", "Carrier B", "", ""] },
    ];
    const folded = foldPairs(rows, header, mapping);
    expect(folded.rows).toHaveLength(2);
    expect(folded.rows.map((r) => r.rowIndex)).toEqual([1, 3]);
    const h = folded.header;
    expect(folded.rows[0].cells[col(h, "LOAD#")]).toBe("B1");
    expect(folded.rows[0].cells[col(h, "CUSTOMER /CARRIER")]).toBe("Carrier A");
    // B: a blank-cities top folded with the row after it — it keeps its own LOAD#/carrier
    expect(folded.rows[1].cells[col(h, "LOAD#")]).toBe("B2");
    expect(folded.rows[1].cells[col(h, "CUSTOMER /CARRIER")]).toBe("Carrier B");
  });

  it("never drops a row: a blank-cities row as the very first row still folds with the row after it", () => {
    const header = ["LOAD#", "PICK UP", "DELIVERY"];
    const mapping: SheetMapping = { loadRef: "LOAD#", pickup: "PICK UP", delivery: "DELIVERY" };
    const rows: RawRow[] = [
      { rowIndex: 1, cells: ["L1", "", ""] }, // blank cities, but it is the first row — nothing before it to be a bottom of
      { rowIndex: 2, cells: ["L2", "", ""] }, // blank cities too (a normal carrier/bottom row) — folds as L1's bottom
    ];
    const folded = foldPairs(rows, header, mapping);
    expect(folded.rows).toHaveLength(1);
    expect(folded.rows[0].rowIndex).toBe(1);
    // LOAD# is a bottomWins column: L2 (the bottom's) wins; L1 is preserved under ORDER REF.
    expect(folded.rows[0].cells[col(folded.header, "LOAD#")]).toBe("L2");
    expect(folded.rows[0].cells[col(folded.header, "ORDER REF")]).toBe("L1");
  });

  it("the agent columns come from the top row only, even when the bottom row has a value", () => {
    const header = [...THEIR_HEADER, "Night Shift", "Night Shift status"];
    const rows = fixtureRows();
    const top: RawRow = { rowIndex: rows[0].rowIndex, cells: [...rows[0].cells, "", ""] };
    const bottom: RawRow = { rowIndex: rows[1].rowIndex, cells: [...rows[1].cells, "Standard", "● WATCHING"] };
    const folded = foldPairs([top, bottom], header, MAPPING);
    const h = folded.header;
    expect(folded.rows).toHaveLength(1);
    expect(folded.rows[0].cells[col(h, "Night Shift")]).toBe("");
    expect(folded.rows[0].cells[col(h, "Night Shift status")]).toBe("");
    // still a proper fold otherwise
    expect(folded.rows[0].cells[col(h, "LOAD#")]).toBe("145205");
    // the original header is not touched; the agent columns keep their index
    expect(col(h, "Night Shift")).toBe(col(header, "Night Shift"));
  });

  it("unmapped columns: top wins, bottom fills a blank top", () => {
    const header = ["LOAD#", "PICK UP", "DELIVERY", "APPT SCHEDULE", "EXTRA"];
    const mapping: SheetMapping = { loadRef: "LOAD#", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE" };
    const filled = foldPairs([
      { rowIndex: 2, cells: ["", "A", "B", "PU: 1", "top-extra"] },
      { rowIndex: 3, cells: ["L1", "", "", "DEL: 2", "bottom-extra"] },
    ], header, mapping);
    expect(filled.rows[0].cells[col(filled.header, "EXTRA")]).toBe("top-extra");
    const blank = foldPairs([
      { rowIndex: 2, cells: ["", "A", "B", "PU: 1", ""] },
      { rowIndex: 3, cells: ["L1", "", "", "DEL: 2", "bottom-extra"] },
    ], header, mapping);
    expect(blank.rows[0].cells[col(blank.header, "EXTRA")]).toBe("bottom-extra");
    // a top with no LOAD# of its own: the bottom's LOAD# lands, ORDER REF stays empty
    expect(blank.rows[0].cells[col(blank.header, "LOAD#")]).toBe("L1");
    expect(blank.rows[0].cells[col(blank.header, "ORDER REF")]).toBe("");
  });

  it("two tops in a row are two loads — a top never becomes another top's bottom", () => {
    const header = ["LOAD#", "PICK UP", "DELIVERY", "APPT SCHEDULE"];
    const mapping: SheetMapping = { loadRef: "LOAD#", pickup: "PICK UP", delivery: "DELIVERY", pickupAppt: "APPT SCHEDULE", deliveryAppt: "APPT SCHEDULE" };
    const folded = foldPairs([
      { rowIndex: 2, cells: ["L1", "A", "B", "PU: 1"] },
      { rowIndex: 3, cells: ["L2", "", "C", "PU: 2"] },
    ], header, mapping);
    expect(folded.rows.map((r) => [r.rowIndex, r.cells[0]])).toEqual([[2, "L1"], [3, "L2"]]);
  });

  it("never mutates its input rows", () => {
    const rows = fixtureRows();
    const snapshot = JSON.stringify(rows);
    foldPairs(rows, THEIR_HEADER, MAPPING);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("suggestRowsPerLoad", () => {
  it("the broker fixture (4 pairs out of 5 detected loads) suggests 2", () => {
    expect(suggestRowsPerLoad(fixtureRows(), THEIR_HEADER, MAPPING)).toBe(2);
  });

  it("a one-row-per-load sheet (0 pairs) suggests 1", () => {
    const header = ["LOAD#", "PICK UP", "DELIVERY"];
    const mapping: SheetMapping = { loadRef: "LOAD#", pickup: "PICK UP", delivery: "DELIVERY" };
    const rows: RawRow[] = [
      { rowIndex: 2, cells: ["L1", "A", "B"] },
      { rowIndex: 3, cells: ["L2", "C", "D"] },
      { rowIndex: 4, cells: ["L3", "E", "F"] },
    ];
    expect(suggestRowsPerLoad(rows, header, mapping)).toBe(1);
  });

  it("a one-row sheet with a single blank-cities row suggests 1 (one detected pair is not enough)", () => {
    const header = ["LOAD#", "PICK UP", "DELIVERY"];
    const mapping: SheetMapping = { loadRef: "LOAD#", pickup: "PICK UP", delivery: "DELIVERY" };
    const rows: RawRow[] = [{ rowIndex: 2, cells: ["L1", "", ""] }];
    expect(suggestRowsPerLoad(rows, header, mapping)).toBe(1);
  });

  it("exactly one real pair among several loads is not enough (pairs must be at least 2 and at least half the loads)", () => {
    const header = ["LOAD#", "PICK UP", "DELIVERY"];
    const mapping: SheetMapping = { loadRef: "LOAD#", pickup: "PICK UP", delivery: "DELIVERY" };
    const rows: RawRow[] = [
      { rowIndex: 2, cells: ["L1", "A", "B"] },
      { rowIndex: 3, cells: ["L2", "", ""] }, // one real pair
      { rowIndex: 4, cells: ["L3", "C", "D"] },
      { rowIndex: 5, cells: ["L4", "E", "F"] },
    ];
    expect(suggestRowsPerLoad(rows, header, mapping)).toBe(1);
  });
});
