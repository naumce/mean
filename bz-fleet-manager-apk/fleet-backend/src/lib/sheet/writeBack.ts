// Board → sheet write-back (Slice 4, Task 2): a dispatcher's board/paste/
// loadboard edit of a mirrored load flows back into the customer's sheet on
// the next tick. The sheet wins ties — if the load's current value no
// longer matches what the board wrote (a same-tick sheet edit of the same
// cell beat it, or a later board edit already overtook it), we write
// nothing and leave a trail line instead. Nothing here knows about
// thresholds, rungs, classifications or phones — it moves cell text.
//
// Round-trip note: writes use `valueInputOption: "RAW"` (googleConnector.ts)
// and reads use `FORMATTED_VALUE`. For the plain text and the `$x,xxx.xx`
// rate string this file writes, RAW and FORMATTED_VALUE agree — Sheets does
// not reformat a plain string, and a value that already looks like a
// currency literal reads back byte-identical. Nothing written by this file
// depends on Sheets' own number formatting.
import { prisma } from "../../db.js";
import type { CellWrite, RawRow } from "./connector.js";
import type { SheetMapping } from "./mapping.js";
import { AGENT_COLUMN_NAMES } from "./installColumns.js";
import { rendered } from "../loadWriter.js";

/** Sources a board editor can write through (the Broker Board, a paste, the
 *  Cockpit's `/loadboard`). Never `sheet` (our own mirror) or `agent`. */
const BOARD_SOURCES = ["board", "paste", "loadboard"] as const;

/** The LoadPatch/LoadChange field names this pass ever reverses back to a
 *  sheet cell, and which sheet header(s) hold them. `apptText` may resolve
 *  to one header (a shared PU/DEL column) or two (separate columns); every
 *  other field resolves to exactly one. A field absent here (bolNumber,
 *  customerName, trackingUrl, orderRef, soldRateCents, shipDate, the
 *  Cockpit's TMS-only scalars, the Night Shift switch fields, …) has no
 *  sheet cell and is silently skipped. */
export function reverseFieldMap(mapping: SheetMapping): Partial<Record<string, string[]>> {
  const map: Partial<Record<string, string[]>> = {};
  if (mapping.loadRef) map.boardLoadNo = [mapping.loadRef];
  if (mapping.driverPhone) map.driverCell = [mapping.driverPhone];
  if (mapping.driverName) map.carrierContactName = [mapping.driverName];
  if (mapping.pickup) map["stops.pickup"] = [mapping.pickup];
  if (mapping.delivery) map["stops.delivery"] = [mapping.delivery];
  if (mapping.customerEmail) map.customerEmail = [mapping.customerEmail];
  if (mapping.carrierName) map.carrierId = [mapping.carrierName];
  if (mapping.carrierPhone) map.carrierPhone = [mapping.carrierPhone];
  if (mapping.rate) map.revenueCents = [mapping.rate];
  if (mapping.notes) map.updateText = [mapping.notes];
  if (mapping.pickupAppt || mapping.deliveryAppt) {
    map.apptText = mapping.pickupAppt === mapping.deliveryAppt
      ? [mapping.pickupAppt as string]
      : [mapping.pickupAppt, mapping.deliveryAppt].filter((h): h is string => h !== undefined);
  }
  return map;
}

/** The `SheetColumnKey`-flavoured fields that live on the CARRIER (bottom)
 *  row of a two-rows-per-load sheet (foldPairs.ts's `BOTTOM_WINS`), named by
 *  their `LoadChange.field`/`LoadPatch` spelling instead of the sheet's own
 *  `SheetColumnKey`. Every other field this pass writes lands on the top row. */
const BOTTOM_OWNED_FIELDS: ReadonlySet<string> = new Set([
  "boardLoadNo", "driverCell", "carrierPhone", "carrierContactName", "carrierId",
]);

/** `$4,000.00` from a cents integer — the sheet's own RATE format
 *  (brokerBoard fixture, `parseMoney`'s inverse). Invalid input renders as
 *  `$0.00` rather than throwing: a board write always carries a valid
 *  integer (`applyLoadChange` only ever stores what `LoadPatch.revenueCents`
 *  gave it), so this is a last-resort guard, not a path this file expects
 *  to take. */
function formatMoneyCents(cents: number): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(safe / 100);
}

