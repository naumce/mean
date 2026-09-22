// Two-rows-per-load sheets: the broker layout (tests/fixtures/brokerBoard.ts)
// writes each load as a customer row with the carrier row under it — BOL,
// customer, cities, rates and the order number on top; carrier name, carrier
// phone, contact, MC and the real LOAD# underneath; the two appointment lines
// split across both. This folds every such pair into ONE virtual `RawRow`
// (the top row's index, the top row's cells, overridden where the bottom row
// is the authority) so rowToPatch, the switch read, the status pass and the
// vanished-row pass go on reading "one row = one load" unchanged.
//
// `brokerSheet.ts`'s `pairRows`/`looksTop` is the board importer's version of
// the same idea, keyed by BoardColumnKey; this one is keyed by SheetColumnKey
// (a SheetMapping), so it is written here rather than imported. Nothing here
// knows about thresholds, rungs, classifications or phones.
import type { RawRow } from "./connector.js";
import type { SheetColumnKey, SheetMapping } from "./mapping.js";
import { AGENT_COLUMN_NAMES } from "./installColumns.js";

/** The synthetic header the top row's own LOAD# (the order number) moves to
 *  when the carrier row supplies the real LOAD#, so it lands in
 *  `Load.extras` and nothing is lost. */
export const ORDER_REF_HEADER = "ORDER REF";

export interface FoldResult {
  rows: RawRow[];
  /** The input header plus `ORDER REF` appended — what the folded rows'
   *  cells line up with. */
  header: string[];
  /** Slice 4, Task 2: keyed by a folded row's `rowIndex` (the TOP row's own
   *  sheet row number, same as what ends up in `Load.sheetRowIndex`), true
   *  when that virtual row consumed a bottom (carrier) row. The write-back
   *  pass uses this to decide whether a bottom-owned field (loadRef,
   *  driverPhone, carrierPhone, driverName, carrierName) is written to the
   *  top row or the one under it. */
  hasBottomByRow: Record<number, boolean>;
}

/** Columns whose cell lives on the carrier row: the bottom wins when it is
 *  non-blank. */
const BOTTOM_WINS: readonly SheetColumnKey[] = ["loadRef", "driverPhone", "carrierPhone", "driverName", "carrierName"];
/** Columns whose top and bottom cells are both part of the value. */
const JOINED: readonly SheetColumnKey[] = ["pickupAppt", "deliveryAppt"];

type Rule = "bottomWins" | "join" | "topOnly" | "topFills";

const blank = (cell: string | undefined): boolean => (cell ?? "").trim() === "";

/** Which fold rule each column index follows, from the mapping. Unmapped
 *  columns are "top wins, bottom fills a blank top" — except the two agent
 *  columns, which come from the top row alone: the bottom row's switch cell
 *  is ignored by design (the status cell is written on the top row). */
function rulesFor(header: string[], mapping: SheetMapping): Rule[] {
  const keyByHeader = new Map<string, SheetColumnKey[]>();
  for (const [key, h] of Object.entries(mapping) as [SheetColumnKey, string][]) {
    keyByHeader.set(h, [...(keyByHeader.get(h) ?? []), key]);
  }
  const agentNames: readonly string[] = [AGENT_COLUMN_NAMES.switch, AGENT_COLUMN_NAMES.status];
  return header.map((h): Rule => {
    const keys = keyByHeader.get(h) ?? [];
    if (keys.some((k) => JOINED.includes(k))) return "join";
    if (keys.some((k) => BOTTOM_WINS.includes(k))) return "bottomWins";
    if (agentNames.includes(h)) return "topOnly";
    return "topFills";
  });
}

function foldCell(rule: Rule, top: string | undefined, bottom: string | undefined): string {
  const t = top ?? "";
  const b = bottom ?? "";
  switch (rule) {
    case "bottomWins": return blank(b) ? t : b;
    case "join": return [t, b].filter((c) => !blank(c)).join("\n");
    case "topOnly": return t;
    case "topFills": return blank(t) ? b : t;
  }
}

