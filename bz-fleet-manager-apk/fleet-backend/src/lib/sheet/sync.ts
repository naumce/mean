// Read-only sync (spec Night Shift sheet slices, Task 8) plus the two cells
// (Task 9): a connected SheetBinding's rows become Loads; the switch column
// (when installed) drives the same applyAgentSwitch the HTTP route uses; the
// status column (when installed) gets one whole-cell rewrite per tick
// (statusPass.ts). Nothing here knows about thresholds, rungs,
// classifications or phones — that reads a row (rowToPatch.ts) and this only
// decides whether it changed anything and, if so, writes it through the one
// traced door (loadWriter.ts).
import { prisma } from "../../db.js";
import type { RawRow, SheetConnector, SheetRead, TabRef } from "./connector.js";
import { connectorFor } from "./connectorFor.js";
import type { SheetMapping } from "./mapping.js";
import { rowToPatch, SHEET_ATTENTION_ASPECTS, type RowResult } from "./rowToPatch.js";
import { applyLoadChange, attentionAspect, rendered, type LoadPatch } from "../loadWriter.js";
import { applyAgentSwitch } from "../agentSwitch.js";
import { emitLoadChanged } from "../loadEvents.js";
import { DEFAULT_EQUIPMENT } from "../brokerImport.js";
import { LoadLocked } from "../loadLocks.js";
import { settlePendingStops } from "../geocodeSettle.js";
import { attentionDiffers, patchDiffers } from "./rowDiff.js";
import { AGENT_COLUMN_NAMES } from "./installColumns.js";
import { writeStatusCells, type SkippedRow } from "./statusPass.js";

export const SHEET_ACTOR = { dispatcherId: null, name: "sheet" } as const;

/** `SheetBinding.lastError` while an installed binding's tab no longer
 *  carries both agent columns (final fix wave, C4). Status stays
 *  "connected" — rows still mirror — but the switch read and the status
 *  pass are skipped until the columns are back. */
export const COLUMNS_NOT_FOUND = "Night Shift columns not found — click Install on the Connect page";

/** An "error" binding is retried after this long (final fix wave, I11). */
export const ERROR_RETRY_MS = 5 * 60 * 1000;

export interface SyncDeps {
  connector: SheetConnector;
  nowMs: () => number;
}

export interface SyncReport {
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: SkippedRow[];
  statusWrites: number;
  error: string | null;
}

const GOVERNED_ASPECTS = new Set(SHEET_ATTENTION_ASPECTS.map(attentionAspect));

const emptyReport = (): SyncReport => ({ read: 0, created: 0, updated: 0, unchanged: 0, skipped: [], statusWrites: 0, error: null });

// Consecutive-failure counter, rebuilt immutably per binding (never mutated
// in place). Module-level: `syncAllSheets` runs once a tick, and a binding's
// count must survive from one tick to the next to reach three.
let failures: Record<string, number> = {};

async function recordFailure(bindingId: string, message: string): Promise<void> {
  const count = (failures[bindingId] ?? 0) + 1;
  failures = { ...failures, [bindingId]: count };
  await prisma.sheetBinding.update({
    where: { id: bindingId },
    data: { lastError: message, ...(count >= 3 ? { status: "error" } : {}) },
  });
}

async function recordSuccess(bindingId: string, version: string, atMs: number, wasError: boolean, lastError: string | null = null): Promise<void> {
  failures = { ...failures, [bindingId]: 0 };
  await prisma.sheetBinding.update({
    where: { id: bindingId },
    data: { lastVersion: version, lastSyncAt: new Date(atMs), lastError, ...(wasError ? { status: "connected" } : {}) },
  });
}

// --- the agent columns, by header name ----------------------------------------

interface AgentColumns { switchCol: number | null; statusCol: number | null }

const NO_COLUMNS: AgentColumns = { switchCol: null, statusCol: null };

interface StoredColumns { agentSwitchCol: number | null; agentStatusCol: number | null }

/** Final fix wave, C4: the agent columns are found by NAME in the header
 *  just read, never trusted from the stored index — a column inserted to
 *  their left moves them, and a status write into a stale index would land
 *  in a dispatcher's own column. A binding that never ran install (both
 *  stored indexes null) is "not installed": silently no switch read, no
 *  status pass. An installed binding whose header lacks either name is
 *  `missing` (COLUMNS_NOT_FOUND); one whose names moved reports the fresh
 *  indexes so the caller can persist them. */