const PU_LINE_RE = /^PU\s*:\s*/i;
const DEL_LINE_RE = /^DEL\s*:\s*/i;

/** `apptText` is labelled (`PU: …`/`DEL: …`) when `rowToPatch.ts` produced it
 *  (both the shared- and separate-column readers label every line), but NOT
 *  when the Broker Board's own editor did (`boardCellApply.ts`'s
 *  `spliceLine` never adds a label — line 0 is always PU, line 1 always DEL,
 *  the same convention `parseApptText` tolerates coming in). Split by label
 *  when either is found; otherwise fall back to position. `null` means "no
 *  line for this role at all" (the board simply never touched it) —
 *  different from `""`, an explicit blank the board actually wrote. */
function resolveApptSplit(apptText: string): { pu: string | null; del: string | null } {
  const lines = apptText.split(/\r?\n/);
  const puLabeled = lines.find((l) => PU_LINE_RE.test(l));
  const delLabeled = lines.find((l) => DEL_LINE_RE.test(l));
  if (puLabeled !== undefined || delLabeled !== undefined) {
    return {
      pu: puLabeled !== undefined ? puLabeled.replace(PU_LINE_RE, "") : null,
      del: delLabeled !== undefined ? delLabeled.replace(DEL_LINE_RE, "") : null,
    };
  }
  return { pu: lines[0] ?? null, del: lines[1] ?? null };
}

function cellAt(rows: RawRow[], rowIndex: number, col: number): string {
  if (col === -1) return "";
  return rows.find((r) => r.rowIndex === rowIndex)?.cells[col] ?? "";
}

interface LoadForWriteBack {
  id: string;
  sheetRowIndex: number | null;
  boardLoadNo: string | null;
  driverCell: string | null;
  carrierContactName: string | null;
  carrierPhone: string | null;
  customerEmail: string | null;
  revenueCents: number;
  updateText: string | null;
  apptText: string | null;
  carrierId: string | null;
  extras: unknown;
  carrier: { name: string } | null;
  stops: { type: string; address: string }[];
}

const SELECT_FOR_WRITE_BACK = {
  id: true, sheetRowIndex: true, boardLoadNo: true, driverCell: true, carrierContactName: true,
  carrierPhone: true, customerEmail: true, revenueCents: true, updateText: true, apptText: true,
  carrierId: true, extras: true,
  carrier: { select: { name: true } },
  stops: { select: { type: true, address: true } },
} as const;

/** The Load's own current value for `field`, rendered exactly the way
 *  `LoadChange.after` was (loadWriter.ts's `rendered()`), so the "did the
 *  board's edit survive this tick's row pass" comparison is apples to
 *  apples. `stops.pickup`/`stops.delivery` aren't scalars on `Load` itself,
 *  so they are read off the `stops` relation the same way loadWriter.ts's
 *  own trace does. */
function currentRendered(load: LoadForWriteBack, field: string): string | null {
  if (field === "stops.pickup") return rendered(load.stops.find((s) => s.type === "pickup")?.address ?? null);
  if (field === "stops.delivery") return rendered(load.stops.find((s) => s.type === "delivery")?.address ?? null);
  return rendered((load as unknown as Record<string, unknown>)[field]);
}

/** The sheet cell text for a field whose board edit survived, given the
 *  RENDERED value (either the change's `after`, or — for `carrierId`, whose
 *  rendered form is the id, not a name — the load's current carrier name). */
function cellTextFor(field: string, renderedValue: string | null, load: LoadForWriteBack): string {
  if (field === "revenueCents") return formatMoneyCents(Number(renderedValue ?? "0"));
  if (field === "carrierId") return load.carrier?.name ?? "";
  return renderedValue ?? "";
}

const jsonRecord = (v: unknown): Record<string, string> => {
  if (v === null || v === undefined || typeof v !== "object") return {};
  return v as Record<string, string>;
};

const conflictText = (current: string, after: string): string =>
  `conflict: sheet has "${current}", board tried "${after}" — sheet kept`;

/** The conflict trail's own value for `field` — dollars for `revenueCents`
 *  (minor, fix round 1: showing raw cents there read as a different, much
 *  smaller "rate" than the sheet's own RATE column format), the rendered
 *  string as-is for everything else. */
function conflictDisplayValue(field: string, value: string | null): string {
  if (field === "revenueCents") return formatMoneyCents(Number(value ?? "0"));
  return value ?? "";
}

