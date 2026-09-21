import { Prisma } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../db.js";
import { advanceContext, mergePatch, planToPatch, splitAddress, type PatchContext } from "../lib/boardCellApply.js";
import { actorOf } from "../lib/actor.js";
import { applyLoadChange, LoadNotFound, nextAtMs, rulesFor, StaleVersion, type LoadPatch } from "../lib/loadWriter.js";
import { acquireLoadLock, assertWritable, LoadLocked, LockTargetGone, releaseLoadLock } from "../lib/loadLocks.js";
import { parseApptText } from "../lib/apptText.js";
import { matchRule } from "../lib/updateVocabulary.js";
import { planCellWrite } from "../lib/boardCellWrite.js";
import { layoutFor, type BoardColumn, type BoardColumnKey } from "../lib/boardLayout.js";
import { parseIdList } from "../lib/idList.js";
import { boardLoadNo, buildPreview, confirmImport, isBrokered } from "../lib/brokerImport.js";
import type { CellsByKey } from "../lib/brokerSheet.js";
import { boardWorkbook, renderBoardRows } from "../lib/brokerExport.js";
import { settlePendingStops } from "../lib/geocodeSettle.js";
import { emitLoadChanged, emitLoadsChanged } from "../lib/loadEvents.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The Broker Board (spec §4, §11): their sheet, read from our tables. Slice 1
// is read-only plus import; cell edits arrive in slice 2, the agent in slice 3.
export const dispatcherBrokerBoardRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Rejects a no-org dispatcher before multer buffers their upload — the file
// (bounded to 5 MB, but still real work) is never read for a request that is
// going to 400 anyway.
const requireOrg = (req: Request, res: Response, next: NextFunction) =>
  req.orgScope ? next() : res.status(400).json({ error: "Importing a board requires an org-scoped dispatcher account" });

// multer's own errors (oversize file, wrong field) call next(err) directly,
// which bypasses the route handler's try/catch entirely and would otherwise
// fall through to errorHandler.ts's generic 500 — treating a routine, fully
// foreseeable client mistake (uploading >5 MB) as a server fault worth
// logging. This turns any multer failure into the same 400 shape the
// handlers already use for a bad workbook.
const receiveWorkbook = (req: Request, res: Response, next: NextFunction): void => {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    res.status(400).json({ error: code === "LIMIT_FILE_SIZE" ? "The workbook is larger than 5 MB" : "Could not read the upload" });
  });
};

function fileOf(req: { file?: { buffer: Buffer; originalname: string } }): Buffer | null {
  const f = req.file;
  if (!f || !/\.xlsx$/i.test(f.originalname)) return null;
  return f.buffer;
}

dispatcherBrokerBoardRouter.post("/broker-board/import", requireOrg, receiveWorkbook, asyncRoute(async (req, res) => {
  // requireOrg already refused a null orgScope; re-checked here only as a
  // type guard so `orgId` narrows to `string` for buildPreview below.
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Importing a board requires an org-scoped dispatcher account" });
  const buf = fileOf(req);
  if (!buf) return res.status(400).json({ error: "Attach the board as an .xlsx file in the 'file' field" });
  try {
    res.json({ preview: await buildPreview(orgId, buf) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "could not read the workbook" });
  }
}));

dispatcherBrokerBoardRouter.post("/broker-board/import/confirm", requireOrg, receiveWorkbook, asyncRoute(async (req, res) => {
  // requireOrg already refused a null orgScope; re-checked here only as a
  // type guard so `orgId` narrows to `string` for confirmImport below.
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Importing a board requires an org-scoped dispatcher account" });
  const buf = fileOf(req);
  if (!buf) return res.status(400).json({ error: "Attach the board as an .xlsx file in the 'file' field" });
  try {
    const result = await confirmImport(orgId, buf);
    emitLoadsChanged(orgId, result.changes);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "could not import the workbook" });
  }
}));