export function locateAgentColumns(header: string[], stored: StoredColumns): { columns: AgentColumns; missing: boolean; moved: boolean } {
  if (stored.agentSwitchCol == null || stored.agentStatusCol == null) return { columns: NO_COLUMNS, missing: false, moved: false };
  const switchCol = header.indexOf(AGENT_COLUMN_NAMES.switch);
  const statusCol = header.indexOf(AGENT_COLUMN_NAMES.status);
  if (switchCol === -1 || statusCol === -1) return { columns: NO_COLUMNS, missing: true, moved: false };
  const moved = switchCol !== stored.agentSwitchCol || statusCol !== stored.agentStatusCol;
  return { columns: { switchCol, statusCol }, missing: false, moved };
}

// --- the switch cell ------------------------------------------------------------

// The switch cell's meaning (spec §17.2's dropdown: "OFF" + a policy name).
// Read once per row, before any write, so an unrecognized value never
// silently falls through as a switch change — it becomes an attention line
// instead (see `SHEET_ATTENTION_ASPECTS`'s sixth representative).
type SwitchDecision =
  | { kind: "off" }
  | { kind: "on"; policyId: string }
  | { kind: "unknown"; value: string };

/** The normalised cell text — what `Load.sheetSwitchSeen` remembers. */
const switchCellText = (raw: string): string => raw.trim();

function readSwitchCell(cell: string, policies: { id: string; name: string }[]): SwitchDecision {
  if (cell === "" || cell.toUpperCase() === "OFF") return { kind: "off" };
  const policy = policies.find((p) => p.name === cell);
  if (policy) return { kind: "on", policyId: policy.id };
  return { kind: "unknown", value: cell };
}

interface SwitchRead { cell: string; decision: SwitchDecision }

interface MappedRow { row: RawRow; result: RowResult; switchRead: SwitchRead | null }

interface RowsOutcome extends Pick<SyncReport, "created" | "updated" | "unchanged" | "skipped"> {
  /** Rows that reached a write attempt and failed there (a lock, a stale
   *  version, an invalid stop set — anything `applyLoadChange`/`tx.load.create`
   *  itself threw). Kept apart from `skipped`'s ordinary reasons (duplicate,
   *  no load number) because only this count feeds `SheetBinding.lastError`
   *  — those two are expected, everyday skips, not failures. */
  rowErrorCount: number;
  /** Every load this pass created or updated — what gets settled against
   *  the geocoder afterwards (final fix wave, I8). */
  touched: string[];
}

/** `LoadLocked` names its holder; anything else is reported by its own
 *  message. Never re-thrown: a row error is this row's problem, not the
 *  binding's (see `syncRows`'s per-row try/catch below). */
function rowErrorReason(e: unknown): string {
  if (e instanceof LoadLocked) return `locked by ${e.lock.by} — retried next sync`;
  return e instanceof Error ? e.message : String(e);
}

interface CurrentSwitch { enabled: boolean; policyId: string | null }

/** The switch (final fix wave, I5): it reacts to the CELL CHANGING, never
 *  to the cell's value as such. `Load.sheetSwitchSeen` is the cell text the
 *  sync last acted on; while the cell reads the same, nothing here touches
 *  the switch — so a drawer/deep-link `stop` (commands.ts's applyStop sets
 *  agentEnabled=false, pill off, with no cell change) is NOT reverted on the
 *  next tick, and a dispatcher who wants it back on flips the cell (OFF then
 *  the policy name again). "unknown" never touches the switch — its
 *  attention line already rode through `result.attention`. The board's own
 *  AgentSwitch stays disabled for a bound org (Task 11), so the sheet cell
 *  and the drawer's commands are the only two doors, and they no longer
 *  fight.
 *
 *  Residual fix 2: the switch write and the `sheetSwitchSeen` write are ONE
 *  transaction, in that order — a flip that throws leaves the cell
 *  "unseen", so the next tick tries it again instead of losing it. */
async function applySwitchChange(orgId: string, loadId: string, current: CurrentSwitch, read: SwitchRead): Promise<void> {
  const { cell, decision } = read;
  const desiredEnabled = decision.kind === "on";
  const desiredPolicyId = decision.kind === "on" ? decision.policyId : current.policyId;
  const flip = decision.kind !== "unknown" && (current.enabled !== desiredEnabled || current.policyId !== desiredPolicyId);
  const write = await prisma.$transaction(async (tx) => {
    const switched = flip
      ? await applyAgentSwitch(tx, {
        loadId, orgId, actor: SHEET_ACTOR, source: "sheet",
        enabled: desiredEnabled,
        ...(decision.kind === "on" ? { policyId: decision.policyId } : {}),
      })
      : null;
    const seen = await applyLoadChange(tx, { loadId, orgId, actor: SHEET_ACTOR, source: "sheet", patch: { sheetSwitchSeen: cell } });
    return { version: seen.version, changed: [...(switched?.changed ?? []), ...seen.changed] };
  });
  if (write.changed.length > 0) emitLoadChanged(orgId, { loadId, version: write.version, fields: write.changed });
}

