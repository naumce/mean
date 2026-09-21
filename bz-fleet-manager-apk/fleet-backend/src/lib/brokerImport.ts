import { prisma } from "../db.js";
import { SYSTEM_ACTOR } from "./actor.js";
import { parseApptText, type ApptWindow } from "./apptText.js";
import { proposeLayout, saveLayout, type BoardColumn, type BoardColumnKey } from "./boardLayout.js";
import { looksLikeUrl, pairRows, parseMoney, parseSheetDate, readWorkbook, type RawLoadPair } from "./brokerSheet.js";
import { settlePendingStops } from "./geocodeSettle.js";
import { applyLoadChange, type LoadPatch } from "./loadWriter.js";
import { LoadLocked } from "./loadLocks.js";

// The customer's board becomes loads. Preview shows exactly what confirm will
// write; confirm writes it. Every cell the parser could not read becomes an
// attention line on the load (spec §5.3, §9.1) — the load still imports, the
// pill says what is wrong, and nothing is guessed.
//
// A note like `PU: ignored "working"` or a PROFIT-mismatch note is a
// sub-detail the dispatcher can see in the preview's `notes`, not a cell the
// parser refused outright — only a note that starts with "can't" (a real
// refusal: no date, no time, no map hit, unparsable money) becomes an
// AgentUpdate row on confirm.

/** Every "can't read …" aspect this importer can raise for a row (see
 *  `toPreview` below: SHIP DATE, RATE, SOLD RATE — the appointment and
 *  place refusals belong to the writer's own derivation and are filtered out
 *  of `producerAttention`). The importer is AUTHORITATIVE for these three: a
 *  re-import of a corrected sheet raises no line for a cell it can now read,
 *  so unless the writer is told the aspect is owned, the old refusal survives
 *  with nothing left to delete it. */
const SHEET_REFUSAL_ASPECTS = ["can't read RATE", "can't read SHIP DATE", "can't read SOLD RATE"];

/** The sheet has no equipment column; a broker's dry van is the default and
 *  the preview says so on every load. */
export const DEFAULT_EQUIPMENT = "DryVan";
const EQUIPMENT_NOTE = "equipment assumed Dry Van (the sheet has no equipment column)";
const NO_IDENTITY_NOTE = "no LOAD#, BOL# or order number — this row will import as new each time";

/** A load this board owns: their sheet gave it a BOL#, a customer, or a
 *  carrier. A TMS-imported fleet load has none of these, and re-import must
 *  never match one — `Load.externalId` is shared with the CSV importer, and
 *  matching on it alone rewrote a live fleet load onto the broker's lane. */
export interface BrokeredFields {
  bolNumber: string | null; customerName: string | null;
  carrierId: string | null; carrierPhone: string | null; carrierContactName: string | null;
}
export const isBrokered = (l: BrokeredFields): boolean =>
  Boolean(l.bolNumber || l.customerName || l.carrierId || l.carrierPhone || l.carrierContactName);
const BROKERED_WHERE = {
  OR: [
    { bolNumber: { not: null } }, { customerName: { not: null } },
    { carrierId: { not: null } }, { carrierPhone: { not: null } }, { carrierContactName: { not: null } },
  ],
};

/** `@@unique([orgId, externalId])` is shared with the TMS importer, so when a
 *  fleet load already holds the sheet's LOAD# the board keeps its own row
 *  under a namespaced key rather than overwriting a live load. The board
 *  strips the prefix again, so the dispatcher still sees the number they
 *  typed. (Slice 2's cleaner form: `Load.boardLoadNo` with its own unique.) */
const BOARD_KEY_PREFIX = "board:";
export const boardLoadNo = (externalId: string | null): string =>
  (externalId ?? "").startsWith(BOARD_KEY_PREFIX) ? (externalId ?? "").slice(BOARD_KEY_PREFIX.length) : (externalId ?? "");

export interface PreviewLoad {
  line: number;
  loadNo: string | null; orderRef: string | null; bol: string | null;
  customer: string | null; carrier: string | null; mc: string | null; carrierPhone: string | null; contact: string | null;
  pickup: string; puZip: string | null; delivery: string; delZip: string | null;
  rateCents: number | null; soldRateCents: number | null; profitCents: number | null;
  shipDate: string | null; update: string | null; trackingUrl: string | null;
  appt: { pu: ApptWindow | null; del: ApptWindow | null };
  notes: string[];
}

