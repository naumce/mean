import { vi, describe, it, expect } from "vitest";
import { MockGoogleBackend, buildGoogleapisMock } from "./googleapis.mockBackend.js";

const state = vi.hoisted(() => ({ backend: undefined as MockGoogleBackend | undefined }));

vi.mock("googleapis", async () => {
  const { buildGoogleapisMock } = await import("./googleapis.mockBackend.js");
  return buildGoogleapisMock(() => {
    if (!state.backend) throw new Error("mock backend not seeded yet");
    return state.backend;
  });
});

const { google } = await import("googleapis");
const { GoogleSheetsConnector, colToA1 } = await import("../../src/lib/sheet/googleConnector.js");
const { connectorSuite, partialAgentColumnsSuite } = await import("./connector.suite.js");
type TabRefType = import("../../src/lib/sheet/connector.js").TabRef;

const ref: TabRefType = { spreadsheetId: "s1", tabId: "0" };

function seed(): MockGoogleBackend {
  const b = new MockGoogleBackend();
  b.addSpreadsheet("s1", "Loads");
  b.addTab("s1", "0", "Sheet1", [
    ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"],
    ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/22 08:00"],
    ["145220", "+15557654321", "Tulsa, OK", "Boise, ID", "09/23 14:00"],
  ]);
  return b;
}

/** Header already carries the switch column but not the status column. */
function seedWithPartialAgentColumns(): MockGoogleBackend {
  const b = new MockGoogleBackend();
  b.addSpreadsheet("s1", "Loads");
  b.addTab("s1", "0", "Sheet1", [
    ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT", "Night Shift"],
    ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/22 08:00", "OFF"],
    ["145220", "+15557654321", "Tulsa, OK", "Boise, ID", "09/23 14:00", "OFF"],
  ]);
  return b;
}

/** A tab titled with an embedded apostrophe, to prove A1 ranges escape it. */
function seedWithQuoteInTitle(): MockGoogleBackend {
  const b = new MockGoogleBackend();
  b.addSpreadsheet("s2", "Loads 2");
  b.addTab("s2", "0", "Driver's Loads", [
    ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"],
    ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/22 08:00"],
  ]);
  return b;
}

function lastClientOf(factory: unknown) {
  return (factory as { mock: { results: { value: any }[] } }).mock.results.at(-1)!.value;
}