/** Per-row: find or create the Load, decide whether anything differs, write
 *  through `applyLoadChange` only when it does. One `$transaction` per row —
 *  the same grain `brokerImport.ts` uses — so one bad row never rolls back
 *  every other row this tick read successfully, AND (fix round 1) a row
 *  whose write throws (a lock another dispatcher holds, a stale version, an
 *  invalid stop set) is caught right here and skipped rather than aborting
 *  every row after it — a routine board lock must never look like the
 *  connector itself is failing. */
/** How many rows carry each load number THIS tick — duplicates are judged
 *  within this tick's own rows only, never against history. */
function countLoadRefs(mapped: MappedRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { result } of mapped) {
    if (result.loadRef) counts.set(result.loadRef, (counts.get(result.loadRef) ?? 0) + 1);
  }
  return counts;
}

async function syncRows(bindingId: string, orgId: string, mapped: MappedRow[]): Promise<RowsOutcome> {
  const loadRefCounts = countLoadRefs(mapped);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let rowErrorCount = 0;
  const skipped: SkippedRow[] = [];
  const touched: string[] = [];

  for (const { row, result, switchRead } of mapped) {
    if (!result.loadRef) {
      skipped.push({ rowIndex: row.rowIndex, reason: "needs a load number" });
      continue;
    }
    if ((loadRefCounts.get(result.loadRef) ?? 0) > 1) {
      skipped.push({ rowIndex: row.rowIndex, reason: `duplicate load number ${result.loadRef}` });
      continue;
    }

    const existing = await prisma.load.findFirst({
      where: { orgId, boardLoadNo: result.loadRef },
      include: {
        stops: { select: { type: true, address: true } },
        carrier: { select: { name: true, mcNumber: true } },
      },
    });

    // The switch is only consulted when its cell changed against what the
    // load last saw (`applySwitchChange`, which also records the new cell —
    // after the row's own content write, in its own transaction).
    const patch: LoadPatch = result.patch;
    const cellChanged = switchRead !== null && rendered(switchRead.cell) !== rendered(existing?.sheetSwitchSeen ?? null);
    const writeArgs = { orgId, actor: SHEET_ACTOR, source: "sheet" as const, patch, attention: result.attention, attentionOwned: [...SHEET_ATTENTION_ASPECTS] };

    try {
      let loadId: string;
      let current: CurrentSwitch;

      if (!existing) {
        const write = await prisma.$transaction(async (tx) => {
          const load = await tx.load.create({
            data: { orgId, status: "open", legType: "linehaul", requiredEquip: DEFAULT_EQUIPMENT, fscCents: 0, boardLoadNo: result.loadRef },
          });
          return { loadId: load.id, ...(await applyLoadChange(tx, { ...writeArgs, loadId: load.id })) };
        });
        created += 1;
        touched.push(write.loadId);
        emitLoadChanged(orgId, { loadId: write.loadId, version: write.version, fields: write.changed });
        loadId = write.loadId;
        current = { enabled: false, policyId: null }; // Load.create's own defaults
      } else {
        loadId = existing.id;
        current = { enabled: existing.agentEnabled, policyId: existing.agentPolicyId };

        const currentAttention = await prisma.agentUpdate.findMany({ where: { loadId: existing.id, kind: "attention" } });
        const ownedLines = currentAttention.filter((a) => GOVERNED_ASPECTS.has(attentionAspect(a.text))).map((a) => a.text);

        if (!patchDiffers(patch, existing) && !attentionDiffers(result.attention, ownedLines)) {
          unchanged += 1;
        } else {
          const write = await prisma.$transaction((tx) => applyLoadChange(tx, { ...writeArgs, loadId: existing.id }));
          updated += 1;
          touched.push(existing.id);
          emitLoadChanged(orgId, { loadId: existing.id, version: write.version, fields: write.changed });
        }
      }

      if (switchRead && cellChanged) await applySwitchChange(orgId, loadId, current, switchRead);
    } catch (e) {
      rowErrorCount += 1;
      const reason = rowErrorReason(e);
      console.error("sheet sync row failed", { bindingId, rowIndex: row.rowIndex, error: reason });
      skipped.push({ rowIndex: row.rowIndex, reason });
    }
  }

  return { created, updated, unchanged, skipped, rowErrorCount, touched };
}

