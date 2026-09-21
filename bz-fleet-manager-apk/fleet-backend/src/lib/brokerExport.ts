import * as XLSX from "xlsx";
import type { BoardColumn } from "./boardLayout.js";
import type { CellsByKey } from "./brokerSheet.js";

// Their board, back out as their file: header labels in their order, two
// rows per load, a blank row between — the same shape the import reads.
// The AGENT column is ours and never exported.

export interface BoardLoadRow {
  id: string;
  top: CellsByKey;
  bottom: CellsByKey | null;
  status: string;
  boardLine: number | null;
}

export function renderBoardRows(layout: BoardColumn[], loads: BoardLoadRow[]): string[][] {
  const columns = layout.filter((c) => c.key !== "agent");
  const cell = (cells: CellsByKey | null, c: BoardColumn): string => (cells ? (cells[c.key] ?? "") : "");
  const rows: string[][] = [columns.map((c) => c.label)];
  for (const l of loads) {
    rows.push(columns.map((c) => cell(l.top, c)));
    if (l.bottom) rows.push(columns.map((c) => cell(l.bottom, c)));
    rows.push(columns.map(() => ""));
  }
  return rows;
}

export function boardWorkbook(rows: string[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Board");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
