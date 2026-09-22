// The sheet's content digest (Slice 4, Task 1): a single hashing rule both
// connectors' `readRows` use for `SheetRead.version`, and that the sync
// layer can reproduce AHEAD of a write — so a tick that only wrote our own
// two cells can record the version the sheet will have once that write
// lands, and the next tick sees "unchanged" instead of paying for a row
// pass that finds nothing new. Nothing here knows about thresholds, rungs,
// classifications or phones — it hashes cell text, nothing else.
import { createHash } from "node:crypto";
import type { CellWrite, RawRow } from "./connector.js";

/** sha256 hex of `JSON.stringify(values)`. Both connectors call this with
 *  EXACTLY `[header, ...rows]` — the header row followed by every data row's
 *  cells, in the same order `readRows` returns them (padded to the header's
 *  width, blank rows already dropped) — so a version computed here from a
 *  predicted grid always matches what the connector's own next read would
 *  compute from the real one. */
export function digestOf(values: string[][]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** `rows` with `writes` applied, immutably: a copy of every row a write
 *  targets gets its written cells overwritten; every other row (and the
 *  input array itself) is untouched. A write whose `rowIndex` names a row
 *  not present in `rows` should never happen (every write this layer makes
 *  targets a row it just read) — it is silently skipped rather than thrown,
 *  since a version prediction is best-effort, not a correctness gate. */
export function applyWrites(rows: RawRow[], writes: CellWrite[]): RawRow[] {
  if (writes.length === 0) return rows;
  const byRow = new Map<number, CellWrite[]>();
  for (const w of writes) byRow.set(w.rowIndex, [...(byRow.get(w.rowIndex) ?? []), w]);
  return rows.map((row) => {
    const rowWrites = byRow.get(row.rowIndex);
    if (!rowWrites) return row;
    const cells = [...row.cells];
    for (const w of rowWrites) cells[w.col] = w.value;
    return { ...row, cells };
  });
}

/** The digest the sheet will carry once `writes` land on `rows`: what the
 *  status pass (and, from Task 2, the write-back pass) use to predict
 *  `SheetBinding.lastVersion` ahead of the connector's own next read. */
export function predictedVersion(header: string[], rows: RawRow[], writes: CellWrite[]): string {
  const after = applyWrites(rows, writes);
  return digestOf([header, ...after.map((r) => r.cells)]);
}