/** Final fix wave, I6: a load whose row is gone from the sheet (deleted, or
 *  its LOAD# blanked/changed) forgets its `sheetRowIndex`, so the status
 *  pass never writes into whatever row now sits at that index. "Gone" is
 *  judged by load number against the numbers this tick read EXACTLY ONCE
 *  (residual fix 1): a locked row is still in the sheet, so its load is
 *  kept; a DUPLICATED number's load is unlinked too — both of its rows are
 *  skipped and painted with the duplicate attention cell, and a load still
 *  linked to one of them would have its pill fight that cell every tick.
 *  The row patch re-links it the tick the duplicate is resolved. Traced
 *  through `applyLoadChange` like every other sheet write; a lock here is
 *  this load's problem alone, logged and retried next tick. */
async function forgetVanishedRows(bindingId: string, orgId: string, mapped: MappedRow[]): Promise<void> {
  const presentRefs = [...countLoadRefs(mapped)].filter(([, n]) => n === 1).map(([ref]) => ref);
  const vanished = await prisma.load.findMany({
    where: { orgId, sheetRowIndex: { not: null }, NOT: { boardLoadNo: { in: presentRefs } } },
    select: { id: true },
  });
  for (const load of vanished) {
    try {
      const write = await prisma.$transaction((tx) => applyLoadChange(tx, {
        loadId: load.id, orgId, actor: SHEET_ACTOR, source: "sheet", patch: { sheetRowIndex: null },
      }));
      if (write.changed.length > 0) emitLoadChanged(orgId, { loadId: load.id, version: write.version, fields: write.changed });
    } catch (e) {
      console.error("sheet sync: could not forget a vanished row", { bindingId, loadId: load.id, error: rowErrorReason(e) });
    }
  }
}

/** The row pass, on a changed tick: mirror every row, then forget the rows
 *  that vanished, then ask the geocoder about whatever the gazetteer could
 *  not place (final fix wave, I8 — the same `settlePendingStops` the board
 *  import runs, outside every transaction). */
async function rowPass(
  bindingId: string, orgId: string, tz: string, nowMs: number, mapping: SheetMapping,
  read: SheetRead, switchCol: number | null,
): Promise<RowsOutcome> {
  const ctx = { tz, year: new Date(nowMs).getUTCFullYear() };
  // The org's policies, read once per tick — only needed when a switch
  // column exists to read at all.
  const policies = switchCol != null
    ? await prisma.agentPolicy.findMany({ where: { orgId }, select: { id: true, name: true } })
    : [];
  const mapped: MappedRow[] = read.rows.map((row) => {
    const result = rowToPatch(row, read.header, mapping, ctx);
    const cell = switchCol != null ? switchCellText(row.cells[switchCol] ?? "") : null;
    const switchRead: SwitchRead | null = cell !== null ? { cell, decision: readSwitchCell(cell, policies) } : null;
    // An unrecognized switch value rides the exact same attention pipe as
    // every other line rowToPatch itself raises — attentionOwned already
    // covers its aspect (SHEET_ATTENTION_ASPECTS's sixth representative),
    // so a corrected cell clears it the same way any other sheet refusal
    // clears.
    const attention = switchRead?.decision.kind === "unknown"
      ? [...result.attention, `unknown policy: "${switchRead.decision.value}"`]
      : result.attention;
    return { row, result: { ...result, attention }, switchRead };
  });

  const rows = await syncRows(bindingId, orgId, mapped);
  await forgetVanishedRows(bindingId, orgId, mapped);
  const settled = await settlePendingStops(orgId, rows.touched);
  for (const s of settled) emitLoadChanged(orgId, { loadId: s.loadId, version: s.version, fields: s.roles });
  return rows;
}

