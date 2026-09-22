// The status write (spec §6.2, Task 9; extracted from sync.ts in the final
// fix wave once that file passed its size budget): one whole-cell rewrite
// per mirrored load whose intended cell text differs from what the sheet
// shows right now, in ONE `writeCells` batch. Never the switch column —
// this only ever touches `agentStatusCol`. Nothing here knows about
// thresholds, rungs, classifications or phones: the pill and its line are
// decided upstream; this renders them (statusCell.ts) and decides whether
// the cell already says so.
import { prisma } from "../../db.js";
import type { CellWrite, RawRow, SheetConnector, TabRef } from "./connector.js";
import { statusCellText } from "./statusCell.js";
import { linkUrlFor, type LinkOrg } from "../nightShiftLink.js";
import { applyWrites } from "./digest.js";

/** A row the row pass skipped, with why. Only the two reasons a dispatcher
 *  can fix in the sheet itself get a status cell (see `attentionCellFor`). */
export interface SkippedRow { rowIndex: number; reason: string }

export interface StatusPassArgs {
  orgId: string;
  org: LinkOrg;
  agentStatusCol: number;
  skipped: SkippedRow[];
  /** The rows exactly as this tick read them, in the UNFOLDED row space
   *  (Task 1) — `sync.ts` passes `read.rows`, never a two-row fold's virtual
   *  rows, so `rowsAfter` below lines up with what the connector's own next
   *  read will return. The status column of each is what an intended write
   *  is compared against (final fix wave, I9b): a cell that already says
   *  what we would write is not written again, whether it is a load's
   *  pill/line or a skipped row's attention text. This is safe for a
   *  two-row binding too: the switch/status columns fold "top row only", so
   *  a folded row's cell at `agentStatusCol` is always identical to the
   *  matching raw top row's cell. */
  rows: RawRow[];
  connector: SheetConnector;
  ref: TabRef;
  nowMs: number;
}

export interface StatusPassResult {
  /** How many cells this pass wrote — what `SyncReport.statusWrites` reports. */
  count: number;
  /** `args.rows` with every write applied (Task 1): the caller predicts the
   *  post-write digest from this rather than waiting for the next read to
   *  discover the sheet only changed because of the agent's own cells. */
  rowsAfter: RawRow[];
}

/** `● ATTENTION — <reason>` for the skip reasons that are the sheet's own
 *  problem (a missing or duplicated load number — final fix wave, I14);
 *  null for the transient ones (a lock, a stale version), which are retried
 *  and must not paint the row. */
export function attentionCellFor(reason: string): string | null {
  if (reason === "needs a load number" || reason.startsWith("duplicate load number ")) return `● ATTENTION — ${reason}`;
  return null;
}

/** The line under the pill (final fix wave, minor "status line"): the
 *  newest non-attention update, EXCEPT when the pill itself is `attention`
 *  — then the newest attention line is the story, and the cell says the
 *  same thing the board's pill does. */
function lineFor(pill: string, newestNonAttention: string | null, newestAttention: string | null): string | null {
  if (pill === "attention") return newestAttention ?? newestNonAttention;
  return newestNonAttention;
}

async function newestAttentionByLoad(loadIds: string[]): Promise<Map<string, string>> {
  if (loadIds.length === 0) return new Map();
  const rows = await prisma.agentUpdate.findMany({
    where: { loadId: { in: loadIds }, kind: "attention" },
    orderBy: { atMs: "desc" },
    select: { loadId: true, text: true },
  });
  const newest = new Map<string, string>();
  for (const row of rows) if (!newest.has(row.loadId)) newest.set(row.loadId, row.text);
  return newest;
}

/** A `writeCells` failure is left to propagate to `syncBinding`'s own
 *  try/catch — the connector itself failed, which is that failure counter's
 *  job, not a row error. */
export async function writeStatusCells(args: StatusPassArgs): Promise<StatusPassResult> {
  const { orgId, org, agentStatusCol, skipped, rows, connector, ref, nowMs } = args;
  const currentCell = new Map(rows.map((r) => [r.rowIndex, r.cells[agentStatusCol] ?? ""]));

  const loads = await prisma.load.findMany({
    where: { orgId, sheetRowIndex: { not: null } },
    include: { agentUpdates: { where: { kind: { not: "attention" } }, orderBy: { atMs: "desc" }, take: 1 } },
  });
  const attentionLines = await newestAttentionByLoad(loads.filter((l) => l.agentPill === "attention").map((l) => l.id));

  const writes: CellWrite[] = [];
  const written: string[] = [];
  for (const load of loads) {
    const rowIndex = load.sheetRowIndex as number;
    const line = lineFor(load.agentPill, load.agentUpdates[0]?.text ?? null, attentionLines.get(load.id) ?? null);
    const value = statusCellText(load.agentPill, line);
    if (currentCell.get(rowIndex) === value) continue;
    writes.push({ rowIndex, col: agentStatusCol, value, note: linkUrlFor(org, load.id) });
    written.push(load.id);
  }

  // The one exception to "mirrored loads only" (Task 9's brief): a row this
  // tick never made it to a Load at all still gets a status cell, so the
  // dispatcher learns why rather than seeing silence.
  for (const s of skipped) {
    const value = attentionCellFor(s.reason);
    if (value === null || currentCell.get(s.rowIndex) === value) continue;
    writes.push({ rowIndex: s.rowIndex, col: agentStatusCol, value });
  }

  if (writes.length === 0) return { count: 0, rowsAfter: rows };
  await connector.writeCells(ref, writes);
  if (written.length > 0) {
    await prisma.load.updateMany({ where: { id: { in: written } }, data: { sheetStatusWrittenAt: new Date(nowMs) } });
  }
  return { count: writes.length, rowsAfter: applyWrites(rows, writes) };
}
