/** Pure spreadsheet I/O contract. Nothing in this file (or this folder) knows
 *  about thresholds, rungs, classifications or phone numbers — that belongs
 *  to the agent layer built on top of `SheetConnector`. */

export interface TabRef {
  spreadsheetId: string;
  tabId: string;
}

/** `rowIndex` is 1-based: the sheet's own row number. */
export interface RawRow {
  rowIndex: number;
  cells: string[];
}

/** `col` is 0-based. */
export interface CellWrite {
  rowIndex: number;
  col: number;
  value: string;
  note?: string;
}

export interface SheetRead {
  header: string[];
  rows: RawRow[];
  version: string;
  changed: boolean;
}

export interface AgentColumnNames {
  switch: string;
  status: string;
}

export class NotImplemented extends Error {}

/** What a spreadsheet says about itself: its own title and its tabs. This
 *  is the only "browse" call a connector offers — there is no listing of
 *  the account's spreadsheets (final fix wave, C1: the Drive API is gone;
 *  the dispatcher pastes the sheet's link and the `spreadsheets` scope is
 *  enough to open any sheet the account can read). */
export interface SpreadsheetInfo {
  title: string;
  tabs: { id: string; title: string }[];
}

export interface SheetConnector {
  spreadsheetInfo(spreadsheetId: string): Promise<SpreadsheetInfo>;
  readHeader(ref: TabRef, headerRow: number): Promise<string[]>;
  /** ONE read from the header row down. `header` is the header row itself
   *  and `rows` every non-blank row under it (padded to the header's width),
   *  both returned on every call — the values were fetched anyway, and the
   *  caller compares its intended status cells against `rows` even on an
   *  unchanged tick. `version` is a digest of those contents, never a
   *  metadata revision — so a connector's own writes to the status column
   *  are what they are: a change. `changed` is `version !== sinceVersion`. */
  readRows(
    ref: TabRef,
    headerRow: number,
    sinceVersion?: string
  ): Promise<SheetRead>;
  writeCells(ref: TabRef, writes: CellWrite[]): Promise<void>;
  ensureAgentColumns(
    ref: TabRef,
    headerRow: number,
    names: AgentColumnNames,
    policyNames: string[]
  ): Promise<{ switch: number; status: number }>;
}