export async function syncBinding(bindingId: string, deps: SyncDeps): Promise<SyncReport> {
  try {
    const binding = await prisma.sheetBinding.findUniqueOrThrow({
      where: { id: bindingId },
      include: { org: { select: { id: true, timezone: true, linkSecret: true } } },
    });
    const ref: TabRef = { spreadsheetId: binding.spreadsheetId, tabId: binding.tabId };
    const read = await deps.connector.readRows(ref, binding.headerRow, binding.lastVersion ?? undefined);

    // Where the agent columns are THIS tick. A changed tick locates them by
    // name in the header just read (C4); an unchanged tick's header is the
    // one the last changed tick already validated, so the stored indexes
    // stand — unless that tick found the columns missing, which is still
    // true of an unchanged sheet.
    let columns: AgentColumns;
    let columnsError: string | null = null;
    if (read.changed) {
      const located = locateAgentColumns(read.header, binding);
      columns = located.columns;
      if (located.missing) columnsError = COLUMNS_NOT_FOUND;
      if (located.moved) {
        await prisma.sheetBinding.update({
          where: { id: bindingId },
          data: { agentSwitchCol: columns.switchCol, agentStatusCol: columns.statusCol },
        });
      }
    } else if (binding.lastError === COLUMNS_NOT_FOUND) {
      columns = NO_COLUMNS;
      columnsError = COLUMNS_NOT_FOUND;
    } else {
      columns = { switchCol: binding.agentSwitchCol, statusCol: binding.agentStatusCol };
    }

    // The row pass (switch read included — it reads the sheet's own cells)
    // only runs when the sheet changed; the status pass runs every tick,
    // because it is driven by the AGENT's own activity (a new AgentUpdate, a
    // pill change), which has nothing to do with whether a dispatcher edited
    // the sheet since the last tick.
    const rows = read.changed
      ? await rowPass(bindingId, binding.orgId, binding.org.timezone, deps.nowMs(), (binding.columns ?? {}) as SheetMapping, read, columns.switchCol)
      : null;

    const statusWrites = columns.statusCol != null
      ? await writeStatusCells({
        orgId: binding.orgId, org: binding.org, agentStatusCol: columns.statusCol,
        skipped: rows?.skipped ?? [], rows: read.rows, connector: deps.connector, ref, nowMs: deps.nowMs(),
      })
      : 0;

    // Row-level failures (a lock, a stale version, …) never touch the
    // consecutive-failure counter or flip `status` to "error" — the sheet
    // read itself succeeded. They still deserve a visible trail, so the
    // count rides `lastError` while `status` stays "connected"; a clean pass
    // clears it the same way a good connector read always has. Missing
    // agent columns take precedence: that is the one a dispatcher must act on.
    //
    // A tick with row errors does NOT advance `lastVersion`: "retried next
    // sync" has to be true even when nobody edits the sheet again — the
    // version is a content digest now (C1), so nothing else would ever
    // bump it — and re-running an unchanged row pass is cheap (every
    // untouched row is `unchanged`, no write).
    const rowErrors = rows !== null && rows.rowErrorCount > 0;
    const rowsLastError = rowErrors ? `${rows.rowErrorCount} rows skipped — see log` : null;
    const version = rowErrors ? binding.lastVersion ?? "" : read.version;
    await recordSuccess(bindingId, version, deps.nowMs(), binding.status === "error", columnsError ?? rowsLastError);
    return {
      created: rows?.created ?? 0, updated: rows?.updated ?? 0, unchanged: rows?.unchanged ?? 0,
      skipped: rows?.skipped ?? [], read: rows ? read.rows.length : 0, statusWrites, error: null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordFailure(bindingId, message);
    return { ...emptyReport(), error: message };
  }
}

/** Every `connected` binding, once — plus every `error` binding that has sat
 *  untouched for `ERROR_RETRY_MS` (final fix wave, I11: an outage must not
 *  park a binding in "error" forever; a success flips it back to
 *  "connected" through `recordSuccess`). Never throws — a binding whose
 *  connector or writer fails is reported (and traced via `syncBinding`'s own
 *  failure counting) and the rest still run. Logged failures name the
 *  binding, never the token: `SheetBinding.refreshToken` never appears in
 *  this file. */
export async function syncAllSheets(overrides?: {
  connectorFor?: (binding: Parameters<typeof connectorFor>[0] & { id: string }) => SheetConnector;
  nowMs?: () => number;
}): Promise<SyncReport[]> {
  const buildConnector = overrides?.connectorFor ?? connectorFor;
  const nowMs = overrides?.nowMs ?? (() => Date.now());
  const bindings = await prisma.sheetBinding.findMany({
    where: { OR: [{ status: "connected" }, { status: "error", updatedAt: { lt: new Date(nowMs() - ERROR_RETRY_MS) } }] },
  });

  const reports: SyncReport[] = [];
  for (const binding of bindings) {
    try {
      const connector = buildConnector(binding);
      reports.push(await syncBinding(binding.id, { connector, nowMs }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("sheet sync failed", { bindingId: binding.id, error: message });
      reports.push({ ...emptyReport(), error: message });
    }
  }
  return reports;
}
