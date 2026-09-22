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
import { applyLoadChange, applyStatusChange, attentionAspect, nextAtMs, rendered, type LoadPatch } from "../loadWriter.js";
import { applyAgentSwitch } from "../agentSwitch.js";
import { ACTIVE_STATUSES } from "../activeStatuses.js";
import { emitLoadChanged } from "../loadEvents.js";
import { DEFAULT_EQUIPMENT } from "../brokerImport.js";
import { LoadLocked } from "../loadLocks.js";
import { settlePendingStops } from "../geocodeSettle.js";
import { attentionDiffers, patchDiffers } from "./rowDiff.js";
import { AGENT_COLUMN_NAMES } from "./installColumns.js";
import { writeStatusCells, type SkippedRow } from "./statusPass.js";
import { foldPairs } from "./foldPairs.js";
import { digestOf, applyWrites } from "./digest.js";
import { runWriteBackPass } from "./writeBackPass.js";

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
  /** Fix round 1 (review of Slice 4, Tasks 3/4): non-null when this tick's
   *  vanished-row set looked like a whole-sheet accident (more than 5 rows
   *  AND over half the binding's mirrored loads) rather than ordinary
   *  deletions — nothing was archived or unlinked, and this becomes
   *  `SheetBinding.lastError` so both the Connect page and Task 4's email
   *  surface it. Null on every ordinary tick, including one that DID
   *  perform the 3-consecutive-ticks bulk unlink (that resolves the
   *  condition, so it clears like any other clean pass). */
  massVanishError: string | null;
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

