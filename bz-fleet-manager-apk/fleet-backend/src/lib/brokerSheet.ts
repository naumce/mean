import * as XLSX from "xlsx";
import { normalizeHeader, type BoardColumn, type BoardColumnKey } from "./boardLayout.js";

// A broker's board as it comes off the disk: a header row somewhere near the
// top of one of the workbook's sheets, two rows per load with blank rows
// between. This turns it into row pairs keyed by our column keys and leaves
// every cell as the text the dispatcher typed. Parsing of money, dates and
// appointments is separate and never rewrites a cell.

export interface SheetRow { line: number; cells: string[] }
export type CellsByKey = Partial<Record<BoardColumnKey, string>>;
export interface RawLoadPair {
  /** 1-based line of the customer row in the sheet. */
  line: number;
  top: CellsByKey;
  bottom: CellsByKey | null;
  /** Columns we do not know, keyed by the sheet's own header. */
  extras: Record<string, string>;
}

export interface Workbook {
  /** The sheet the board was read from; a real file has several. */
  sheetName: string;
  header: string[];
  headerLine: number;
  rows: SheetRow[];
  /** Workbook-level notes — e.g. another tab that also looks like a board. */
  notes: string[];
}

const HEADER_HINTS = ["bol", "customer", "pick up", "pickup", "delivery", "rate", "load"];

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

/** 0-based index of the row that looks like their header, or -1. */
function headerIndex(lines: string[][]): number {
  return lines.findIndex((r) => {
    const norms = r.map(normalizeHeader);
    return HEADER_HINTS.filter((h) => norms.some((n) => n === h || n.startsWith(h + " ") || n.includes(" " + h))).length >= 3;
  });
}

export function readWorkbook(buf: Buffer): Workbook {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  if (!wb.SheetNames.length) throw new Error("the workbook has no sheets");
  // Their file is multi-tab by nature (a summary, a month per tab, an
  // archive). Read the first tab that actually holds a board and name the
  // others, rather than failing on a summary tab or importing one silently.
  const boards: Array<{ name: string; lines: string[][]; headerIdx: number }> = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    const lines = grid.map((r) => (r as unknown[]).map(cellText));
    const headerIdx = headerIndex(lines);
    if (headerIdx >= 0) boards.push({ name, lines, headerIdx });
  }
  if (!boards.length) {
    throw new Error(`no header row found in any sheet (${wb.SheetNames.join(", ")}) — expected BOL#, CUSTOMER, PICK UP, DELIVERY, RATE, LOAD# in one row near the top`);
  }
  const [chosen, ...others] = boards;
  const notes = others.length
    ? [`also found a board on sheet ${others.map((o) => `'${o.name}'`).join(", ")} — only '${chosen.name}' was imported`]
    : [];
  const header = chosen.lines[chosen.headerIdx].map((h) => h.trim());
  const width = header.length;
  const rows: SheetRow[] = chosen.lines.slice(chosen.headerIdx + 1).map((cells, i) => ({
    line: chosen.headerIdx + 2 + i,
    cells: Array.from({ length: width }, (_, c) => cells[c] ?? ""),
  }));
  return { sheetName: chosen.name, header, headerLine: chosen.headerIdx + 1, rows, notes };
}

const isBlank = (r: SheetRow): boolean => r.cells.every((c) => c === "");

function byKey(cells: string[], columns: BoardColumn[]): { known: CellsByKey; extras: Record<string, string> } {
  const known: CellsByKey = {};
  const extras: Record<string, string> = {};
  columns.forEach((col, i) => {
    const v = cells[i] ?? "";
    if (col.key === "agent") return;
    if (col.key === "extra") { if (v) extras[col.source ?? col.label] = v; return; }
    known[col.key] = v;
  });
  return { known, extras };
}

// A load's top row always carries something only a load has: a BOL#, a
// pick-up or delivery city, or a ship date. RATE is deliberately not in this
// list — it is the one column a dispatcher mistypes onto the carrier row, and
// treating that row as a new load split one load into two and left the real
// one carrier-less.
const looksTop = (k: CellsByKey): boolean => Boolean(k.bol) || Boolean(k.pickupCity) || Boolean(k.deliveryCity) || Boolean(k.shipDate);

export function pairRows(rows: SheetRow[], columns: BoardColumn[]): { pairs: RawLoadPair[]; notes: string[] } {
  const pairs: RawLoadPair[] = [];
  const notes: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (isBlank(row)) { i += 1; continue; }
    const { known, extras } = byKey(row.cells, columns);
    if (!looksTop(known)) { notes.push(`line ${row.line}: carrier row with no load above it`); i += 1; continue; }
    let bottom: CellsByKey | null = null;
    const next = rows[i + 1];
    if (next && !isBlank(next)) {
      const nb = byKey(next.cells, columns);
      if (!looksTop(nb.known)) {
        bottom = nb.known;
        Object.assign(extras, nb.extras);
        if (nb.known.rate) notes.push(`line ${next.line}: RATE on a carrier row — ignored`);
        i += 1;
      }
    }
    pairs.push({ line: row.line, top: known, bottom, extras });
    i += 1;
  }
  return { pairs, notes };
}

export function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (!cleaned || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}\/)/i.test(s.trim());
}

export function parseSheetDate(s: string): Date | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2]))); }
  return null;
}