const money = (c: number | null): string => (c === null ? "" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const usDate = (d: Date | null): string => (d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` : "");

// The GET's query + row rendering, shared with the export route: both need
// the same board rows in the same order, rendered the same way. `ids` and
// `includeArchived` are independent filters, always ANDed together with the
// org filter — never one instead of the other. Plan A4: a GET re-reading
// specific ids off the *visible* board (archived hidden by default) must
// still drop a row that archived out from under it, so `ids` cannot be
// allowed to silently waive the archived filter. A caller that wants a
// specific selection regardless of archived state (export) says so
// explicitly by passing `includeArchived: true` itself — see the export
// route below — rather than relying on `ids` to imply it here.
/** "PU 07/14 12:00 · DEL 07/20 07:00" in the org's zone — what the record
 *  holds, for the mark on an APPT cell whose text says otherwise. */
const clockIn = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "");

async function boardRows(orgId: string, includeArchived: boolean, ids?: string[]) {
  const loads = await prisma.load.findMany({
    where: { orgId, ...(ids ? { id: { in: ids } } : {}), ...(includeArchived ? {} : { status: { not: "archived" } }) },
    // Their order is the sheet's order: confirmImport writes each pair's
    // boardLine from its row on the sheet, so a re-import that moves a row
    // moves it on the board. A load with no boardLine (never came from a
    // sheet) sorts after every sheet row, in creation order.
    include: { carrier: true, stops: { orderBy: { sequence: "asc" }, include: { appointment: true } }, agentUpdates: { orderBy: { atMs: "desc" } } },
    orderBy: [{ boardLine: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  // The marks need the org's words and zone once, not per row.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const tz = org?.timezone ?? "America/Chicago";
  const rules = await prisma.$transaction((tx) => rulesFor(tx, orgId));
  return loads.map((l, i) => {
    // By ROLE, never by position: a load with an odd stop set showed the
    // wrong city in the wrong column (spec §16.4).
    const pu = l.stops.find((s) => s.type === "pickup");
    const del = l.stops.find((s) => s.type === "delivery");
    // A brokered row is one their board owns; a TMS fleet load renders as a
    // single plain row — no "MC" label, no empty carrier row under it (§15).
    const brokered = isBrokered(l);
    // Their sheet prints "MC" on every brokered customer row, carrier booked or not; a fleet load has no such label.
    //
    // `!== null`, not truthiness (slice 2B): the importer writes null for a
    // carrier field it never saw (`nz()`), so a TMS or fleet load still has
    // no second line. An empty STRING is a different statement — it is the
    // carrier line a dispatcher asked for and has not filled in yet, which is
    // what "+ load" creates. Without the distinction a new blank row had
    // nowhere to type a carrier: the line only appeared once the carrier was
    // typed, and it could not be typed until the line appeared.
    // R1 (pre-flight ruling): a LOAD# typed on the carrier line IS the
    // carrier line existing, so `boardLoadNo` also has to open the row —
    // otherwise a number typed with no other carrier field yet has nowhere
    // to render and the row that holds it renders as null.
    const hasCarrierRow = l.carrierId !== null || l.carrierPhone !== null || l.carrierContactName !== null || l.boardLoadNo !== null;
    const attentions = l.agentUpdates.filter((a) => a.kind === "attention");
    // The board never prints a money number nobody typed: a refused RATE
    // leaves RATE and PROFIT blank, and the pill says why.
    const rateUnknown = attentions.some((a) => a.text.startsWith("can't read RATE"));
    const apptLines = (l.apptText ?? "").split("\n");
    const top: CellsByKey = {
      bol: l.bolNumber ?? "", customer: l.customerName ?? "", phone: l.trackingUrl ?? "", contact: "",
      pickupCity: pu?.address.replace(/\s\d{5}$/, "") ?? "", puZip: pu?.address.match(/(\d{5})$/)?.[1] ?? "",
      delZip: del?.address.match(/(\d{5})$/)?.[1] ?? "", deliveryCity: del?.address.replace(/\s\d{5}$/, "") ?? "",
      rate: rateUnknown ? "" : money(l.revenueCents),
      soldRate: money(l.soldRateCents),
      profit: rateUnknown || l.soldRateCents === null ? "" : money(l.revenueCents - l.soldRateCents),
      mc: brokered ? "MC" : "", loadNo: l.orderRef ?? "", shipDate: usDate(l.shipDate), update: l.updateText ?? "",
      // Line 1 sits on the top row; with no carrier row under it, every line
      // stays here so nothing a human typed disappears off the board.
      appt: hasCarrierRow ? (apptLines[0] ?? "") : apptLines.join(" / "),
    };
    const bottom: CellsByKey | null = hasCarrierRow
      ? {
          customer: l.carrier?.name ?? "", phone: l.carrierPhone ?? "", contact: l.carrierContactName ?? "",
          mc: l.carrier?.mcNumber ?? "",
          // The carrier line's LOAD# is the board's own column. It used to
          // render from externalId while the cell editor wrote boardLoadNo,
          // so a typed number vanished on refresh (spec §16.1). The prefix
          // trick from slice 1 still feeds loads imported before the column
          // existed.
          loadNo: l.boardLoadNo ?? (brokered ? boardLoadNo(l.externalId) : ""),
          appt: apptLines.slice(1).join(" / "),
        }
      : null;
    // Every unresolved refusal is in the tooltip; one attention hiding behind
    // a newer one is how a blank RATE stayed invisible (§6.1).
    const pill = attentions.length
      ? { state: "attention" as const, text: attentions.map((a) => a.text).join(" · ") }
      : { state: "none" as const, text: null };
    const latestLine = l.agentUpdates.find((a) => a.kind !== "attention") ?? null;
    // The marks (spec §10): a cell is never rewritten, but a cell that
    // disagrees with the record says so.
    const record: { update?: string; appt?: string } = {};
    const rule = matchRule(l.updateText, rules);
    if (rule) {
      const implied = rule.status === "assigned" && l.carrierId === null ? "open" : rule.status;
      if (implied !== l.status) record.update = l.status;
    }
    if (l.apptText) {
      const year = l.shipDate ? l.shipDate.getUTCFullYear() : new Date().getUTCFullYear();
      const parsed = parseApptText(l.apptText.split(/\r?\n/).filter((x) => x.trim() !== ""), { year, tz });
      // Only a line that PARSES to a different window disagrees. A line the
      // cell simply does not have (a one-line APPT cell says nothing about
      // the other stop) is not a disagreement — treating it as one gave a
      // single-line cell BOTH the `can't read PU appointment` pill and a
      // `record.appt` dot for the same one fact (spec §10: the mark is for a
      // cell that contradicts the record, not for one that is silent).
      const disagree = (w: { endMs: number } | null, a: { windowEnd: Date } | null | undefined): boolean =>
        !!a && !!w && a.windowEnd.getTime() !== w.endMs;
      if (disagree(parsed.pu, pu?.appointment) || disagree(parsed.del, del?.appointment)) {
        const parts = [pu?.appointment ? `PU ${clockIn(pu.appointment.windowEnd, tz)}` : null, del?.appointment ? `DEL ${clockIn(del.appointment.windowEnd, tz)}` : null].filter(Boolean);
        record.appt = parts.join(" · ");
      }
    }
    return {
      id: l.id, line: i + 1, status: l.status, boardLine: l.boardLine, version: l.version, top, bottom, pill,
      agentLine: latestLine ? { text: latestLine.text, atMs: Number(latestLine.atMs) } : null,
      // Night Shift (spec §17, Task 3): the switch, the policy it runs under,
      // and the pill the board paints — plain Load columns, already on `l`
      // since this query uses `include` (every scalar comes along for free).
      agentEnabled: l.agentEnabled, agentPolicyId: l.agentPolicyId, agentPill: l.agentPill,
      ...(Object.keys(record).length ? { record } : {}),
    };
  });
}

