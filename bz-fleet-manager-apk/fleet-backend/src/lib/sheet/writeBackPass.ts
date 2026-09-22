// The write-back call site (Slice 4, Task 2), pulled out of sync.ts the same
// way statusPass.ts was — one more pass sync.ts runs every tick the sheet
// was read, after the status pass. Nothing here decides what changed; it
// only wires collectBoardEdits' answer to the connector and the DB.
import { prisma } from "../../db.js";
import type { CellWrite, SheetConnector, TabRef } from "./connector.js";
import type { SheetMapping } from "./mapping.js";
import { foldPairs } from "./foldPairs.js";
import { collectBoardEdits } from "./writeBack.js";
import { nextAtMs } from "../loadWriter.js";

export interface WriteBackPassArgs {
  orgId: string;
  bindingId: string;
  boardSyncAtMs: bigint;
  mapping: SheetMapping;
  rowsPerLoad: 1 | 2;
  /** This tick's rows/header exactly as read — unfolded, the same row space
   *  `Load.sheetRowIndex` lives in. */
  header: string[];
  rows: { rowIndex: number; cells: string[] }[];
  connector: SheetConnector;
  ref: TabRef;
}

export interface WriteBackPassResult {
  writes: CellWrite[];
}

/** Runs `collectBoardEdits`, writes its cells in one batch, records its
 *  conflicts as `AgentUpdate` rows (one transaction, no Load field
 *  changes), and advances `SheetBinding.boardSyncAtMs`. Returns the writes
 *  so the caller can fold them into the tick's predicted post-write digest
 *  (digest.ts's `predictedVersion`) alongside the status pass's own. */
export async function runWriteBackPass(args: WriteBackPassArgs): Promise<WriteBackPassResult> {
  const { orgId, bindingId, boardSyncAtMs, mapping, rowsPerLoad, header, rows, connector, ref } = args;

  const hasBottomByRow = rowsPerLoad === 2 ? foldPairs(rows, header, mapping).hasBottomByRow : {};

  const { writes, conflicts, maxAtMs } = await collectBoardEdits({
    orgId, bindingId, sinceAtMs: boardSyncAtMs, mapping, header, rows, rowsPerLoad, hasBottomByRow,
  });

  if (writes.length > 0) await connector.writeCells(ref, writes);

  if (conflicts.length > 0) {
    await prisma.$transaction((tx) =>
      tx.agentUpdate.createMany({
        data: conflicts.map((c) => ({ loadId: c.loadId, atMs: nextAtMs(), kind: "status", text: c.text })),
      }));
  }

  if (maxAtMs !== boardSyncAtMs) {
    await prisma.sheetBinding.update({ where: { id: bindingId }, data: { boardSyncAtMs: maxAtMs } });
  }

  return { writes };
}