/** A row's pickup AND delivery cells are both blank. Used only to decide
 *  whether the row immediately after a top is that top's bottom — a fold
 *  never drops a row, so this is never used to judge a row on its own. */
function bothBlank(row: RawRow, pickupCol: number, deliveryCol: number): boolean {
  return blank(row.cells[pickupCol]) && blank(row.cells[deliveryCol]);
}

/** ONE virtual row for a top and (optionally) the carrier row under it. The
 *  top's own LOAD# is preserved under `ORDER REF` when the bottom's LOAD#
 *  replaces it. */
function foldPair(top: RawRow, bottom: RawRow | null, rules: Rule[], loadRefCol: number): RawRow {
  const width = rules.length;
  const cells = Array.from({ length: width }, (_, i) => bottom === null
    ? (top.cells[i] ?? "")
    : foldCell(rules[i], top.cells[i], bottom.cells[i]));
  const topRef = loadRefCol === -1 ? "" : (top.cells[loadRefCol] ?? "");
  const bottomRef = loadRefCol === -1 || bottom === null ? "" : (bottom.cells[loadRefCol] ?? "");
  const orderRef = !blank(topRef) && !blank(bottomRef) ? topRef : "";
  return { rowIndex: top.rowIndex, cells: [...cells, orderRef] };
}

/** Folds `rows` (as `readRows` returns them: blank rows already gone) into
 *  one virtual row per load. The fold NEVER drops a row: a row is a bottom
 *  only when it directly follows a row consumed as a top IN THIS PASS and
 *  its pickup and delivery cells are both blank; every other row is a top
 *  (a lone top — including one whose own cities are blank, when nothing
 *  ahead of it claims it as a bottom — folds to itself). The returned
 *  `header` is `header` plus `ORDER REF`; every returned row is exactly
 *  that wide. Never mutates its input. */
export function foldPairs(rows: RawRow[], header: string[], mapping: SheetMapping): FoldResult {
  const col = (key: SheetColumnKey): number => (mapping[key] === undefined ? -1 : header.indexOf(mapping[key] as string));
  const pickupCol = col("pickup");
  const deliveryCol = col("delivery");
  const loadRefCol = col("loadRef");
  const rules = rulesFor(header, mapping);

  const folded: RawRow[] = [];
  const hasBottomByRow: Record<number, boolean> = {};
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const next = rows[i + 1];
    const bottom = next !== undefined && bothBlank(next, pickupCol, deliveryCol) ? next : null;
    folded.push(foldPair(row, bottom, rules, loadRefCol));
    hasBottomByRow[row.rowIndex] = bottom !== null;
    i += bottom === null ? 1 : 2;
  }
  return { rows: folded, header: [...header, ORDER_REF_HEADER], hasBottomByRow };
}

/** `GET /sheet/header`'s hint for the Connect page: 2 when, among `rows`
 *  (the first data rows under the header), the fold above detects at least
 *  two pairs AND pairs are at least half of the detected loads; 1
 *  otherwise (including a sheet with too few or too ambiguous pairs to be
 *  worth defaulting the checkbox on — the dispatcher can still tick it). */
export function suggestRowsPerLoad(rows: RawRow[], header: string[], mapping: SheetMapping): 1 | 2 {
  const col = (key: SheetColumnKey): number => (mapping[key] === undefined ? -1 : header.indexOf(mapping[key] as string));
  const pickupCol = col("pickup");
  const deliveryCol = col("delivery");
  if (pickupCol === -1 && deliveryCol === -1) return 1;

  let loads = 0;
  let pairs = 0;
  let i = 0;
  while (i < rows.length) {
    const next = rows[i + 1];
    const isPair = next !== undefined && bothBlank(next, pickupCol, deliveryCol);
    loads += 1;
    if (isPair) pairs += 1;
    i += isPair ? 2 : 1;
  }
  return pairs >= 2 && pairs * 2 >= loads ? 2 : 1;
}