describe("GoogleSheetsConnector", () => {
  connectorSuite(async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    return { c, ref };
  });

  partialAgentColumnsSuite(async () => {
    state.backend = seedWithPartialAgentColumns();
    const c = new GoogleSheetsConnector({} as any);
    return { c, ref };
  });

  it("colToA1 converts 0-based column indices to A1 letters", () => {
    expect(colToA1(0)).toBe("A");
    expect(colToA1(25)).toBe("Z");
    expect(colToA1(26)).toBe("AA");
  });

  it("readHeader requests the header row with a wide, quoted A1 range", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    await c.readHeader(ref, 1);
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: "s1", range: "'Sheet1'!A1:ZZ1" })
    );
  });

  it("doubles a single quote in the tab title for every A1 range it sends", async () => {
    state.backend = seedWithQuoteInTitle();
    const quoteRef: TabRefType = { spreadsheetId: "s2", tabId: "0" };
    const c = new GoogleSheetsConnector({} as any);

    await c.readHeader(quoteRef, 1);
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: "s2", range: "'Driver''s Loads'!A1:ZZ1" })
    );

    await c.readRows(quoteRef, 1);
    expect(sheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: "s2", range: "'Driver''s Loads'!A1:ZZ" })
    );

    await c.writeCells(quoteRef, [{ rowIndex: 2, col: 0, value: "999999" }]);
    expect(sheetsClient.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "s2",
      requestBody: { valueInputOption: "RAW", data: [{ range: "'Driver''s Loads'!A2", values: [["999999"]] }] },
    });
  });

  // Final fix wave, C1: no Drive API. The version is a sha256 of the
  // values.get answer, and a changed tick costs exactly ONE values call —
  // header and rows come back together from `A{headerRow}:ZZ`.
  it("readRows makes one values.get from the header row down, and its version is a digest of the values", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    const first = await c.readRows(ref, 1);
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.values.get).toHaveBeenCalledTimes(1);
    expect(sheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: "s1", range: "'Sheet1'!A1:ZZ" })
    );
    expect(first.rows.map((r) => r.rowIndex)).toEqual([2, 3]);
    expect(first.rows[0].cells).toHaveLength(5);
    expect(first.version).toMatch(/^[0-9a-f]{64}$/);
    expect((google as any).drive).toBeUndefined();

    // Same contents -> same digest -> changed=false (still one values call
    // per read: there is no cheaper metadata call to make first).
    const second = await c.readRows(ref, 1, first.version);
    expect(second.changed).toBe(false);
    expect(second.rows).toEqual(first.rows);
    expect(sheetsClient.spreadsheets.values.get).toHaveBeenCalledTimes(2);

    // A cell edit changes the digest.
    await c.writeCells(ref, [{ rowIndex: 2, col: 2, value: "Fort Worth, TX" }]);
    const third = await c.readRows(ref, 1, first.version);
    expect(third.changed).toBe(true);
    expect(third.version).not.toBe(first.version);
  });

  it("writeCells sends one values.batchUpdate for values and one spreadsheets.batchUpdate for notes", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    await c.writeCells(ref, [{ rowIndex: 2, col: 4, value: "● SHADOW", note: "https://x/n/t/l1" }]);
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "s1",
      requestBody: { valueInputOption: "RAW", data: [{ range: "'Sheet1'!E2", values: [["● SHADOW"]] }] },
    });
    const noteCall = sheetsClient.spreadsheets.batchUpdate.mock.calls[0][0];
    expect(noteCall.requestBody.requests).toEqual([
      {
        updateCells: {
          range: { sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 4, endColumnIndex: 5 },
          rows: [{ values: [{ note: "https://x/n/t/l1" }] }],
          fields: "note",
        },
      },
    ]);
  });

  it("writeCells sends no note batchUpdate when no write carries a note", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    await c.writeCells(ref, [{ rowIndex: 2, col: 0, value: "999999" }]);
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  it("ensureAgentColumns sends one batchUpdate with appendDimension, setDataValidation and nine one-prefix conditional format rules", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard"]);
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);
    const requests = sheetsClient.spreadsheets.batchUpdate.mock.calls[0][0].requestBody.requests;

    expect(requests[0]).toEqual({ appendDimension: { sheetId: 0, dimension: "COLUMNS", length: 2 } });

    const validationReq = requests.find((r: any) => r.setDataValidation);
    expect(validationReq.setDataValidation.range).toEqual({ sheetId: 0, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 });
    expect(validationReq.setDataValidation.rule.condition.type).toBe("ONE_OF_LIST");
    expect(validationReq.setDataValidation.rule.condition.values).toEqual([
      { userEnteredValue: "OFF" },
      { userEnteredValue: "Standard" },
    ]);
    expect(validationReq.setDataValidation.rule.showCustomUi).toBe(true);

    // Final fix wave, C2: TEXT_STARTS_WITH takes exactly one value, so it
    // is one rule per prefix — nine of them — never a two-value list.
    const formatRules = requests.filter((r: any) => r.addConditionalFormatRule);
    expect(formatRules).toHaveLength(9);
    for (const rule of formatRules) {
      expect(rule.addConditionalFormatRule.rule.ranges[0]).toEqual({
        sheetId: 0,
        startRowIndex: 1,
        startColumnIndex: 6,
        endColumnIndex: 7,
      });
      expect(rule.addConditionalFormatRule.rule.booleanRule.condition.type).toBe("TEXT_STARTS_WITH");
      expect(rule.addConditionalFormatRule.rule.booleanRule.condition.values).toHaveLength(1);
    }
    const prefixes = formatRules.map((r: any) => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue);
    expect(prefixes.sort()).toEqual(
      ["● WATCHING", "● DELIVERED", "● ASKED", "● CALLING", "● ESCALATED", "● ATTENTION", "● SHADOW", "● HELD", "● OFF"].sort()
    );
  });

  it("ensureAgentColumns re-sends setDataValidation (for new policy names) but no appendDimension, header write, or conditional format once the columns already exist", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard"]);
    const sheetsClient = lastClientOf(google.sheets);
    await c.ensureAgentColumns(ref, 1, { switch: "Night Shift", status: "Night Shift status" }, ["Standard", "Hazmat"]);

    expect(sheetsClient.spreadsheets.batchUpdate).toHaveBeenCalledTimes(2);
    const secondRequests = sheetsClient.spreadsheets.batchUpdate.mock.calls[1][0].requestBody.requests;
    expect(secondRequests.some((r: any) => r.appendDimension)).toBe(false);
    expect(secondRequests.some((r: any) => r.updateCells)).toBe(false);
    expect(secondRequests.some((r: any) => r.addConditionalFormatRule)).toBe(false);
    expect(secondRequests).toEqual([
      {
        setDataValidation: {
          range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 },
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: [{ userEnteredValue: "OFF" }, { userEnteredValue: "Standard" }, { userEnteredValue: "Hazmat" }],
            },
            showCustomUi: true,
          },
        },
      },
    ]);
  });

  it("spreadsheetInfo asks spreadsheets.get for the title and tab properties only", async () => {
    state.backend = seed();
    const c = new GoogleSheetsConnector({} as any);
    const info = await c.spreadsheetInfo("s1");
    expect(info).toEqual({ title: "Loads", tabs: [{ id: "0", title: "Sheet1" }] });
    const sheetsClient = lastClientOf(google.sheets);
    expect(sheetsClient.spreadsheets.get).toHaveBeenCalledWith({ spreadsheetId: "s1", fields: "properties.title,sheets.properties" });
  });
});
