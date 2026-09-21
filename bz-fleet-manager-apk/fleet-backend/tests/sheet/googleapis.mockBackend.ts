import { vi } from "vitest";

/** In-memory backend shared by every mocked `sheets` client in a
 *  test (no `drive` client exists any more — final fix wave, C1). Mirrors the grid model `FakeConnector` uses so `connectorSuite`
 *  proves the same behaviour against the real request/response shapes
 *  `GoogleSheetsConnector` sends, without touching Google. */

export interface MockTab {
  title: string;
  grid: string[][];
  notes: Record<string, string>;
  validations: Record<number, { userEnteredValue: string }[]>;
  conditionalFormatRules: unknown[];
}

export interface MockSpreadsheet {
  name: string;
  version: number;
  tabs: Record<string, MockTab>;
}

export class MockGoogleBackend {
  spreadsheets: Record<string, MockSpreadsheet> = {};

  addSpreadsheet(id: string, name: string): void {
    this.spreadsheets[id] = { name, version: 1, tabs: {} };
  }

  addTab(spreadsheetId: string, sheetId: string, title: string, grid: string[][]): void {
    this.spreadsheets[spreadsheetId].tabs[sheetId] = {
      title,
      grid: grid.map((row) => [...row]),
      notes: {},
      validations: {},
      conditionalFormatRules: [],
    };
  }

  sheet(spreadsheetId: string): MockSpreadsheet {
    const s = this.spreadsheets[spreadsheetId];
    if (!s) throw new Error(`mock backend: no spreadsheet ${spreadsheetId}`);
    return s;
  }

  private parseRange(range: string): { sheetId: string; c0: number; r0: number; r1: number | null } {
    // "'title'!A1:ZZ1" or "'title'!A2:ZZ" or "'title'!E2"
    const m = /^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(range);
    if (!m) throw new Error(`mock backend: unparseable range ${range}`);
    const [, rawTitle, colStart, rowStart, , rowEnd] = m;
    // Undo A1's doubled-quote escaping ("Driver''s Loads" -> "Driver's Loads")
    // so this matches the tab title exactly as stored.
    const title = rawTitle.replace(/''/g, "'");
    return {
      sheetId: title,
      c0: colLetterToIndex(colStart),
      r0: Number(rowStart) - 1,
      r1: rowEnd ? Number(rowEnd) - 1 : null,
    };
  }

  valuesGet(spreadsheetId: string, range: string): string[][] {
    const sheet = this.sheet(spreadsheetId);
    const { sheetId: title, c0, r0, r1 } = this.parseRange(range);
    const tab = Object.values(sheet.tabs).find((t) => t.title === title);
    if (!tab) throw new Error(`mock backend: no tab titled ${title}`);
    const lastRow = r1 ?? tab.grid.length - 1;
    const rows: string[][] = [];
    for (let r = r0; r <= lastRow && r < tab.grid.length; r++) {
      rows.push(tab.grid[r].slice(c0));
    }
    return rows;
  }

  valuesBatchUpdate(spreadsheetId: string, data: { range: string; values: string[][] }[]): void {
    const sheet = this.sheet(spreadsheetId);
    for (const { range, values } of data) {
      const { sheetId: title, c0, r0 } = this.parseRange(range);
      const tab = Object.values(sheet.tabs).find((t) => t.title === title);
      if (!tab) throw new Error(`mock backend: no tab titled ${title}`);
      while (tab.grid.length <= r0) tab.grid.push([]);
      const row = tab.grid[r0];
      while (row.length <= c0) row.push("");
      row[c0] = values[0][0];
    }
    sheet.version += 1;
  }

  spreadsheetsBatchUpdate(spreadsheetId: string, requests: any[]): void {
    const sheet = this.sheet(spreadsheetId);
    for (const req of requests) {
      if (req.updateCells) {
        const { range, rows, fields } = req.updateCells;
        const tab = sheet.tabs[String(range.sheetId)];
        rows.forEach((rowObj: any, ri: number) => {
          const r = range.startRowIndex + ri;
          rowObj.values.forEach((cell: any, ci: number) => {
            const c = range.startColumnIndex + ci;
            while (tab.grid.length <= r) tab.grid.push([]);
            const row = tab.grid[r];
            while (row.length <= c) row.push("");
            if (String(fields).includes("userEnteredValue") && cell.userEnteredValue) {
              row[c] = cell.userEnteredValue.stringValue ?? "";
            }
            if (String(fields).includes("note") && cell.note !== undefined) {
              tab.notes[`${r + 1}:${c}`] = cell.note;
            }
          });
        });
      } else if (req.setDataValidation) {
        const { range, rule } = req.setDataValidation;
        const tab = sheet.tabs[String(range.sheetId)];
        tab.validations[range.startColumnIndex] = rule.condition.values;
      } else if (req.addConditionalFormatRule) {
        const sheetId = req.addConditionalFormatRule.rule.ranges[0].sheetId;
        const tab = sheet.tabs[String(sheetId)];
        tab.conditionalFormatRules.push(req.addConditionalFormatRule);
      }
      // appendDimension: intentionally a no-op — grid width grows lazily as
      // updateCells/values.batchUpdate write into new columns.
    }
    sheet.version += 1;
  }
}

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function buildGoogleapisMock(getBackend: () => MockGoogleBackend) {
  return {
    google: {
      sheets: vi.fn(() => ({
        spreadsheets: {
          get: vi.fn(async ({ spreadsheetId }: { spreadsheetId: string }) => {
            const sheet = getBackend().sheet(spreadsheetId);
            return {
              data: {
                properties: { title: sheet.name },
                sheets: Object.entries(sheet.tabs).map(([sheetId, tab]) => ({
                  properties: { sheetId: Number(sheetId) || sheetId, title: tab.title },
                })),
              },
            };
          }),
          batchUpdate: vi.fn(async ({ spreadsheetId, requestBody }: any) => {
            getBackend().spreadsheetsBatchUpdate(spreadsheetId, requestBody.requests);
            return { data: {} };
          }),
          values: {
            get: vi.fn(async ({ spreadsheetId, range }: any) => {
              const values = getBackend().valuesGet(spreadsheetId, range);
              return { data: { values } };
            }),
            batchUpdate: vi.fn(async ({ spreadsheetId, requestBody }: any) => {
              getBackend().valuesBatchUpdate(spreadsheetId, requestBody.data);
              return { data: {} };
            }),
          },
        },
      })),
      auth: { OAuth2: class {} },
    },
  };
}