const apptMappingConflict = (apptText: string): string =>
  `conflict: could not map appointment "${apptText}" to the sheet's PU/DEL columns — sheet kept`;

interface LatestChangeRow { loadId: string; field: string; after: string | null; before: string | null; atMs: bigint }

export interface Conflict { loadId: string; text: string }

export interface CollectBoardEditsArgs {
  orgId: string;
  bindingId: string;
  sinceAtMs: bigint;
  mapping: SheetMapping;
  /** The sheet's own header row, unfolded — the same row space `CellWrite.col`
   *  and `Load.sheetRowIndex` live in. */
  header: string[];
  /** This tick's raw rows (same row space as `header`) — read for the
   *  `apptText` split's "would this blank a cell that already has real
   *  text" guard. Never written to directly. */
  rows: RawRow[];
  rowsPerLoad: 1 | 2;
  /** foldPairs.ts's `hasBottomByRow`, keyed by a load's `sheetRowIndex`.
   *  Ignored when `rowsPerLoad === 1`. */
  hasBottomByRow: Record<number, boolean>;
}

export interface BoardEditsResult {
  writes: CellWrite[];
  conflicts: Conflict[];
  /** The highest `LoadChange.atMs` examined this call — `sinceAtMs` itself
   *  when nothing new was found, so the caller can always assign it back to
   *  `SheetBinding.boardSyncAtMs` unconditionally. */
  maxAtMs: bigint;
}

/** `apptText`'s cell-mapping rules (review ruling, fix round 1):
 *  - SEPARATE columns: split by role (labelled or positional) and write both
 *    to the TOP row, whichever `rowsPerLoad` — the appointment columns are
 *    never bottom-owned.
 *  - SHARED column, `rowsPerLoad === 2`, and the pair HAS a bottom: the PU
 *    line goes to the top row's cell, the DEL line to the bottom row's —
 *    mirrors `foldPairs.ts`'s own join rule in reverse.
 *  - SHARED column otherwise (rowsPerLoad 1, or a lone top with no bottom):
 *    the whole text is already the right value for the one cell.
 *  A role that resolves to `null` (no line for it at all) is left alone —
 *  nothing to say. A role that resolves to `""` (an explicit blank) is only
 *  written when the cell it would land in is ALREADY blank; blanking a cell
 *  that currently holds real text instead raises one conflict for the whole
 *  field and skips that side's write only. */
function applyApptTextEdit(a: {
  apptText: string; loadId: string; headers: string[]; rowsPerLoad: 1 | 2;
  hasBottomByRow: Record<number, boolean>; top: number; header: string[]; rows: RawRow[];
  pushWrite: (rowIndex: number, headerName: string, value: string) => void; conflicts: Conflict[];
}): void {
  const { apptText, loadId, headers, rowsPerLoad, hasBottomByRow, top, header, rows, pushWrite, conflicts } = a;
  const shared = headers.length === 1;

  if (shared && !(rowsPerLoad === 2 && hasBottomByRow[top])) {
    // One cell, one value — no split needed.
    pushWrite(top, headers[0], apptText);
    return;
  }

  const split = resolveApptSplit(apptText);
  let conflicted = false;
  const attempt = (value: string | null, rowIndex: number, headerName: string): void => {
    if (value === null) return; // no line for this role — nothing to say
    const col = header.indexOf(headerName);
    if (value === "" && cellAt(rows, rowIndex, col) !== "") { conflicted = true; return; }
    pushWrite(rowIndex, headerName, value);
  };

  if (shared) {
    attempt(split.pu, top, headers[0]);
    attempt(split.del, top + 1, headers[0]);
  } else {
    attempt(split.pu, top, headers[0]);
    attempt(split.del, top, headers[1]);
  }
  if (conflicted) conflicts.push({ loadId, text: apptMappingConflict(apptText) });
}

/** Keeps only the LATEST row per (loadId, field) — `changes` must already be
 *  ordered by `atMs` ascending, so a later entry simply overwrites an
 *  earlier one in the map. */
function latestByLoadAndField(changes: LatestChangeRow[]): Map<string, LatestChangeRow> {
  const latest = new Map<string, LatestChangeRow>();
  for (const c of changes) latest.set(`${c.loadId}:${c.field}`, c);
  return latest;
}