const nz = (s: string | undefined): string | null => (s && s.trim() ? s.trim() : null);
const cents = (n: number): string => "$" + (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Every appointment line the dispatcher typed, from BOTH cells of the pair —
 *  a `PU:` and a `DEL:` in the same cell separated by a newline is normal in
 *  their file, and reading only the first line dropped the second one off the
 *  board with no attention at all. */
function apptLinesOf(pair: RawLoadPair): string[] {
  return [pair.top.appt ?? "", pair.bottom?.appt ?? ""]
    .flatMap((cell) => cell.split(/\r?\n/))
    .filter((line) => line.trim() !== "");
}

function toPreview(pair: RawLoadPair, tz: string): PreviewLoad {
  const { top, bottom } = pair;
  const notes: string[] = [];
  const shipDate = top.shipDate ? parseSheetDate(top.shipDate) : null;
  if (top.shipDate && !shipDate) notes.push(`can't read SHIP DATE "${top.shipDate}"`);
  const year = shipDate ? shipDate.getUTCFullYear() : new Date().getUTCFullYear();
  const appt = parseApptText(apptLinesOf(pair), { year, tz });
  notes.push(...appt.notes);
  const rateCents = top.rate ? parseMoney(top.rate) : null;
  if (rateCents === null) notes.push(top.rate ? `can't read RATE "${top.rate}"` : "can't read RATE: blank");
  const soldRateCents = top.soldRate ? parseMoney(top.soldRate) : null;
  if (top.soldRate && soldRateCents === null) notes.push(`can't read SOLD RATE "${top.soldRate}"`);
  const profitCents = rateCents !== null && soldRateCents !== null ? rateCents - soldRateCents : null;
  if (top.profit && profitCents !== null) {
    const typed = parseMoney(top.profit);
    if (typed !== null && typed !== profitCents) notes.push(`PROFIT ${top.profit} does not equal RATE - SOLD RATE (${cents(profitCents)})`);
  }
  const topPhone = nz(top.phone);
  const trackingUrl = topPhone && looksLikeUrl(topPhone) ? topPhone : null;
  const carrierPhone = nz(bottom?.phone) ?? (topPhone && !trackingUrl ? topPhone : null);
  const loadNo = nz(bottom?.loadNo), orderRef = nz(top.loadNo), bol = nz(top.bol);
  // Neither of the three keys re-import matches on: say so rather than let the
  // row quietly double every night. Not a refusal — it never becomes a pill.
  if (!loadNo && !bol && !orderRef) notes.push(NO_IDENTITY_NOTE);
  notes.push(EQUIPMENT_NOTE);
  return {
    line: pair.line,
    loadNo, orderRef, bol,
    customer: nz(top.customer), carrier: nz(bottom?.customer), mc: nz(bottom?.mc), carrierPhone, contact: nz(bottom?.contact) ?? nz(top.contact),
    pickup: (top.pickupCity ?? "").trim(), puZip: nz(top.puZip), delivery: (top.deliveryCity ?? "").trim(), delZip: nz(top.delZip),
    rateCents, soldRateCents, profitCents,
    shipDate: shipDate ? shipDate.toISOString().slice(0, 10) : null, update: nz(top.update) ?? nz(bottom?.update), trackingUrl,
    appt: { pu: appt.pu, del: appt.del }, notes,
  };
}

// Two rows in one file claiming the same identifier used to merge into one
// load — the first row's data lost, reported as "1 new, 1 updated". The
// second occurrence is skipped and named instead.
const KEY_LABEL: Record<string, string> = { L: "LOAD#", B: "BOL#", R: "order number" };
const identifiersOf = (p: PreviewLoad): string[] =>
  [p.loadNo ? `L:${p.loadNo}` : "", p.bol ? `B:${p.bol}` : "", p.orderRef ? `R:${p.orderRef}` : ""].filter((k) => k !== "");

/** Previews for every pair, with the duplicate rows marked. `dupes` is keyed
 *  by the sheet line of the row that is NOT imported. */
function previewsOf(pairs: RawLoadPair[], tz: string): { loads: PreviewLoad[]; dupes: Map<number, string>; notes: string[] } {
  const loads = pairs.map((p) => toPreview(p, tz));
  const claimed = new Map<string, number>();
  const dupes = new Map<number, string>();
  const notes: string[] = [];
  for (const p of loads) {
    const ids = identifiersOf(p);
    const clash = ids.find((k) => claimed.has(k));
    if (clash) {
      const note = `duplicate ${KEY_LABEL[clash[0]]} ${clash.slice(2)} — first occurrence on line ${claimed.get(clash)} kept`;
      dupes.set(p.line, note);
      p.notes.push(note);
      notes.push(`line ${p.line}: ${note}`);
      continue;
    }
    for (const k of ids) claimed.set(k, p.line);
  }
  return { loads, dupes, notes };
}

async function readAndPair(orgId: string, buf: Buffer) {
  const orgRow = await prisma.org.findUnique({ where: { id: orgId }, select: { timezone: true } });
  if (!orgRow) throw new Error("org not found");
  const wb = readWorkbook(buf);
  const proposal = proposeLayout(wb.header);
  // Row pairing always uses the freshly proposed columns because that matches
  // THIS file's header order — never the saved layout.
  const { pairs, notes } = pairRows(wb.rows, proposal.columns);
  const previews = previewsOf(pairs, orgRow.timezone);
  return { tz: orgRow.timezone, sheetName: wb.sheetName, proposal, pairs, previews, notes: [...wb.notes, ...notes, ...previews.notes] };
}

export interface BrokerPreview {
  sheetName: string;
  layout: BoardColumn[];
  unmatched: string[];
  missing: BoardColumnKey[];
  loads: PreviewLoad[];
  notes: string[];
}

export async function buildPreview(orgId: string, buf: Buffer): Promise<BrokerPreview> {
  const { sheetName, proposal, previews, notes } = await readAndPair(orgId, buf);
  return { sheetName, layout: proposal.columns, unmatched: proposal.unmatched, missing: proposal.missing, loads: previews.loads, notes };
}

async function carrierFor(orgId: string, name: string | null, mc: string | null): Promise<string | null> {
  if (!name && !mc) return null;
  const existing = mc
    ? await prisma.carrier.findFirst({ where: { orgId, mcNumber: mc } })
    : await prisma.carrier.findFirst({ where: { orgId, name: name! } });
  if (existing) {
    if (name && existing.name !== name && mc) await prisma.carrier.update({ where: { id: existing.id }, data: { name } });
    return existing.id;
  }
  const created = await prisma.carrier.create({ data: { orgId, name: name ?? `MC ${mc}`, mcNumber: mc } });
  return created.id;
}

/** The key this row takes in `Load.externalId`, avoiding a live fleet load
 *  that already holds the same LOAD# (see BOARD_KEY_PREFIX). */
async function boardKeyFor(orgId: string, loadNo: string): Promise<string> {
  const fleetLoad = await prisma.load.findFirst({ where: { orgId, externalId: loadNo, NOT: BROKERED_WHERE } });
  return fleetLoad ? BOARD_KEY_PREFIX + loadNo : loadNo;
}

/** `archivedKept` is the honesty half of "a re-import never resurrects an
 *  archived load": `fields` below deliberately carries no `status`, so a load
 *  the dispatcher archived is matched and updated in place and STAYS off the
 *  board. Counting it as a plain "updated" made the import dialog claim more
 *  rows than the board then showed (final review finding 8) — this is the
 *  number the dialog says out loud. */
export interface BrokerImportResult { batchId: string; created: number; updated: number; skipped: number; locked: number; attention: number; archivedKept: number; notes: string[]; changes: { loadId: string; version: number; fields: string[] }[] }

export async function confirmImport(orgId: string, buf: Buffer): Promise<BrokerImportResult> {
  const { proposal, pairs, previews, notes } = await readAndPair(orgId, buf);
  // The layout follows the file being imported: their sheet is the truth, so
  // a column they add later shows up instead of being invisible forever.
  await saveLayout(orgId, proposal.columns);
  let created = 0, updated = 0, skipped = 0, locked = 0, attention = 0, archivedKept = 0;
  const touched: string[] = [];
  // A4 Task 1: every row's writer result, so the route can announce
  // `load_changed` per load instead of the batch's one blunt `board_update`.
  // Collected unconditionally (even a no-op row) — `emitLoadsChanged` is the
  // one place that decides an empty `fields` is silence, not this loop.
  const changes: { loadId: string; version: number; fields: string[] }[] = [];
  for (const [i, pair] of pairs.entries()) {
    if (previews.dupes.has(pair.line)) { skipped += 1; continue; }
    const p = previews.loads[i];
    const loadNotes = [...p.notes];
    const carrierId = await carrierFor(orgId, p.carrier, p.mc);
    // Reconciliation identity: LOAD#, then BOL#, then the order number — and
    // only ever against a brokered load, never a TMS fleet load.
    const existing = (p.loadNo ? await prisma.load.findFirst({ where: { orgId, externalId: { in: [p.loadNo, BOARD_KEY_PREFIX + p.loadNo] }, ...BROKERED_WHERE } }) : null)
      ?? (p.bol ? await prisma.load.findFirst({ where: { orgId, bolNumber: p.bol, ...BROKERED_WHERE } }) : null)
      ?? (p.orderRef ? await prisma.load.findFirst({ where: { orgId, orderRef: p.orderRef, ...BROKERED_WHERE } }) : null);
    // Identity and ordering are the importer's; everything a human can see
    // and retype goes through the writer, which derives the truth once.
    const identity = { externalId: p.loadNo ? await boardKeyFor(orgId, p.loadNo) : null, brokerName: p.customer, boardLine: pair.line };
    const patch: LoadPatch = {
      orderRef: p.orderRef, bolNumber: p.bol, customerName: p.customer,
      revenueCents: p.rateCents ?? 0, soldRateCents: p.soldRateCents, trackingUrl: p.trackingUrl,
      shipDate: p.shipDate ? new Date(p.shipDate + "T00:00:00Z") : null, updateText: p.update,
      apptText: apptLinesOf(pair).join("\n") || null,
      carrierId, carrierPhone: p.carrierPhone, carrierContactName: p.contact,
      stops: {
        pickup: { address: [p.pickup, p.puZip].filter(Boolean).join(" ") },
        delivery: { address: [p.delivery, p.delZip].filter(Boolean).join(" ") },
      },
    };
    // Refusals the writer does not derive itself (RATE, SHIP DATE, PROFIT is
    // preview-only) travel with the patch; the writer keeps them by aspect.
    const producerAttention = loadNotes.filter((n) => n.startsWith("can't") && !/appointment|place/.test(n));
    // Identity and the writer share one transaction: if the writer throws
    // (timeout, connection loss, deadlock) a standalone identity write would
    // leave a ghost Load (a new row satisfying none of BROKERED_WHERE, or an
    // existing row half-updated) that breaks every later reconciliation.
    let written;
    try {
      written = await prisma.$transaction(async (tx) => {
        const loadId = existing
          ? (await tx.load.update({ where: { id: existing.id }, data: identity })).id
          : (await tx.load.create({ data: { orgId, status: "open", legType: "linehaul", requiredEquip: DEFAULT_EQUIPMENT, fscCents: 0, ...identity } })).id;
        const result = await applyLoadChange(tx, {
          loadId, orgId, actor: SYSTEM_ACTOR("import"), source: "import", patch,
          attention: producerAttention, attentionOwned: SHEET_REFUSAL_ASPECTS,
        });
        return { loadId, ...result };
      }, { timeout: 30_000 });
    } catch (e) {
      // A row under someone's open editor is theirs right now (spec §7.2):
      // the sheet does not land on it, and the dialog says so by name.
      if (e instanceof LoadLocked) { locked += 1; notes.push(`row ${pair.line}: ${e.lock.by} is editing this load — not imported`); continue; }
      throw e;
    }
    touched.push(written.loadId);
    // M3: a brand-new row whose cells the writer happens to see as identical
    // to a fresh load's defaults (e.g. a row whose only real content is its
    // LOAD#, which lands in `identity` above and never reaches the writer's
    // patch at all) produced `changed: []` — a row that genuinely exists,
    // announced as nothing. Creation is a fact about the row, not about
    // which columns moved, so it is merged in for every row this call itself
    // created; an update keeps the writer's own diff untouched.
    // M3: a brand-new row whose cells the writer happens to see as identical
    // to a fresh load's defaults (e.g. a row whose only real content is its
    // LOAD#, which lands in `identity` above and never reaches the writer's
    // patch at all) produced `changed: []` — a row that genuinely exists,
    // announced as nothing. Creation is a fact about the row, not about
    // which columns moved, so it is merged in for every row this call itself
    // created; an update keeps the writer's own diff untouched.
    const fields = existing ? written.changed : [...new Set(["created", ...written.changed])];
    changes.push({ loadId: written.loadId, version: written.version, fields });
    if (existing) { updated += 1; if (existing.status === "archived") archivedKept += 1; } else created += 1;
    if (written.attention.length) attention += 1;
  }
  // Whatever the gazetteer could not place is asked of the provider now, once
  // for the whole batch and outside every transaction. With no provider
  // configured this is a no-op and the counts above stand as they are.
  const settled = await settlePendingStops(orgId, touched);
  if (settled.length > 0) {
    attention = await prisma.load.count({ where: { orgId, id: { in: touched }, agentUpdates: { some: { kind: "attention" } } } });
    // M6: a stop the provider placed after the batch's own writes bumps that
    // load's version again, in its own transaction — a fact none of the
    // `changes` above know about. The route (`POST /broker-board/import/confirm`)
    // emits `load_changed` from this same array, so folding the settle results
    // in here is the one place that has to happen, not a second emit call.
    for (const s of settled) changes.push({ loadId: s.loadId, version: s.version, fields: s.roles });
  }
  const batch = await prisma.importBatch.create({ data: { orgId, source: "xlsx", entity: "broker_loads", rows: pairs.length, errors: notes.length ? JSON.stringify(notes) : null } });
  return { batchId: batch.id, created, updated, skipped, locked, attention, archivedKept, notes, changes };
}