const boardQuerySchema = z.object({
  archived: z.enum(["0", "1"]).optional(),
  // Comma-separated. Absent = the whole board; present = re-read exactly
  // these rows (plan A4, spec §9). An id that is not in the answer is a row
  // the client must drop, not a row it should keep as-is.
  ids: z.string().optional(),
});

dispatcherBrokerBoardRouter.get("/broker-board", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = boardQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "archived must be 0 or 1; ids must be a comma-separated list" });
  const layout: BoardColumn[] = await layoutFor(orgId);
  const includeArchived = parsed.data.archived === "1";
  const ids = parseIdList(parsed.data.ids);
  const loads = await boardRows(orgId, includeArchived, ids);
  res.json({ layout, loads });
}));

// --- Writing one cell (slice 2B) -------------------------------------------
//
// The board is editable from here on. `planCellWrite` decides where a cell
// goes and refuses the ones nobody can honestly type; `planToPatch` turns the
// plan into a `LoadPatch` and `applyLoadChange` — the one writer (spec §4) —
// does all the writing inside one transaction, deriving stops, appointments
// and status from it. The answer is the load's freshly rendered rows, so the
// grid redraws from the server's truth (a PROFIT the dispatcher never typed,
// a ZIP that survived a city edit) instead of guessing what its own edit did,
// plus `statusRefused`: the sentence the writer refused a status move with,
// which the board shows verbatim rather than silently dropping.
const cellSchema = z.object({
  row: z.enum(["top", "bottom"]),
  key: z.string().min(1).max(60),
  source: z.string().max(200).optional(),
  value: z.string().max(2000),
  // The version backstop (spec §7.4): every write carries the version it was
  // rendered from, so a view that has moved on refuses rather than clobbers.
  baseVersion: z.number().int().min(0),
});

const DUPLICATE_LOAD_NO = "That LOAD# is already on this board";
const NO_DISPATCHER = "The board requires a signed-in dispatcher";

/** Express 4 with no error middleware sends NO RESPONSE for a rejected async
 *  handler — the button spins forever (the pattern documented at
 *  `src/routes/dispatcherLoads.ts:161-169`). Every board write route ends its
 *  catch here instead of re-throwing, so an unmodelled failure is a clean 500
 *  the dispatcher can act on. */
function unhandledWrite(res: Response, where: string, e: unknown): Response {
  console.error(`broker-board ${where} failed`, e);
  return res.status(500).json({ error: "That did not go through — try again" });
}

/** What the translator needs from the load to compose APPT lines, extras and
 *  the other half of a stop's address. */
async function patchContext(tx: Prisma.TransactionClient, orgId: string, loadId: string): Promise<PatchContext> {
  // findFirst with the org on the WHERE, not findUnique by id: a foreign id
  // in a paste body used to be read here (its APPT text, its extras, its stop
  // addresses) before the writer got as far as refusing it.
  const load = await tx.load.findFirst({ where: { id: loadId, orgId }, select: { apptText: true, extras: true, stops: { select: { type: true, address: true } } } });
  const ctx: PatchContext = { apptText: load?.apptText ?? null, extras: load?.extras ?? null, stopCity: {}, stopZip: {} };
  for (const s of load?.stops ?? []) {
    if (s.type !== "pickup" && s.type !== "delivery") continue;
    const parts = splitAddress(s.address);
    ctx.stopCity![s.type] = parts.city;
    ctx.stopZip![s.type] = parts.zip;
  }
  return ctx;
}

dispatcherBrokerBoardRouter.patch("/broker-board/loads/:id/cell", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = cellSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });

  // Org scoping is on the query, so a foreign id is never even read.
  const load = await prisma.load.findFirst({
    where: { id: req.params.id as string, orgId },
    select: { id: true, orgId: true, carrierId: true, apptText: true, extras: true },
  });
  if (!load) return res.status(404).json({ error: "That load was not found" });

  const plan = planCellWrite({ row: parsed.data.row, key: parsed.data.key as BoardColumnKey, source: parsed.data.source, value: parsed.data.value });
  if (plan.kind === "refuse") return res.status(400).json({ error: plan.reason });
  const actor = await actorOf(req);
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const patch = planToPatch(plan, await patchContext(tx, orgId, load.id));
      return applyLoadChange(tx, { loadId: load.id, orgId, actor, source: "board", patch, baseVersion: parsed.data.baseVersion });
    }, { timeout: 15_000 });
  } catch (e) {
    if (e instanceof LoadNotFound) return res.status(404).json({ error: "That load was not found" });
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleVersion) {
      // Both values, so the cell can offer keep mine / take theirs (spec §7.4).
      const [fresh] = await boardRows(orgId, true, [load.id]);
      // R12b: an EXTRA column is not in the rendered `top`/`bottom` maps at
      // all (those are `CellsByKey` — the known columns), so reading
      // `cells[key]` for one answered `theirs: ""` and the conflict panel
      // offered "take theirs: (blank)" for a value that was not blank. The
      // extras live on the load row, keyed exactly as the plan keys them
      // (`SOURCE` on the top line, `SOURCE:2` on the carrier line).
      let theirs: string;
      if (plan.kind === "extras") {
        const row = await prisma.load.findFirst({ where: { id: load.id, orgId }, select: { extras: true } });
        theirs = String((row?.extras as Record<string, string> | null)?.[plan.key] ?? "");
      } else {
        const cells = parsed.data.row === "top" ? fresh?.top : fresh?.bottom;
        theirs = cells?.[parsed.data.key as keyof typeof cells] ?? "";
      }
      return res.status(409).json({ error: "STALE_VERSION", current: e.current, theirs, load: fresh });
    }
    // The board's own LOAD# is unique per org: two rows claiming one number
    // is a typo the dispatcher has to see, not a merge we perform quietly.
    if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: DUPLICATE_LOAD_NO });
    return unhandledWrite(res, "cell", e);
  }
  // Anything the gazetteer could not place is asked of the configured
  // provider now — after the commit, out of the transaction — so the row we
  // answer with already carries the coordinates and has lost the refusal.
  const settled = await settlePendingStops(orgId, [load.id]);
  const [row] = await boardRows(orgId, true, [load.id]);
  // F11: only when a field actually moved. A cell rewritten with the value it
  // already held is not a change, and a `load_changed` for it makes every
  // other board redraw a row that did not move — the same rule the paste
  // below has always applied.
  if (result.changed.length > 0) emitLoadChanged(orgId, { loadId: load.id, version: result.version, fields: result.changed });
  // M6: the settle above may have placed a stop the writer left pending, in
  // its OWN transaction and version bump — a fact the cell write above
  // knows nothing about. `row` is already read after the settle, so its own
  // `version` is the honest one to answer with; `result.version` would be
  // one behind whenever this fired.
  const settledHere = settled.find((s) => s.loadId === load.id);
  if (settledHere) emitLoadChanged(orgId, { loadId: settledHere.loadId, version: settledHere.version, fields: settledHere.roles });
  res.json({ load: row, version: row?.version ?? result.version, statusRefused: result.statusRefused });
}));

