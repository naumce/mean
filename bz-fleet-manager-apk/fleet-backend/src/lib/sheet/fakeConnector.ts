import type { AgentColumnNames, CellWrite, RawRow, SheetConnector, SheetRead, SpreadsheetInfo, TabRef } from "./connector.js";
import { digestOf } from "./digest.js";

export interface FakeTabSeed {
  title: string;
  grid: string[][];
  notes?: Record<string, string>;
}

export interface FakeSpreadsheetSeed {
  title: string;
  tabs: Record<string, FakeTabSeed>;
}

export type FakeConnectorSeed = Record<string, FakeSpreadsheetSeed>;

interface FakeTabState {
  title: string;
  grid: string[][];
  notes: Record<string, string>;
  validations: Record<number, string[]>;
}

interface FakeSpreadsheetState {
  title: string;
  tabs: Record<string, FakeTabState>;
}

const noteKey = (rowIndex: number, col: number): string => `${rowIndex}:${col}`;

const isBlankRow = (row: string[]): boolean => row.every((cell) => cell === "" || cell == null);

const padRow = (row: string[], width: number): string[] => {
  if (row.length >= width) return row.slice(0, Math.max(row.length, width));
  return [...row, ...Array(width - row.length).fill("")];
};

/** In-memory `SheetConnector`, seeded with grids the tests control directly.
 *  Copies on every read so callers can never mutate internal state. The
 *  version is `digestOf([header, ...rows])` — the same rule
 *  `GoogleSheetsConnector.readRows` uses (Task 1's `digest.ts`) — so a write
 *  that changes a cell changes the version, an identical grid never does,
 *  and the sync layer's predicted post-write version matches either
 *  connector alike. */
export class FakeConnector implements SheetConnector {
  private readonly spreadsheets: Record<string, FakeSpreadsheetState>;

  constructor(seed: FakeConnectorSeed) {
    this.spreadsheets = Object.fromEntries(
      Object.entries(seed).map(([spreadsheetId, sheet]) => [
        spreadsheetId,
        {
          title: sheet.title,
          tabs: Object.fromEntries(
            Object.entries(sheet.tabs).map(([tabId, tab]) => [
              tabId,
              {
                title: tab.title,
                grid: tab.grid.map((row) => [...row]),
                notes: { ...(tab.notes ?? {}) },
                validations: {},
              },
            ])
          ),
        },
      ])
    );
  }

  private tab(ref: TabRef): FakeTabState {
    const sheet = this.spreadsheets[ref.spreadsheetId];
    if (!sheet) throw new Error(`FakeConnector: no spreadsheet ${ref.spreadsheetId}`);
    const tab = sheet.tabs[ref.tabId];
    if (!tab) throw new Error(`FakeConnector: no tab ${ref.tabId} on ${ref.spreadsheetId}`);
    return tab;
  }

  /** Assertion helper: a copy of the tab's current grid. */
  grid(ref: TabRef): string[][] {
    return this.tab(ref).grid.map((row) => [...row]);
  }

  /** Assertion helper: a copy of the tab's notes, keyed `"rowIndex:col"`. */
  notes(ref: TabRef): Record<string, string> {
    return { ...this.tab(ref).notes };
  }

  /** Assertion helper: the dropdown list recorded for a data-validated column. */
  validation(ref: TabRef, col: number): string[] {
    return [...(this.tab(ref).validations[col] ?? [])];
  }

  async spreadsheetInfo(spreadsheetId: string): Promise<SpreadsheetInfo> {
    const sheet = this.spreadsheets[spreadsheetId];
    if (!sheet) throw new Error(`FakeConnector: no spreadsheet ${spreadsheetId}`);
    return { title: sheet.title, tabs: Object.entries(sheet.tabs).map(([id, t]) => ({ id, title: t.title })) };
  }

  async readHeader(ref: TabRef, headerRow: number): Promise<string[]> {
    const tab = this.tab(ref);
    return [...(tab.grid[headerRow - 1] ?? [])];
  }

  async readRows(ref: TabRef, headerRow: number, sinceVersion?: string): Promise<SheetRead> {
    const tab = this.tab(ref);
    const header = [...(tab.grid[headerRow - 1] ?? [])];
    const width = header.length;
    const rows: RawRow[] = [];
    for (let i = headerRow; i < tab.grid.length; i++) {
      const row = tab.grid[i];
      if (isBlankRow(row)) continue;
      rows.push({ rowIndex: i + 1, cells: padRow([...row], width) });
    }
    const version = digestOf([header, ...rows.map((r) => r.cells)]);
    return { header, rows, version, changed: sinceVersion === undefined || sinceVersion !== version };
  }

  async writeCells(ref: TabRef, writes: CellWrite[]): Promise<void> {
    const tab = this.tab(ref);
    for (const write of writes) {
      const rowPos = write.rowIndex - 1;
      while (tab.grid.length <= rowPos) tab.grid.push([]);
      const row = tab.grid[rowPos];
      while (row.length <= write.col) row.push("");
      row[write.col] = write.value;
      if (write.note !== undefined) {
        tab.notes[noteKey(write.rowIndex, write.col)] = write.note;
      }
    }
  }

  async ensureAgentColumns(
    ref: TabRef,
    headerRow: number,
    names: AgentColumnNames,
    policyNames: string[]
  ): Promise<{ switch: number; status: number }> {
    const tab = this.tab(ref);
    const header = tab.grid[headerRow - 1] ?? [];
    let switchCol = header.indexOf(names.switch);
    if (switchCol === -1) {
      switchCol = header.length;
      header[switchCol] = names.switch;
    }
    let statusCol = header.indexOf(names.status);
    if (statusCol === -1) {
      statusCol = header.length;
      header[statusCol] = names.status;
    }
    tab.grid[headerRow - 1] = header;
    tab.validations[switchCol] = ["OFF", ...policyNames];
    return { switch: switchCol, status: statusCol };
  }
}
