import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { proposeLayout } from "../src/lib/boardLayout.js";
import { looksLikeUrl, pairRows, parseMoney, parseSheetDate, readWorkbook } from "../src/lib/brokerSheet.js";
import { BROKER_ROWS, THEIR_HEADER, brokerWorkbook, multiSheetWorkbook } from "./fixtures/brokerBoard.js";

describe("readWorkbook", () => {
  it("finds the header row under a title row and renders every cell as text", () => {
    const wb = readWorkbook(brokerWorkbook());
    expect(wb.header).toEqual(THEIR_HEADER);
    expect(wb.headerLine).toBe(2);
    expect(wb.rows[0].line).toBe(3);
    expect(wb.rows[0].cells[0]).toBe("0500001");
    expect(wb.rows[0].cells[8]).toBe("$4,000.00");
  });

  it("renders a real Excel date cell as YYYY-MM-DD", () => {
    const rows = BROKER_ROWS.map((r) => [...r]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.sheet_add_aoa(ws, [[new Date(Date.UTC(2026, 6, 13))]], { origin: "N3" });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Board");
    const out = readWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(out.rows[0].cells[13]).toBe("2026-07-13");
  });

  it("refuses a workbook with no recognizable header", () => {
    expect(() => readWorkbook(brokerWorkbook([["a", "b"], ["1", "2"]]))).toThrow(/header row/);
  });
});

describe("pairRows", () => {
  const { columns } = proposeLayout(THEIR_HEADER);
  it("pairs a customer row with the carrier row under it, skipping blanks", () => {
    const { pairs, notes } = pairRows(readWorkbook(brokerWorkbook()).rows, columns);
    expect(pairs).toHaveLength(5);
    expect(pairs[0].line).toBe(3);
    expect(pairs[0].top.bol).toBe("0500001");
    expect(pairs[0].top.phone).toMatch(/^https:/);
    expect(pairs[0].top.loadNo).toBe("2026-34566-00");
    expect(pairs[0].top.appt).toBe("PU: 07/13 - 13:00");
    expect(pairs[0].bottom?.customer).toBe("BLUE ROAD LLC");
    expect(pairs[0].bottom?.phone).toBe("(555) 010-0104");
    expect(pairs[0].bottom?.contact).toBe("Contact A");
    expect(pairs[0].bottom?.mc).toBe("1000001");
    expect(pairs[0].bottom?.loadNo).toBe("145205");
    expect(pairs[0].bottom?.appt).toBe("DEL: 07/15 - 11:00");
    expect(notes).toEqual([]);
  });

  it("keeps a top row with no carrier as an unassigned load", () => {
    const { pairs } = pairRows(readWorkbook(brokerWorkbook()).rows, columns);
    expect(pairs[4].bottom).toBeNull();
    expect(pairs[4].top.loadNo).toBe("2026-35100-00");
  });

  it("notes a carrier row that has no customer row above it", () => {
    const rows = [THEIR_HEADER, ["", "LONELY CARRIER", "(555) 1", "X", "", "", "", "", "", "", "", "1", "9", "", "", ""]];
    const { pairs, notes } = pairRows(readWorkbook(brokerWorkbook(rows)).rows, columns);
    expect(pairs).toEqual([]);
    expect(notes).toEqual(["line 2: carrier row with no load above it"]);
  });

  it("keeps unknown columns as extras keyed by their header", () => {
    const header = [...THEIR_HEADER, "NOTES"];
    const rows = [header, [...BROKER_ROWS[2], "call before delivery"], [...BROKER_ROWS[3], ""]];
    const { pairs } = pairRows(readWorkbook(brokerWorkbook(rows)).rows, proposeLayout(header).columns);
    expect(pairs[0].extras).toEqual({ NOTES: "call before delivery" });
  });
});

describe("cell parsers", () => {
  it("reads money as cents", () => {
    expect(parseMoney("$4,000.00")).toBe(400000);
    expect(parseMoney("4000")).toBe(400000);
    expect(parseMoney("$3,600.5")).toBe(360050);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("tbd")).toBeNull();
  });
  it("tells a share link from a phone number", () => {
    expect(looksLikeUrl("https://cloud.example.com/o/1/fleet/viewer/x")).toBe(true);
    expect(looksLikeUrl("share.example.com/en-US/#/share/v/a8aa")).toBe(true);
    expect(looksLikeUrl("(555) 010-0104")).toBe(false);
  });
  it("reads a sheet date in either form", () => {
    expect(parseSheetDate("7/13/2026")?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(parseSheetDate("2026-07-13")?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("soon")).toBeNull();
  });
});

// C1: a broker's board is a multi-tab file — a summary tab, a month per tab,
// an archive. Reading only the first sheet means their real file does not
// import at all.
describe("readWorkbook across sheets", () => {
  it("skips a summary tab and reads the first sheet that has a header row", () => {
    const wb = readWorkbook(multiSheetWorkbook([["Summary", [["Month", "Total"], ["July", "5"]]], ["July", BROKER_ROWS]]));
    expect(wb.sheetName).toBe("July");
    expect(wb.header).toEqual(THEIR_HEADER);
    expect(wb.rows[0].cells[0]).toBe("0500001");
    expect(wb.notes).toEqual([]);
  });

  it("names the other boards it did not import when more than one sheet has a header row", () => {
    const wb = readWorkbook(multiSheetWorkbook([["June", BROKER_ROWS.slice(0, 4)], ["July", BROKER_ROWS]]));
    expect(wb.sheetName).toBe("June");
    expect(wb.notes).toEqual(["also found a board on sheet 'July' — only 'June' was imported"]);
  });

  it("refuses a workbook where no sheet has a header row, naming the sheets it tried", () => {
    expect(() => readWorkbook(multiSheetWorkbook([["Summary", [["a", "b"], ["1", "2"]]], ["Archive", [["x"]]]])))
      .toThrow(/no header row found in any sheet \(Summary, Archive\)/);
  });
});

// I4: RATE is the one column that lands on a carrier row by typo. A row with
// only a RATE is never a new load — treating it as one manufactured a phantom
// load and stripped the real load's carrier.
describe("pairRows and a stray RATE", () => {
  const { columns } = proposeLayout(THEIR_HEADER);

  it("keeps a carrier row that carries a RATE as the bottom row, and says the RATE was ignored", () => {
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[3][8] = "$3,600.00"; // the carrier's rate typed on the carrier row
    const { pairs, notes } = pairRows(readWorkbook(brokerWorkbook(rows)).rows, columns);
    expect(pairs).toHaveLength(5);
    expect(pairs[0].bottom?.customer).toBe("BLUE ROAD LLC");
    expect(pairs[0].bottom?.phone).toBe("(555) 010-0104");
    expect(notes).toContain("line 4: RATE on a carrier row — ignored");
  });

  it("takes a row with a SHIP DATE but no BOL# as a new load", () => {
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[2][0] = "";
    const { pairs } = pairRows(readWorkbook(brokerWorkbook(rows)).rows, columns);
    expect(pairs).toHaveLength(5);
    expect(pairs[0].top.shipDate).toBe("7/13/2026");
    expect(pairs[0].bottom?.customer).toBe("BLUE ROAD LLC");
  });
});