// --- Writing many cells: a paste (slice 2B) --------------------------------
const TOO_MANY_CELLS = "Paste at most 500 cells at a time";
const cellsSchema = z.object({ cells: z.array(cellSchema.extend({ loadId: z.string().min(1) })).min(1).max(500, TOO_MANY_CELLS) });

// §7.2: a paste that reaches a load someone else holds refuses the whole
// block, naming the holder and the LOAD#s — nothing partial lands. §7.4's
// version backstop applies to the block as a whole: any target that moved
// since it was copied refuses the paste before a single cell lands.
class PasteLocked extends Error {
  constructor(public readonly holders: Array<{ loadId: string; loadNo: string; by: string }>) { super("locked"); }
}
class PasteStale extends Error {
  constructor(public readonly loadIds: string[]) { super("stale"); }
}

const PASTE_STALE_MESSAGE = "Some rows changed since you copied them — reload the board and paste again";

/** The paste's refusals as DATA, so the route can release its locks before it
 *  answers (see the `finally` in the handler). */
function pasteRefusal(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof LockTargetGone || e instanceof LoadNotFound) return { status: 404, body: { error: "One or more loads were not found" } };
  if (e instanceof PasteLocked) {
    const by = [...new Set(e.holders.map((h) => h.by))].join(", ");
    return { status: 409, body: { error: "LOAD_LOCKED", holders: e.holders, message: `${by} is editing ${e.holders.map((h) => h.loadNo).join(", ")} — try again when the badge clears` } };
  }
  if (e instanceof PasteStale) return { status: 409, body: { error: "STALE_VERSION", loadIds: e.loadIds, message: PASTE_STALE_MESSAGE } };
  if (e instanceof LoadLocked) return { status: 409, body: { error: "LOAD_LOCKED", lock: e.lock, message: e.message } };
  if (e instanceof StaleVersion) return { status: 409, body: { error: "STALE_VERSION", loadIds: [], message: PASTE_STALE_MESSAGE } };
  if ((e as { code?: string }).code === "P2002") return { status: 409, body: { error: DUPLICATE_LOAD_NO } };
  console.error("broker-board paste failed", e);
  return { status: 500, body: { error: "That did not go through — try again" } };
}

