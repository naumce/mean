import { google, type sheets_v4 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { AgentColumnNames, CellWrite, RawRow, SheetConnector, SheetRead, SpreadsheetInfo, TabRef } from "./connector.js";
import { digestOf } from "./digest.js";

/** Spec pill colours (RGB, 0..1) for the status column's conditional
 *  formatting. The exact values are this connector's own choice. */
export const PILL_COLORS = {
  grey: { red: 0.62, green: 0.64, blue: 0.67 },
  green: { red: 0.2, green: 0.66, blue: 0.33 },
  amber: { red: 0.95, green: 0.64, blue: 0.11 },
  red: { red: 0.86, green: 0.21, blue: 0.21 },
  blue: { red: 0.16, green: 0.44, blue: 0.87 },
} as const;

/** One conditional-format rule per status prefix (final fix wave, C2): a
 *  `TEXT_STARTS_WITH` condition takes exactly ONE value — Sheets does not
 *  OR a list of values for it — so every prefix gets its own rule, nine in
 *  all, colour shared by state family. */
const STATUS_COLOR_RULES: { prefix: string; color: typeof PILL_COLORS[keyof typeof PILL_COLORS] }[] = [
  { prefix: "● WATCHING", color: PILL_COLORS.green },
  { prefix: "● DELIVERED", color: PILL_COLORS.green },
  { prefix: "● ASKED", color: PILL_COLORS.amber },
  { prefix: "● CALLING", color: PILL_COLORS.amber },
  { prefix: "● ESCALATED", color: PILL_COLORS.red },
  { prefix: "● ATTENTION", color: PILL_COLORS.red },
  { prefix: "● SHADOW", color: PILL_COLORS.blue },
  { prefix: "● HELD", color: PILL_COLORS.blue },
  { prefix: "● OFF", color: PILL_COLORS.grey },
];

/** 0-based column index -> A1 letters. 0 -> "A", 26 -> "AA". */
export function colToA1(n: number): string {
  let s = "";
  let num = n + 1;
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

/** A1 range syntax requires a single quote inside a sheet name to be doubled
 *  (`Driver's Loads` -> `'Driver''s Loads'`) — an un-doubled `'` breaks the
 *  range string Google parses. */
export function a1Sheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

const isBlankRow = (row: string[]): boolean => row.every((cell) => !cell);

const padRow = (row: string[], width: number): string[] =>
  row.length >= width ? row : [...row, ...Array(width - row.length).fill("")];

/** `SheetConnector` backed by Google Sheets alone: `spreadsheets.get` for
 *  the title/tabs, `values.get` for reads (and the content digest that is
 *  the version), `values.batchUpdate`/`spreadsheets.batchUpdate` for writes. */
export class GoogleSheetsConnector implements SheetConnector {
  private readonly sheets: sheets_v4.Sheets;
  private readonly tabTitleCache = new Map<string, Map<string, string>>();

  constructor(auth: OAuth2Client) {
    this.sheets = google.sheets({ version: "v4", auth });
  }

  /** One `spreadsheets.get` for the title and the tabs (works on any sheet
   *  the account can open under the `spreadsheets` scope). */
  async spreadsheetInfo(spreadsheetId: string): Promise<SpreadsheetInfo> {
    const res = await this.sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties" });
    const tabs: SpreadsheetInfo["tabs"] = [];
    for (const sheet of res.data.sheets ?? []) {
      const props = sheet.properties;
      if (props?.sheetId != null && props.title) tabs.push({ id: String(props.sheetId), title: props.title });
    }
    this.tabTitleCache.set(spreadsheetId, new Map(tabs.map((t) => [t.id, t.title])));
    return { title: res.data.properties?.title ?? "", tabs };
  }

  private async tabTitles(spreadsheetId: string): Promise<Map<string, string>> {
    const cached = this.tabTitleCache.get(spreadsheetId);
    if (cached) return cached;
    await this.spreadsheetInfo(spreadsheetId);
    return this.tabTitleCache.get(spreadsheetId) ?? new Map();
  }

  private async tabTitle(ref: TabRef): Promise<string> {
    const map = await this.tabTitles(ref.spreadsheetId);
    const title = map.get(ref.tabId);
    if (!title) throw new Error(`GoogleSheetsConnector: no tab ${ref.tabId} on ${ref.spreadsheetId}`);
    return title;
  }

  async readHeader(ref: TabRef, headerRow: number): Promise<string[]> {
    const title = await this.tabTitle(ref);
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: ref.spreadsheetId,
      range: `${a1Sheet(title)}!A${headerRow}:ZZ${headerRow}`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    return (res.data.values?.[0] ?? []).map((cell) => String(cell ?? ""));
  }

  /** ONE `values.get` from the header row down; the header is split off
   *  the top of the answer (its width pads the rows). The digest (Task 1,
   *  `digestOf`) is taken over `[header, ...rows]` AS RETURNED — padded,
   *  blank rows already dropped — never the raw `values.get` answer, so the
   *  sync layer can reproduce it ahead of a write with `predictedVersion`. A
   *  tick — changed or not — therefore costs exactly one values call and no
   *  metadata call. */
  async readRows(ref: TabRef, headerRow: number, sinceVersion?: string): Promise<SheetRead> {
    const title = await this.tabTitle(ref);
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: ref.spreadsheetId,
      range: `${a1Sheet(title)}!A${headerRow}:ZZ`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const values = res.data.values ?? [];
    const [headerRaw, ...body] = values;
    const header = (headerRaw ?? []).map((cell) => String(cell ?? ""));
    const width = header.length;
    const rows: RawRow[] = [];
    body.forEach((raw, i) => {
      const cells = (raw ?? []).map((cell) => String(cell ?? ""));
      if (isBlankRow(cells)) return;
      rows.push({ rowIndex: headerRow + 1 + i, cells: padRow(cells, width) });
    });
    const version = digestOf([header, ...rows.map((r) => r.cells)]);
    return { header, rows, version, changed: sinceVersion === undefined || sinceVersion !== version };
  }

  async writeCells(ref: TabRef, writes: CellWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const title = await this.tabTitle(ref);
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ref.spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: writes.map((w) => ({
          range: `${a1Sheet(title)}!${colToA1(w.col)}${w.rowIndex}`,
          values: [[w.value]],
        })),
      },
    });
    const noteWrites = writes.filter((w) => w.note !== undefined);
    if (noteWrites.length > 0) {
      const sheetId = Number(ref.tabId);
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: ref.spreadsheetId,
        requestBody: {
          requests: noteWrites.map((w) => ({
            updateCells: {
              range: {
                sheetId,
                startRowIndex: w.rowIndex - 1,
                endRowIndex: w.rowIndex,
                startColumnIndex: w.col,
                endColumnIndex: w.col + 1,
              },
              rows: [{ values: [{ note: w.note }] }],
              fields: "note",
            },
          })),
        },
      });
    }
  }

  async ensureAgentColumns(
    ref: TabRef,
    headerRow: number,
    names: AgentColumnNames,
    policyNames: string[]
  ): Promise<{ switch: number; status: number }> {
    const header = await this.readHeader(ref, headerRow);
    const existingSwitchCol = header.indexOf(names.switch);
    const existingStatusCol = header.indexOf(names.status);

    // Each column is reused independently when already present; only a
    // missing one is appended, and appended ones land after whatever is
    // already there (matching FakeConnector's per-column behaviour).
    let nextCol = header.length;
    const switchCol = existingSwitchCol !== -1 ? existingSwitchCol : nextCol++;
    const statusCol = existingStatusCol !== -1 ? existingStatusCol : nextCol++;
    const sheetId = Number(ref.tabId);
    const appendedCount = nextCol - header.length;

    const headerWrites: { col: number; value: string }[] = [];
    if (existingSwitchCol === -1) headerWrites.push({ col: switchCol, value: names.switch });
    if (existingStatusCol === -1) headerWrites.push({ col: statusCol, value: names.status });

    const requests: sheets_v4.Schema$Request[] = [];
    if (appendedCount > 0) {
      requests.push({ appendDimension: { sheetId, dimension: "COLUMNS", length: appendedCount } });
    }
    for (const write of headerWrites) {
      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: headerRow - 1,
            endRowIndex: headerRow,
            startColumnIndex: write.col,
            endColumnIndex: write.col + 1,
          },
          rows: [{ values: [{ userEnteredValue: { stringValue: write.value } }] }],
          fields: "userEnteredValue",
        },
      });
    }
    // The dropdown's list of policy names can grow over time, so this is
    // re-sent on every call — even when the switch column already existed —
    // while conditional formatting (below) is only ever installed once.
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: headerRow,
          startColumnIndex: switchCol,
          endColumnIndex: switchCol + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: ["OFF", ...policyNames].map((v) => ({ userEnteredValue: v })),
          },
          showCustomUi: true,
        },
      },
    });
    if (existingStatusCol === -1) {
      requests.push(
        ...STATUS_COLOR_RULES.map((rule) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: headerRow,
                  startColumnIndex: statusCol,
                  endColumnIndex: statusCol + 1,
                },
              ],
              booleanRule: {
                condition: {
                  type: "TEXT_STARTS_WITH",
                  values: [{ userEnteredValue: rule.prefix }],
                },
                format: { backgroundColor: rule.color },
              },
            },
            index: 0,
          },
        }))
      );
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: ref.spreadsheetId,
      requestBody: { requests },
    });

    return { switch: switchCol, status: statusCol };
  }
}