/** Board edits (spec Slice 4, Task 2): every `LoadChange` from a board
 *  source newer than `sinceAtMs`, resolved against the mirrored load's
 *  CURRENT value — one write when the board's edit survived this tick's row
 *  pass, one conflict line when the sheet's own value (or a later change)
 *  overtook it. Never touches a Load field; never writes the agent switch
 *  or status columns. */
export async function collectBoardEdits(args: CollectBoardEditsArgs): Promise<BoardEditsResult> {
  const { orgId, bindingId, sinceAtMs, mapping, header, rows, rowsPerLoad, hasBottomByRow } = args;

  const changes = await prisma.loadChange.findMany({
    where: { orgId, source: { in: [...BOARD_SOURCES] }, atMs: { gt: sinceAtMs } },
    orderBy: { atMs: "asc" },
    select: { loadId: true, field: true, after: true, before: true, atMs: true },
  });
  if (changes.length === 0) return { writes: [], conflicts: [], maxAtMs: sinceAtMs };

  const maxAtMs = changes.reduce((m, c) => (c.atMs > m ? c.atMs : m), sinceAtMs);
  const latest = latestByLoadAndField(changes);

  const loadIds = [...new Set(changes.map((c) => c.loadId))];
  // Fix round 1: scoped to THIS binding — an org can run more than one
  // connected sheet, and `sheetRowIndex` alone can't tell them apart.
  const loads = await prisma.load.findMany({
    where: { id: { in: loadIds }, orgId, sheetBindingId: bindingId, sheetRowIndex: { not: null } },
    select: SELECT_FOR_WRITE_BACK,
  });
  const loadById = new Map(loads.map((l) => [l.id, l as LoadForWriteBack]));

  const reverseMap = reverseFieldMap(mapping);
  const agentCols = new Set([header.indexOf(AGENT_COLUMN_NAMES.switch), header.indexOf(AGENT_COLUMN_NAMES.status)].filter((i) => i !== -1));

  const writes: CellWrite[] = [];
  const conflicts: Conflict[] = [];

  const pushWrite = (rowIndex: number, headerName: string, value: string): void => {
    const col = header.indexOf(headerName);
    if (col === -1 || agentCols.has(col)) return; // stale mapping, or (should never happen) an agent column
    writes.push({ rowIndex, col, value });
  };

  const rowFor = (load: LoadForWriteBack, field: string): number => {
    const top = load.sheetRowIndex as number;
    if (rowsPerLoad === 2 && BOTTOM_OWNED_FIELDS.has(field) && hasBottomByRow[top]) return top + 1;
    return top;
  };

  for (const change of latest.values()) {
    const load = loadById.get(change.loadId);
    if (!load) continue; // no longer sheet-linked (row vanished, or org mismatch)

    if (change.field === "extras") {
      const before = jsonRecord(change.before !== null ? safeParse(change.before) : null);
      const after = jsonRecord(safeParse(change.after));
      const currentExtras = jsonRecord(load.extras);
      for (const key2 of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[key2] === after[key2]) continue;
        if (!header.includes(key2)) continue;
        const current = currentExtras[key2] ?? null;
        const wanted = after[key2] ?? null;
        if (current !== wanted) { conflicts.push({ loadId: load.id, text: conflictText(current ?? "", wanted ?? "") }); continue; }
        pushWrite(load.sheetRowIndex as number, key2, wanted ?? "");
      }
      continue;
    }

    const headers = reverseMap[change.field];
    if (!headers || headers.length === 0) continue; // no mapped sheet cell for this field

    const current = currentRendered(load, change.field);
    if (current !== change.after) {
      conflicts.push({
        loadId: load.id,
        text: conflictText(conflictDisplayValue(change.field, current), conflictDisplayValue(change.field, change.after)),
      });
      continue;
    }

    if (change.field === "apptText") {
      applyApptTextEdit({
        apptText: change.after ?? "", loadId: load.id, headers, rowsPerLoad, hasBottomByRow,
        top: load.sheetRowIndex as number, header, rows, pushWrite, conflicts,
      });
      continue;
    }

    const rowIndex = rowFor(load, change.field);
    const value = cellTextFor(change.field, change.after, load);
    for (const h of headers) pushWrite(rowIndex, h, value);
  }

  return { writes, conflicts, maxAtMs };
}

function safeParse(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