dispatcherBrokerBoardRouter.post("/broker-board/cells", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = cellsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  const { cells } = parsed.data;

  // Plan everything before writing anything: one unreadable cell refuses the
  // whole paste. Two thirds of a pasted block is a board that matches neither
  // what they had nor what they meant.
  const plans = cells.map((c) => planCellWrite({ row: c.row, key: c.key as BoardColumnKey, source: c.source, value: c.value }));
  const refused = plans.find((p) => p.kind === "refuse");
  if (refused && refused.kind === "refuse") return res.status(400).json({ error: refused.reason });

  const ids = [...new Set(cells.map((c) => c.loadId))];

  // R12a: the paste runs behind `attachOrgScope`, which 403s a dispatcher
  // with no id, so `actor.dispatcherId` IS a string here. Asserted once and
  // passed through unchanged — the old `?? ""` coerced it into a value the
  // writer's own `assertWritable` compares raw, which would have made the
  // paster's lock and the writer's gate disagree if it were ever reachable.
  const actor = await actorOf(req);
  if (!actor.dispatcherId) return res.status(400).json({ error: NO_DISPATCHER });
  const dispatcherId = actor.dispatcherId;

  // F1(a)/F3: ownership BEFORE anything else touches these ids. Two reasons,
  // both load-bearing. (1) A foreign id used to reach `acquireLoadLock`,
  // which would answer with the other tenant's holder name — a cross-tenant
  // oracle. (2) A deleted id used to reach the lock's foreign key. The
  // writer's own `LoadNotFound` was the only check, and it ran too late.
  const owned = await prisma.load.findMany({ where: { id: { in: ids }, orgId }, select: { id: true } });
  if (owned.length !== ids.length) return res.status(404).json({ error: "One or more loads were not found" });

  // ONE writer call per load, however many cells landed on it: the version
  // bumps once per paste (not once per cell), the trace is one batch, and
  // the second cell sees the first — an APPT line spliced beside another, a
  // city composed with the ZIP pasted next to it — through the advanced
  // context. The writer re-reads the load inside the transaction; the
  // `LoadNotFound` it throws for a foreign or missing id covers the
  // ownership pre-check, and the transaction rolls back whatever landed.
  const written = new Map<string, { version: number; fields: string[] }>();
  // A status a cell asked for and the record refused (spec §6.3). The cell
  // route has always answered with its sentence; a paste dropped it on the
  // floor, so a dispatcher who pasted a column of UPDATEs over loads their
  // own drivers run saw nothing at all happen and no reason why.
  const refusals: { loadId: string; sentence: string }[] = [];
  // F1(b): the targets are locked BEFORE the write transaction opens, on the
  // autocommit client, and released in the `finally` below however this ends.
  //
  // This is not a style choice. A first acquire races on the unique `loadId`
  // and a lost race arrives as P2002 — which `acquireLoadLock` catches and
  // turns into an orderly refusal. Prisma's interactive transactions have NO
  // savepoints, so a P2002 caught INSIDE one leaves the whole transaction
  // aborted (Postgres 25P02: "current transaction is aborted"); every
  // statement after it fails, including the release, and the request hangs.
  // Outside the transaction the same catch is simply a refusal.
  //
  // A fixed order (sorted ids) so two pasters overlapping on the same rows
  // cannot each hold half of the other's targets.
  const heldHere: string[] = [];
  let pasteRefused: { status: number; body: Record<string, unknown> } | null = null;
  try {
    // §7.2: every target is held for the write and released with it. A
    // target someone else holds refuses the whole paste, naming them and
    // the LOAD#s — nothing partial lands.
    const holders: Array<{ loadId: string; loadNo: string; by: string }> = [];
    for (const loadId of [...ids].sort()) {
      // `actor.name` is the session's own name (actorOf) — the extra
      // `dispatcher.findUnique` this used to do asked the database for a
      // fact the request already carried.
      const r = await acquireLoadLock(prisma, { loadId, orgId, dispatcherId, dispatcherName: actor.name });
      if (!r.ok) {
        const l = await prisma.load.findFirst({ where: { id: loadId, orgId }, select: { boardLoadNo: true, externalId: true } });
        holders.push({ loadId, loadNo: l?.boardLoadNo ?? (boardLoadNo(l?.externalId ?? null) || loadId), by: r.lock.by });
      } else if (r.fresh) heldHere.push(loadId);
    }
    if (holders.length > 0) throw new PasteLocked(holders);

    await prisma.$transaction(async (tx) => {
      // The version backstop for the block as a whole: any row that moved
      // since it was copied refuses the paste before a cell lands.
      const versions = await tx.load.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, version: true } });
      const base = new Map<string, number>();
      for (const c of cells) if (!base.has(c.loadId)) base.set(c.loadId, c.baseVersion);
      const stale = versions.filter((v) => base.get(v.id) !== v.version).map((v) => v.id);
      if (stale.length > 0) throw new PasteStale(stale);

      for (const loadId of ids) {
        let ctx = await patchContext(tx, orgId, loadId);
        let merged: LoadPatch = {};
        for (const [i, cell] of cells.entries()) {
          if (cell.loadId !== loadId) continue;
          const next = planToPatch(plans[i], ctx);
          merged = mergePatch(merged, next);
          ctx = advanceContext(ctx, next);
        }
        const r = await applyLoadChange(tx, { loadId, orgId, actor, source: "paste", patch: merged, baseVersion: base.get(loadId) });
        written.set(loadId, { version: r.version, fields: r.changed });
        if (r.statusRefused) refusals.push({ loadId, sentence: r.statusRefused });
      }
    }, { timeout: 30_000 });
  } catch (e) {
    // The refusal is COMPUTED here and sent after the `finally` below, never
    // from inside it: a client that reads the answer and immediately retries
    // must not find the locks this very call is still letting go of.
    pasteRefused = pasteRefusal(e);
  } finally {
    // Every target this call itself acquired is released — on success, on a
    // refusal, and on a throw. A lock the paster already held (re-affirmed,
    // not fresh) stays theirs. Best-effort: the TTL is the guarantee, and a
    // failure here must not replace the answer.
    for (const loadId of heldHere) {
      await releaseLoadLock(prisma, loadId, dispatcherId).catch((err: unknown) => console.error("paste lock release failed", err));
    }
  }
  if (pasteRefused) return res.status(pasteRefused.status).json(pasteRefused.body);
  const settled = await settlePendingStops(orgId, ids);
  const rows = await boardRows(orgId, true, ids);
  // Only the loads a cell actually changed: a paste that landed on a load
  // with nothing new to say is not a change, and a `load_changed` for it
  // makes every other board redraw a row that did not move.
  for (const [loadId, w] of written) {
    if (w.fields.length === 0) continue;
    emitLoadChanged(orgId, { loadId, version: w.version, fields: w.fields });
  }
  // M6: a stop the gazetteer missed and the provider then placed, in its own
  // transaction with its own version bump — invisible to every other board
  // until this frame.
  for (const s of settled) emitLoadChanged(orgId, { loadId: s.loadId, version: s.version, fields: s.roles });
  res.json({ loads: rows, refusals });
}));

// --- Adding and duplicating rows (slice 2B) --------------------------------
//
// A blank row is brokered from birth (`customerName: ""`): `isBrokered` is
// what decides whether the board draws a carrier line under a load, and a new
// row with no carrier line has nowhere to type the carrier.
dispatcherBrokerBoardRouter.post("/broker-board/loads", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  // boardLine is left NULL on purpose. The board is ordered
  // [boardLine asc NULLS LAST, createdAt asc], so the end of the board is
  // exactly "no sheet line, newest" — which is what a row typed just now is.
  // Computing max+1 looked right and was wrong: a board whose rows all came
  // from an import with no line numbers has no max, so every new row landed
  // on line 1 and jumped to the TOP of the sheet.
  let created;
  try {
    created = await prisma.load.create({
      data: { orgId, requiredEquip: "DryVan", revenueCents: 0, customerName: "", carrierPhone: "" },
    });
  } catch (e) {
    // This route had no try/catch at all: a dead connection or an unmodelled
    // constraint sent NO response and the "+ Load" button spun forever.
    return unhandledWrite(res, "add load", e);
  }
  const [row] = await boardRows(orgId, true, [created.id]);
  emitLoadChanged(orgId, { loadId: created.id, version: created.version, fields: ["created"] });
  res.status(201).json({ load: row });
}));