async function syncRows(bindingId: string, orgId: string, mapped: MappedRow[]): Promise<Omit<RowsOutcome, "massVanishError">> {
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

    // Slice 4, Task 3 (ruling): a new row bearing an ARCHIVED load's number
    // creates nothing and re-links nothing — the load was archived because
    // its row vanished, and reusing its number is a dispatcher mistake, not
    // a resurrection. The row gets an attention cell instead
    // (`attentionCellFor` in statusPass.ts), the same "sheet's own problem"
    // treatment as a missing or duplicated load number.
    if (existing && existing.status === "archived") {
      skipped.push({ rowIndex: row.rowIndex, reason: `archived load: "${result.loadRef}"` });
      continue;
    }

    // The switch is only consulted when its cell changed against what the
    // load last saw (`applySwitchChange`, which also records the new cell —
    // after the row's own content write, in its own transaction).
    // Fix round 1: every row this pass writes records WHICH binding mirrored
    // it — `sheetRowIndex` alone can't tell two connected sheets apart.
    const patch: LoadPatch = { ...result.patch, sheetBindingId: bindingId };
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
// Slice 4, Task 3: statuses a vanished load is already "done" in — its row
// leaving the sheet says nothing new, so it is neither archived nor stopped
// again.
const ALREADY_SETTLED_STATUSES = new Set(["archived", "delivered", "canceled"]);

/** Fix round 1, item 2: a whole-sheet accident (a filter, a bad paste, an
 *  "undo" that didn't) must never mass-archive — only a genuinely small,
 *  ordinary set of deletions gets the per-load treatment below. Module-level
 *  and per-binding, like `failures` above: it has to survive from one tick
 *  to the next to count to three. */
let massVanishStreak: Record<string, number> = {};

function massVanishMessage(vanishedCount: number, mirroredCount: number): string {
  return `${vanishedCount} of ${mirroredCount} rows vanished at once — nothing archived; check the sheet or click Sync now`;
}

interface VanishOutcome { massVanishError: string | null }

/** One vanished load's disposition, applied inside its own transaction —
 *  same per-load try/catch grain as the rest of this file: one bad load
 *  never blocks the rest. `isDuplicated` (both of a duplicated ref's rows
 *  still present) only ever unlinks — the load isn't gone, its number is
 *  just ambiguous this tick. Fix round 1, item 1: a load an Assignment (or
 *  an active status) still occupies is never archived or stopped either —
 *  its row leaving the sheet is not permission to end a trip a driver is
 *  mid-way through; it only unlinks, with one line explaining why. */
async function settleVanishedLoad(
  orgId: string,
  load: { id: string; status: string; agentEnabled: boolean; boardLoadNo: string | null; assignment: { id: string } | null },
  isDuplicated: boolean,
): Promise<void> {
  try {
    const write = await prisma.$transaction(async (tx) => {
      const unlinked = await applyLoadChange(tx, {
        loadId: load.id, orgId, actor: SHEET_ACTOR, source: "sheet", patch: { sheetRowIndex: null, sheetBindingId: null },
      });
      let version = unlinked.version;
      const changed = [...unlinked.changed];
      const hasActiveAssignment = load.assignment !== null || ACTIVE_STATUSES.includes(load.status);

      if (isDuplicated) {
        // Unlink only — the existing I6 behaviour; nothing else to say.
      } else if (hasActiveAssignment) {
        await tx.agentUpdate.create({
          data: { loadId: load.id, atMs: nextAtMs(), kind: "status", text: "row removed from sheet — load kept, it has an active assignment" },
        });
      } else if (!ALREADY_SETTLED_STATUSES.has(load.status)) {
        const archived = await applyStatusChange(tx, {
          loadId: load.id, orgId, actor: SHEET_ACTOR, source: "sheet", status: "archived", note: "row removed from sheet",
        });
        version = archived.version;
        changed.push("status");
        if (load.agentEnabled) {
          const stopped = await applyAgentSwitch(tx, { loadId: load.id, orgId, actor: SHEET_ACTOR, source: "sheet", enabled: false });
          version = stopped.version;
          changed.push(...stopped.changed);
        }
        await tx.agentUpdate.create({ data: { loadId: load.id, atMs: nextAtMs(), kind: "status", text: "row removed from sheet" } });
      }
      return { version, changed };
    });
    if (write.changed.length > 0) emitLoadChanged(orgId, { loadId: load.id, version: write.version, fields: write.changed });
  } catch (e) {
    console.error("sheet sync: could not forget a vanished row", { loadId: load.id, error: rowErrorReason(e) });
  }
}

/** The persisted-mass-vanish path's own disposition: unlink, nothing else —
 *  no archive, no stop, no attention line, for ANY load, active assignment
 *  or not. "Never archive in bulk" (fix round 1, item 2) means never, not
 *  "unless the per-load rules would have allowed it" — a load this path
 *  reaches already survived the accident-vs-real-deletion question by
 *  outlasting it three ticks running; only its link to the sheet is cut. */
async function bulkUnlinkOnly(orgId: string, load: { id: string }): Promise<void> {
  try {
    const write = await prisma.$transaction((tx) => applyLoadChange(tx, {
      loadId: load.id, orgId, actor: SHEET_ACTOR, source: "sheet", patch: { sheetRowIndex: null, sheetBindingId: null },
    }));
    if (write.changed.length > 0) emitLoadChanged(orgId, { loadId: load.id, version: write.version, fields: write.changed });
  } catch (e) {
    console.error("sheet sync: could not bulk-unlink a mass-vanished row", { loadId: load.id, error: rowErrorReason(e) });
  }
}

async function forgetVanishedRows(bindingId: string, orgId: string, mapped: MappedRow[]): Promise<VanishOutcome> {
  const counts = countLoadRefs(mapped);
  const presentRefs = new Set([...counts].filter(([, n]) => n === 1).map(([ref]) => ref));
  const duplicatedRefs = new Set([...counts].filter(([, n]) => n > 1).map(([ref]) => ref));

  // One query for every load this binding currently mirrors — vanished and
  // still-present alike — so `mirroredCount` (the mass-vanish ratio's
  // denominator) needs no second round-trip.
  const mirrored = await prisma.load.findMany({
    where: { orgId, sheetBindingId: bindingId, sheetRowIndex: { not: null } },
    select: { id: true, status: true, agentEnabled: true, boardLoadNo: true, assignment: { select: { id: true } } },
  });
  const vanished = mirrored.filter((l) => l.boardLoadNo === null || !presentRefs.has(l.boardLoadNo));

  if (vanished.length === 0) {
    massVanishStreak = { ...massVanishStreak, [bindingId]: 0 };
    return { massVanishError: null };
  }

  // Fix round 1, item 2: more than 5 rows AND over half of what this
  // binding mirrors vanishing in ONE tick reads as an accident, not a
  // dispatcher's ordinary deletions.
  const isMassVanish = vanished.length > 5 && vanished.length > mirrored.length * 0.5;
  if (isMassVanish) {
    const streak = (massVanishStreak[bindingId] ?? 0) + 1;
    massVanishStreak = { ...massVanishStreak, [bindingId]: streak };
    if (streak < 3) {
      // Blocked: touch nothing this tick. `lastError` still moves (the
      // count can change tick to tick), which is what re-triggers Task 4's
      // email on a worsening or still-ongoing outage.
      return { massVanishError: massVanishMessage(vanished.length, mirrored.length) };
    }
    // Persisted three consecutive ticks: the dispatcher isn't coming back to
    // fix it (or really did mean to clear the sheet) — unlink everything so
    // the pill stops fighting a row that no longer exists, but still never
    // archive in bulk; an active trip stays exactly as protected as it is
    // in the ordinary per-load path.
    for (const load of vanished) await bulkUnlinkOnly(orgId, load);
    massVanishStreak = { ...massVanishStreak, [bindingId]: 0 };
    return { massVanishError: null };
  }

  massVanishStreak = { ...massVanishStreak, [bindingId]: 0 };
  for (const load of vanished) {
    const isDuplicated = load.boardLoadNo !== null && duplicatedRefs.has(load.boardLoadNo);
    await settleVanishedLoad(orgId, load, isDuplicated);
  }
  return { massVanishError: null };
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
  const vanishOutcome = await forgetVanishedRows(bindingId, orgId, mapped);
  const settled = await settlePendingStops(orgId, rows.touched);
  for (const s of settled) emitLoadChanged(orgId, { loadId: s.loadId, version: s.version, fields: s.roles });
  return { ...rows, massVanishError: vanishOutcome.massVanishError };
}

/** The read with its rows folded one-per-load (foldPairs.ts) and its header
 *  extended with `ORDER REF`. The fold never drops a row. */
function foldLoads(read: SheetRead, mapping: SheetMapping): SheetRead {
  const folded = foldPairs(read.rows, read.header, mapping);
  return { ...read, rows: folded.rows, header: folded.header };
}

export async function syncBinding(bindingId: string, deps: SyncDeps): Promise<SyncReport> {
  try {
    const binding = await prisma.sheetBinding.findUniqueOrThrow({
      where: { id: bindingId },
      include: { org: { select: { id: true, timezone: true, linkSecret: true } } },
    });
    const ref: TabRef = { spreadsheetId: binding.spreadsheetId, tabId: binding.tabId };
    const read = await deps.connector.readRows(ref, binding.headerRow, binding.lastVersion ?? undefined);
    const mapping = (binding.columns ?? {}) as SheetMapping;
    // Two-rows-per-load sheets: every pass below (rows, switch, status,
    // vanished) reads `loads` — the sheet's rows folded one-per-load when
    // the binding says so, the read as-is otherwise. The agent columns are
    // located on the ORIGINAL header (the fold only appends to it).
    const loads = binding.rowsPerLoad === 2 ? foldLoads(read, mapping) : read;

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
      ? await rowPass(bindingId, binding.orgId, binding.org.timezone, deps.nowMs(), mapping, loads, columns.switchCol)
      : null;

    // `rows: read.rows` — the UNFOLDED rows, always, even for a `rowsPerLoad
    // === 2` binding (Task 1): the switch/status columns fold "top row
    // only", so a folded row's cell there is identical to the raw top row's,
    // and `rowsAfter` below must be in the same row space `digestOf` hashes
    // (the connector never sees the fold — that is downstream of the read).
    const statusResult = columns.statusCol != null
      ? await writeStatusCells({
        orgId: binding.orgId, bindingId, org: binding.org, agentStatusCol: columns.statusCol,
        skipped: rows?.skipped ?? [], rows: read.rows, connector: deps.connector, ref, nowMs: deps.nowMs(),
      })
      : { count: 0, rowsAfter: read.rows };
    const statusWrites = statusResult.count;

    // Task 2: board/paste/loadboard edits of a mirrored load flow back into
    // the sheet every tick the sheet was read — changed or not, since a
    // board edit has nothing to do with whether a human touched the sheet
    // since the last tick. Runs against THIS tick's raw rows/header (the
    // same row space `Load.sheetRowIndex` and `hasBottomByRow` live in),
    // never the folded ones.
    const writeBackResult = await runWriteBackPass({
      orgId: binding.orgId, bindingId, boardSyncAtMs: binding.boardSyncAtMs, mapping,
      rowsPerLoad: binding.rowsPerLoad === 2 ? 2 : 1, header: read.header, rows: read.rows,
      connector: deps.connector, ref,
    });

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
    //
    // Task 1: when the status pass wrote at least one cell, `lastVersion`
    // is the PREDICTED post-write digest (`statusResult.rowsAfter`, already
    // in the unfolded row space `read.rows`/`read.header` hash) rather than
    // `read.version` — the version this tick actually read, before that
    // write landed. Without this, our own status write always changes the
    // sheet's real digest, so the very next tick reads it as "changed" and
    // pays for a row pass that finds nothing new. When nothing was written,
    // `read.version` stands exactly as before. Task 2: the write-back pass's
    // own cells land on TOP of the status pass's predicted rows the same
    // way, so a board edit that reaches an otherwise-idle sheet is just as
    // invisible to the next tick's read.
    const rowErrors = rows !== null && rows.rowErrorCount > 0;
    const rowsLastError = rowErrors ? `${rows.rowErrorCount} rows skipped — see log` : null;
    // Fix round 1, item 2: a blocked mass-vanish tick reports through
    // `lastError` (status stays "connected" via `recordSuccess`'s own
    // `wasError` rule) so both the Connect page and Task 4's sync-failure
    // email surface it the same way any other sheet trouble does.
    const massVanishError = rows?.massVanishError ?? null;
    const version = rowErrors
      ? binding.lastVersion ?? ""
      : statusWrites > 0 || writeBackResult.writes.length > 0
        ? digestOf([read.header, ...applyWrites(statusResult.rowsAfter, writeBackResult.writes).map((r) => r.cells)])
        : read.version;
    await recordSuccess(bindingId, version, deps.nowMs(), binding.status === "error", columnsError ?? massVanishError ?? rowsLastError);
    return {
      created: rows?.created ?? 0, updated: rows?.updated ?? 0, unchanged: rows?.unchanged ?? 0,
      skipped: rows?.skipped ?? [], read: rows ? loads.rows.length : 0, statusWrites, error: null,
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