dispatcherBrokerBoardRouter.post("/broker-board/loads/duplicate", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = idsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  const sources = await prisma.load.findMany({ where: { id: { in: parsed.data.ids }, orgId }, include: { stops: { orderBy: { sequence: "asc" } } } });
  if (sources.length !== new Set(parsed.data.ids).size) return res.status(404).json({ error: "One or more loads were not found" });

  const last = await prisma.load.findFirst({ where: { orgId }, orderBy: { boardLine: { sort: "desc", nulls: "last" } }, select: { boardLine: true } });
  let line = (last?.boardLine ?? 0) + 1;
  const actor = await actorOf(req);
  // The copy is created with IDENTITY only and everything a human can see and
  // retype goes through the one writer (spec §4). Copying the columns
  // straight across produced a load that was open with a DELIVERED update
  // text, had no appointments beside its APPT text, had stops with no
  // coordinates, and stood at version 0 with no trace of where it came from —
  // §16 reproduced by the button meant to save typing.
  let copies: { id: string; version: number; fields: string[] }[];
  try {
    copies = await prisma.$transaction(async (tx) => {
      const made: { id: string; version: number; fields: string[] }[] = [];
      // §7.3: a load someone else is editing refuses every writer —
      // duplicating it out from under an open editor would copy a row mid-edit.
      for (const id of parsed.data.ids) await assertWritable(tx, id, actor.dispatcherId);
      for (const s of sources) {
        // Identity is NOT copied: `externalId` belongs to a TMS record and
        // `boardLoadNo` is unique per org, so a duplicate that carried either
        // would either collide or claim another system's row.
        const copy = await tx.load.create({
          data: {
            orgId, status: "open", legType: s.legType, requiredEquip: s.requiredEquip, fscCents: s.fscCents,
            brokerName: s.brokerName, boardLine: line++,
          },
          select: { id: true },
        });
        const stop = (type: string) => s.stops.find((st) => st.type === type)?.address;
        const r = await applyLoadChange(tx, {
          loadId: copy.id, orgId, actor, source: "board",
          patch: {
            bolNumber: s.bolNumber, customerName: s.customerName, trackingUrl: s.trackingUrl, orderRef: s.orderRef,
            shipDate: s.shipDate, revenueCents: s.revenueCents, soldRateCents: s.soldRateCents,
            carrierId: s.carrierId, carrierPhone: s.carrierPhone, carrierContactName: s.carrierContactName, driverCell: s.driverCell,
            extras: s.extras === null ? null : (s.extras as Prisma.InputJsonValue),
            stops: { pickup: { address: stop("pickup") ?? "" }, delivery: { address: stop("delivery") ?? "" } },
            apptText: s.apptText, updateText: s.updateText,
          },
        });
        made.push({ id: copy.id, version: r.version, fields: r.changed });
      }
      return made;
    }, { timeout: 30_000 });
  } catch (e) {
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: DUPLICATE_LOAD_NO });
    return unhandledWrite(res, "duplicate", e);
  }
  const ids = copies.map((c) => c.id);
  const settled = await settlePendingStops(orgId, ids);
  const rows = await boardRows(orgId, true, ids);
  // M3: the copy genuinely exists whether or not the writer's own diff has
  // anything to say — duplicating a row whose columns happen to match the
  // fresh copy's defaults (e.g. a blank "+ Load" row) left `c.fields` empty,
  // and `emitLoadChanged` correctly sends nothing for an empty list. Creation
  // is a fact about the row, not about which columns moved, so it is merged
  // in here rather than left for the writer to notice.
  for (const c of copies) emitLoadChanged(orgId, { loadId: c.id, version: c.version, fields: [...new Set(["created", ...c.fields])] });
  // M6: a stop the gazetteer could not place at save time may have just been
  // placed by the provider, in its own transaction with its own version bump
  // — a fact the frame above (at the writer's version) knows nothing about.
  for (const s of settled) emitLoadChanged(orgId, { loadId: s.loadId, version: s.version, fields: s.roles });
  res.json({ loads: rows });
}));

// --- The board's own visual state (slice 2B) -------------------------------
//
// The fills a dispatcher painted and the columns they unmerged came off their
// sheet and belong to the org, not to one browser. Column order, width and
// density stay in localStorage — those are one person's habits.
const COLOR = /^#[0-9a-f]{6}$/i;
const colorMap = z.record(z.string().max(200), z.string().regex(COLOR, "that is not a color"));
const viewSchema = z.object({
  fills: z.object({ row: colorMap.optional(), col: colorMap.optional(), cell: colorMap.optional() }).default({}),
  merges: z.record(z.string().max(200), z.array(z.string().max(60)).max(40)).default({}),
});

dispatcherBrokerBoardRouter.get("/broker-board/view", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const view = await prisma.boardView.findUnique({ where: { orgId } });
  res.json({ fills: view?.fills ?? {}, merges: view?.merges ?? {} });
}));

dispatcherBrokerBoardRouter.put("/broker-board/view", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = viewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  const { fills, merges } = parsed.data;
  const saved = await prisma.boardView.upsert({
    where: { orgId },
    create: { orgId, fills, merges },
    update: { fills, merges },
  });
  res.json({ fills: saved.fills, merges: saved.merges });
}));

// Final review finding 10: an over-cap selection went back as raw zod text
// ("ids: Array must contain at most 500 element(s)") straight into the
// dispatcher's red banner. These two sentences are product copy and are
// surfaced verbatim by `validationMessage` below; the status stays 400.
const TOO_MANY_IDS = "Select at most 500 loads";
const TOO_MANY_EXPORT_IDS = "Select at most 2000 loads";
const PRODUCT_COPY: ReadonlySet<string> = new Set([TOO_MANY_IDS, TOO_MANY_EXPORT_IDS]);

/** A validation refusal the dispatcher can read. A message we wrote ourselves
 *  is already a full sentence and goes out as-is; anything zod generated keeps
 *  the `path: message` shape so an unexpected body is still debuggable. */
const validationMessage = (err: z.ZodError): string =>
  err.issues.map((i) => (PRODUCT_COPY.has(i.message) ? i.message : `${i.path.join(".")}: ${i.message}`)).join("; ");

const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500, TOO_MANY_IDS) });
const archiveSchema = idsSchema.extend({ archived: z.boolean() });

// Final review finding 11: `externalId` may carry the internal `board:`
// prefix when a TMS fleet load already owns the sheet's LOAD# — a refusal has
// to name the number the dispatcher typed, never our key. `boardLoadNo`
// returns "" for a null externalId, so `||` (not `??`) falls through.
const LOAD_LABEL = (l: { externalId: string | null; bolNumber: string | null; orderRef: string | null; id: string }): string =>
  boardLoadNo(l.externalId) || l.bolNumber || l.orderRef || l.id.slice(0, 8);

/** The org's loads for a list of ids, or null when any id is not the org's
 *  (or does not exist at all) — org scoping is on the query itself, not a
 *  post-fetch JS check, so a foreign id is simply never returned. */
async function ownedLoads(orgId: string, ids: string[]) {
  const loads = await prisma.load.findMany({ where: { id: { in: ids }, orgId }, include: { assignment: { select: { id: true } } } });
  if (loads.length !== new Set(ids).size) return null;
  return loads;
}

// Thrown when the transactional re-check (right before the write) finds that
// a load's eligibility changed since the pre-flight `ownedLoads` snapshot —
// e.g. a concurrent request assigned or archived it in between. Caught by
// the route and turned into a 409; the transaction it was thrown from rolls
// back automatically, so nothing partial is ever written.
class StaleLoadsError extends Error {}
const STALE_LOADS_MESSAGE = "Some loads changed while you were working — reload and try again";

const exportSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(2000, TOO_MANY_EXPORT_IDS).optional(), archived: z.boolean().optional() });

dispatcherBrokerBoardRouter.post("/broker-board/export", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = exportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  const { ids, archived } = parsed.data;
  if (ids) {
    const owned = await ownedLoads(orgId, ids);
    if (!owned) return res.status(404).json({ error: "One or more loads were not found" });
  }
  const layout = await layoutFor(orgId);
  // A specific selection (`ids`) already passed ownership above; exporting
  // it means every one of those rows, archived or not — the `archived`
  // toggle only matters for a whole-board export, so an explicit id list
  // waives it here rather than relying on `boardRows` to do so implicitly.
  const loads = await boardRows(orgId, archived === true || ids !== undefined, ids);
  const buf = boardWorkbook(renderBoardRows(layout, loads));
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="board-${day}.xlsx"`);
  res.send(buf);
}));

dispatcherBrokerBoardRouter.post("/broker-board/loads/archive", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = archiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  const { archived } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];
  const loads = await ownedLoads(orgId, ids);
  if (!loads) return res.status(404).json({ error: "One or more loads were not found" });
  const blocked = archived
    ? loads.filter((l) => l.assignment !== null || l.status === "in_progress" || l.status === "delivered")
    : loads.filter((l) => l.status !== "archived");
  if (blocked.length) {
    const what = archived ? "can't be archived while assigned, in progress, or delivered" : "are not archived";
    return res.status(409).json({ error: `These loads ${what}: ${blocked.map(LOAD_LABEL).join(", ")}` });
  }
  // Re-assert eligibility in the write's own `where`, not only from the
  // `loads` snapshot above — a concurrent request could have assigned or
  // moved one of these ids in the gap between the read and this write. A
  // short count means some ids no longer match; the whole write rolls back
  // (via the throw) rather than silently applying to the rest.
  const actor = await actorOf(req);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      // §7.3: a load someone else is editing refuses every writer, archive
      // and unarchive included — before any write in this batch lands.
      for (const id of ids) await assertWritable(tx, id, actor.dispatcherId);
      // L9: the "before" status for the trace row below, read fresh inside
      // this transaction — not the pre-flight `loads` snapshot above, which
      // can be stale by the time this write actually lands.
      const beforeRows = archived ? await tx.load.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, status: true } }) : [];
      const result = await tx.load.updateMany({
        where: archived
          ? { id: { in: ids }, orgId, status: { notIn: ["in_progress", "delivered"] }, assignment: { is: null } }
          : { id: { in: ids }, orgId, status: "archived" },
        // The version moves for both: archiving and unarchiving are changes
        // to the record like any other, and a client holding version N has to
        // learn that what it holds is stale (spec §9).
        data: { status: archived ? "archived" : "open", version: { increment: 1 } },
      });
      if (result.count !== ids.length) throw new StaleLoadsError();
      // L9 (spec §12: every version bump has a trace explaining it). This
      // route writes the batch with `updateMany`, not the one writer, so
      // archiving moved `Load.version` and `status` with no `LoadChange` row
      // to explain it — unlike unarchive, which goes on to re-derive through
      // `applyLoadChange` below. Written by hand here, one row per load, in
      // the same transaction as the version bump — the shape the geocode
      // route (dispatcherLoads.ts) already uses for its own hand-written trace.
      // L9 (spec §12: every version bump has a trace explaining it). This
      // route writes the batch with `updateMany`, not the one writer, so
      // archiving moved `Load.version` and `status` with no `LoadChange` row
      // to explain it — unlike unarchive, which goes on to re-derive through
      // `applyLoadChange` below. Written by hand here, one row per load, in
      // the same transaction as the version bump — the shape the geocode
      // route (dispatcherLoads.ts) already uses for its own hand-written trace.
      if (archived) {
        await tx.loadChange.createMany({
          data: beforeRows.map((b) => ({
            loadId: b.id, orgId, atMs: nextAtMs(), actorId: actor.dispatcherId, actorName: actor.name,
            source: "board", field: "status", before: b.status, after: "archived", note: null,
          })),
        });
      }
      // A4-R17: the unarchive transition itself had no trace row — the
      // updateMany above bumps `status` and `version` with nothing explaining
      // it, and the `applyLoadChange` call below (force-deriving from the
      // stored UPDATE text) traces only what IT changes, which is a different
      // fact and often nothing at all. Every id here matched this write's own
      // `where: { status: "archived" }`, so "archived" is the one honest
      // "before" — mirroring the archive branch exactly: same source, same
      // actor, same transaction, one row per load.
      if (!archived) {
        await tx.loadChange.createMany({
          data: ids.map((id) => ({
            loadId: id, orgId, atMs: nextAtMs(), actorId: actor.dispatcherId, actorName: actor.name,
            source: "board", field: "status", before: "archived", after: "open", note: null,
          })),
        });
      }
      // Unarchiving used to write "open" and stop there — so a load that was
      // `assigned` or `canceled` when it was archived came back open, nothing
      // re-derived it, and the board then carried a permanent `record.update`
      // dot saying its own UPDATE text disagreed with the status we had just
      // invented. Hand it to the writer with `force` and the stored text
      // decides, exactly as it does everywhere else.
      if (!archived) {
        for (const id of ids) await applyLoadChange(tx, { loadId: id, orgId, actor, source: "board", patch: {}, force: true });
      }
      return result.count;
    }, { timeout: 30_000 });
    // The status-bump versions, queried right after the transaction commits —
    // BEFORE settlePendingStops below gets a chance to bump any of these
    // loads again. Querying after settle (the old order) meant a load whose
    // stop the provider placed would be reported here with `fields: ["status"]`
    // at its POST-geocode version, crediting the status frame with a change it
    // did not make.
    const versions = await prisma.load.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, version: true } });
    emitLoadsChanged(orgId, versions.map((v) => ({ loadId: v.id, version: v.version, fields: ["status"] })));
    // Unarchive re-derived under `force`: a stop still pending gets its
    // provider look-up after commit, like every other writer caller. A stop
    // it places bumps the version again, in its own transaction, and gets its
    // own frame — never folded into the "status" frame above.
    if (!archived) {
      const settled = await settlePendingStops(orgId, ids);
      for (const s of settled) emitLoadChanged(orgId, { loadId: s.loadId, version: s.version, fields: s.roles });
    }
    res.json({ updated });
  } catch (e) {
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleLoadsError) return res.status(409).json({ error: STALE_LOADS_MESSAGE });
    // Anything else (a constraint the eligibility check did not model, a dead
    // connection) is a clean 500, never a hung request: the transaction rolled back.
    console.error("broker-board bulk action failed", e);
    res.status(500).json({ error: "That did not go through — nothing was changed. Try again in a moment." });
  }
}));

dispatcherBrokerBoardRouter.post("/broker-board/loads/delete", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "The broker board requires an org-scoped dispatcher account" });
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  const ids = [...new Set(parsed.data.ids)];
  const loads = await ownedLoads(orgId, ids);
  if (!loads) return res.status(404).json({ error: "One or more loads were not found" });
  const blocked = loads.filter((l) => l.assignment !== null || !["open", "archived", "canceled"].includes(l.status));
  if (blocked.length) return res.status(409).json({ error: `These loads can't be deleted while assigned or in progress: ${blocked.map(LOAD_LABEL).join(", ")}` });
  const actor = await actorOf(req);
  try {
    const deleted = await prisma.$transaction(async (tx) => {
      // §7.3: a load someone else is editing refuses every writer — deleting
      // it out from under an open editor is exactly the lost work the lock
      // exists to prevent.
      for (const id of ids) await assertWritable(tx, id, actor.dispatcherId);
      // Re-assert eligibility inside the transaction, against the live row —
      // not only the `loads` snapshot above — before deleting anything. A
      // concurrent request could have assigned one of these ids in the gap
      // between the read and here; a short result means the whole delete
      // aborts (throw rolls back the transaction) rather than deleting the
      // ids that are still eligible and silently skipping the rest.
      const stillEligible = await tx.load.findMany({
        where: { id: { in: ids }, orgId, status: { in: ["open", "archived", "canceled"] }, assignment: { is: null } },
        select: { id: true },
      });
      if (stillEligible.length !== ids.length) throw new StaleLoadsError();
      const stopIds = (await tx.loadStop.findMany({ where: { loadId: { in: ids } }, select: { id: true } })).map((s) => s.id);
      await tx.appointment.deleteMany({ where: { stopId: { in: stopIds } } });
      await tx.loadStop.deleteMany({ where: { loadId: { in: ids } } });
      await tx.rate.deleteMany({ where: { loadId: { in: ids } } });
      await tx.dispatchConflict.deleteMany({ where: { loadId: { in: ids }, orgId } });
      const r = await tx.load.deleteMany({ where: { id: { in: ids }, orgId } });
      return r.count;
    });
    // A4 Task 1: the row is gone, so there is no "after" version to report —
    // `loads` is the pre-delete snapshot (ownedLoads, above) and is the last
    // version this record ever held.
    emitLoadsChanged(orgId, loads.map((l) => ({ loadId: l.id, version: l.version, fields: ["deleted"] })));
    res.json({ deleted });
  } catch (e) {
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleLoadsError) return res.status(409).json({ error: STALE_LOADS_MESSAGE });
    // Anything else (a constraint the eligibility check did not model, a dead
    // connection) is a clean 500, never a hung request: the transaction rolled back.
    console.error("broker-board bulk action failed", e);
    res.status(500).json({ error: "That did not go through — nothing was changed. Try again in a moment." });
  }
}));
