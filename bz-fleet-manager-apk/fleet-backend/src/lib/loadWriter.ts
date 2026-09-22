// The one door (spec §4). Every change to a Load — a board cell, a paste, an
// import row, a backfill, later the agent — comes through here, inside the
// caller's transaction. The patch is applied, the structured truth is derived
// only for what changed, the affected Attention rows are replaced, one trace
// row is written per field, and the version goes up by one.
import { Prisma } from "@prisma/client";
import { gazetteerLookup } from "./geocode.js";
import { parseApptText, type ApptWindow } from "./apptText.js";
import { DEFAULT_UPDATE_RULES, statusFor, type UpdateRuleRow } from "./updateVocabulary.js";
import { assertWritable } from "./loadLocks.js";

type Tx = Prisma.TransactionClient;

// "system" is the one source no human chose: a recovery the server ran on its
// own, such as the geocoder placing a stop nobody could place at save time
// (plan A4, ruling A4-R6). It is in this union because the column already
// holds it — `LoadChange.source` is a plain string, so a value written from
// outside this type would compile silently and leave the vocabulary lying
// about what the trace contains.
// "sheet": a write the Night Shift agent made back into a connected Google
// Sheet row's own columns (plan A5-sheet, slice 2+) rather than one of the
// existing producers above.
export type ChangeSource = "board" | "paste" | "import" | "loadboard" | "agent" | "backfill" | "system" | "sheet";

export interface Actor { dispatcherId: string | null; name: string }

export interface LoadPatch {
  bolNumber?: string | null; customerName?: string | null; trackingUrl?: string | null; orderRef?: string | null;
  boardLoadNo?: string | null; updateText?: string | null; apptText?: string | null;
  carrierPhone?: string | null; carrierContactName?: string | null; driverCell?: string | null;
  shipDate?: Date | null; revenueCents?: number; soldRateCents?: number | null;
  carrierId?: string | null;
  carrier?: { name?: string | null; mcNumber?: string | null };
  extras?: Prisma.InputJsonValue | null;
  stops?: { pickup?: { address: string }; delivery?: { address: string } };
  // The Cockpit's own fields (plan A3) — TMS scalars a dispatcher edits in /loadboard.
  requiredEquip?: string; fscCents?: number; hazmatClass?: string | null; commodity?: string | null; brokerName?: string | null; weightLbs?: number | null;
  /** The Cockpit edits stops as a whole ordered list with explicit windows.
   *  Mutually exclusive with `stops` (the board's by-role city edit). */
  stopSet?: StopSetEntry[];
  // Night Shift (spec §17.2, Task 3): the switch, the policy it runs under,
  // and the pill the boards show. Plain scalars, same as `customerName`
  // above — no derivation here. The route that flips the switch (POST
  // /loads/:id/agent) decides `agentPill` itself ("watching"/"off") and
  // passes it through this same patch so it is traced and versioned with
  // the rest of the write.
  agentEnabled?: boolean; agentPolicyId?: string | null; agentPill?: string;
  // Night Shift sheet slices: the customer's email off the connected sheet
  // row, this load's row index in that sheet, and the Night Shift switch
  // cell text the sync last acted on (final fix wave, I5 — the switch
  // reacts to cell CHANGES, so the sync has to remember what it saw). Plain
  // scalars, same as `customerName` above — no derivation here.
  customerEmail?: string | null; sheetRowIndex?: number | null; sheetSwitchSeen?: string | null;
  /// Slice 4, Task 2 fix round 1: which SheetBinding mirrored this load —
  /// set by the row pass on every tick, the same way `sheetRowIndex` is.
  sheetBindingId?: string | null;
}

export interface StopSetEntry { sequence: number; type: "pickup" | "delivery" | "intermediate"; address: string; lat?: number | null; lng?: number | null; dwellMin?: number | null; windowStart?: Date | null; windowEnd?: Date | null }

export interface ApplyArgs {
  loadId: string; orgId: string; actor: Actor; source: ChangeSource; patch: LoadPatch;
  attention?: string[];
  /** Aspects this producer is AUTHORITATIVE for: every one of them is cleared
   *  before `attention`'s current lines are re-added, so a refusal the
   *  producer no longer raises stops being true the moment it stops raising
   *  it. Without this a `can't read SHIP DATE "TBD"` from an import survived
   *  forever — the corrected re-import sends no line for it, so nothing ever
   *  deleted the row and the pill outlived the problem. */
  attentionOwned?: string[];
  force?: boolean;
  /** The `Load.version` the caller rendered (spec §7.4). A view of the record
   *  that has moved on does not overwrite it; import and backfill carry none
   *  and are never checked — they are the truth arriving. */
  baseVersion?: number;
}

export interface ApplyResult {
  version: number;
  changed: string[];
  attention: string[];
  status: string;
  statusRefused: string | null;
}

export class LoadNotFound extends Error {}

/** The version backstop: the row moved since the caller rendered it. */
export class StaleVersion extends Error {
  constructor(public readonly current: number, public readonly base: number) {
    super(`the record moved on (version ${current}; you rendered ${base})`);
  }
}

/** A `stopSet` patch that cannot mean anything: two entries claiming the same
 *  `sequence`, or both `stops` (the board's by-role edit) and `stopSet` (the
 *  Cockpit's whole-list edit) on one patch. Thrown before any write. */
export class InvalidStopSet extends Error {}
const SKIPS_BASE_VERSION: ReadonlySet<ChangeSource> = new Set(["import", "backfill"]);

/** The scalar columns a patch may carry, in the order the trace lists them. */
const SCALARS = [
  "bolNumber", "customerName", "trackingUrl", "orderRef", "boardLoadNo", "updateText", "apptText",
  "carrierPhone", "carrierContactName", "driverCell", "shipDate", "revenueCents", "soldRateCents", "carrierId", "extras",
  "requiredEquip", "fscCents", "hazmatClass", "commodity", "brokerName", "weightLbs",
  "agentEnabled", "agentPolicyId", "agentPill",
  "customerEmail", "sheetRowIndex", "sheetSwitchSeen", "sheetBindingId",
] as const;
type Scalar = (typeof SCALARS)[number];

/** The scalar cells whose refusal is about the cell's own value, and the
 *  aspect that refusal takes. Writing the cell answers the refusal, so the
 *  row goes — whoever the writer is (a board edit, a corrected import). */
const REFUSAL_FOR_FIELD: Readonly<Record<string, string>> = {
  revenueCents: "can't read RATE",
  shipDate: "can't read SHIP DATE",
  soldRateCents: "can't read SOLD RATE",
};

/** What the trace stores: the value as a cell would show it. */
export const rendered = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** `can't read PU appointment: "…"` → `can't read PU appointment`. Attention
 *  rows are replaced per aspect, so re-deriving appointments never touches a
 *  geocode refusal and vice versa. */
export function attentionAspect(text: string): string {
  const cut = text.search(/[:"]/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

export type LoadRow = Prisma.LoadGetPayload<{ include: { stops: { include: { appointment: true } }; assignment: { select: { id: true } }; org: { select: { timezone: true } } } }>;

export async function loadRow(tx: Tx, loadId: string, orgId: string): Promise<LoadRow> {
  const row = await tx.load.findFirst({
    where: { id: loadId, orgId },
    include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } }, assignment: { select: { id: true } }, org: { select: { timezone: true } } },
  });
  if (!row) throw new LoadNotFound(`load ${loadId} is not in org ${orgId}`);
  return row;
}

/** Put `mc` on the load's carrier without ever rewriting a carrier another
 *  load points at. `brokerImport.ts` deliberately links every load carrying
 *  the same M.C.# to ONE `Carrier` row, and the carrier layer prices and pays
 *  that row — so an M.C.# typed on one board line may not silently rename or
 *  renumber another line's carrier (spec §12: a human's cell is never
 *  rewritten). Sole referrer: the row IS this load's, so it is updated in
 *  place. Shared: the org's carrier for the merged name+MC is found the
 *  importer's way (by MC, then by exact name) or made, and THIS load is
 *  relinked to it — the other loads keep theirs untouched. */
async function setCarrierMc(tx: Tx, orgId: string, loadId: string, carrierId: string, mc: string | null): Promise<string | null> {
  const carrier = await tx.carrier.findFirst({ where: { id: carrierId, orgId } });
  if (!carrier || carrier.mcNumber === mc) return carrierId;
  const shared = await tx.load.count({ where: { carrierId, id: { not: loadId } } });
  if (shared === 0) {
    await tx.carrier.update({ where: { id: carrierId }, data: { mcNumber: mc } });
    return carrierId;
  }
  const name = carrier.name.trim();
  // Nothing left to point at: no name, no number, and the shared row must not
  // be emptied on this load's behalf.
  if (mc === null && name === "") return null;
  const found = (mc ? await tx.carrier.findFirst({ where: { orgId, mcNumber: mc } }) : null)
    ?? (name ? await tx.carrier.findFirst({ where: { orgId, name, mcNumber: null } }) : null);
  if (found && found.id !== carrierId) {
    if (found.mcNumber === mc) return found.id;
    // A same-named row with no number takes the typed one — unless another
    // load runs it too, in which case it is as shared as the row we left.
    const twinShared = await tx.load.count({ where: { carrierId: found.id, id: { not: loadId } } });
    if (twinShared === 0) {
      await tx.carrier.update({ where: { id: found.id }, data: { mcNumber: mc } });
      return found.id;
    }
  }
  // Every row that could carry this name is somebody else's (the shared row
  // itself, when it has no number yet, resolves here): the typed number lands
  // on a new one rather than vanishing. A cell is never thrown away (§12).
  return (await tx.carrier.create({ data: { orgId, name, mcNumber: mc } })).id;
}

async function resolveCarrier(tx: Tx, orgId: string, loadId: string, current: string | null, carrier: NonNullable<LoadPatch["carrier"]>): Promise<string | null> {
  let carrierId = current;
  if (carrier.name !== undefined) {
    const name = (carrier.name ?? "").trim();
    // Emptying the name detaches this load. It never deletes a carrier and,
    // per A2, never invents one either.
    if (name === "") carrierId = null;
    else {
      // Carriers are a real entity the carrier layer prices and pays: a name
      // typed on the board finds the org's carrier before it makes another.
      const found = await tx.carrier.findFirst({ where: { orgId, name } });
      carrierId = found ? found.id : (await tx.carrier.create({ data: { orgId, name } })).id;
    }
  }
  if (carrier.mcNumber !== undefined) {
    const mc = (carrier.mcNumber ?? "").trim() || null;
    // An EMPTIED M.C.# never invents a carrier. It used to: `carrierId ??
    // create({ name: "" })` made a nameless Carrier for a blank cell, the
    // load pointed at it, and `deriveStatus` then read `carrierBooked: true`
    // and moved a SCHEDULED load to assigned — a booking nobody made.
    if (mc === null && carrierId === null) return carrierId;
    if (carrierId === null) {
      // An MC typed before the carrier's name exists still has to land: the
      // org's carrier already holding that number, or a new unnamed one for
      // it which the next cell names.
      const found = await tx.carrier.findFirst({ where: { orgId, mcNumber: mc } });
      carrierId = found ? found.id : (await tx.carrier.create({ data: { orgId, name: "", mcNumber: mc } })).id;
    } else {
      carrierId = await setCarrierMc(tx, orgId, loadId, carrierId, mc);
    }
  }
  return carrierId;
}

/** Attention rows are ordered by atMs and an importer's suite asserts every
 *  line in a batch is distinct — two loads written in one millisecond must
 *  not tie. Monotonic within the process. */
let lastAtMs = 0;
export const nextAtMs = (): bigint => { lastAtMs = Math.max(Date.now(), lastAtMs + 1); return BigInt(lastAtMs); };

/** Replace this load's attention rows for the given aspects with `next`. */
async function mergeAttention(tx: Tx, loadId: string, aspects: Set<string>, next: string[]): Promise<void> {
  const existing = await tx.agentUpdate.findMany({ where: { loadId, kind: "attention" } });
  const stale = existing.filter((a) => aspects.has(attentionAspect(a.text))).map((a) => a.id);
  if (stale.length) await tx.agentUpdate.deleteMany({ where: { id: { in: stale } } });
  if (next.length) {
    await tx.agentUpdate.createMany({ data: next.map((text) => ({ loadId, atMs: nextAtMs(), kind: "attention", text })) });
  }
}

export async function applyLoadChange(tx: Tx, args: ApplyArgs): Promise<ApplyResult> {
  const { loadId, orgId, actor, source, patch } = args;
  const before = await loadRow(tx, loadId, orgId);
  // §7.3 — a load someone else is editing refuses every writer; §7.4 — a
  // stale view refuses itself. Both before a single row is touched.
  await assertWritable(tx, loadId, actor.dispatcherId);
  if (args.baseVersion !== undefined && !SKIPS_BASE_VERSION.has(source) && before.version !== args.baseVersion) {
    throw new StaleVersion(before.version, args.baseVersion);
  }
  const changed: string[] = [];
  const data: Record<string, unknown> = {};
  // Reserved now, before derivation runs, so the scalar trace below always
  // gets the SMALLER of the two clock ticks this call can produce. A status
  // change deriveStatus() writes for itself (below) calls nextAtMs() again,
  // which is monotonic and therefore strictly later — so a load's status
  // entry always outranks the field edit that caused it when a reader lists
  // a load's changes newest-first (Task 10), instead of racing Date.now()
  // against however many awaited queries separate the two writes.
  const atMs = nextAtMs();

  // 1. The scalar patch — only fields whose value actually differs.
  for (const key of SCALARS) {
    if (!(key in patch)) continue;
    const next = (patch as Record<string, unknown>)[key];
    const current = (before as Record<string, unknown>)[key];
    if (rendered(next) === rendered(current)) continue;
    data[key] = key === "extras" && next === null ? Prisma.DbNull : next;
    changed.push(key);
  }
  if (patch.carrier) {
    const carrierId = await resolveCarrier(tx, orgId, loadId, before.carrierId, patch.carrier);
    if (carrierId !== before.carrierId) { data.carrierId = carrierId; if (!changed.includes("carrierId")) changed.push("carrierId"); }
  }
  if (Object.keys(data).length) await tx.load.update({ where: { id: loadId }, data });

  // 2. Derivation — only for what changed (Tasks 4–6 fill these in).
  const aspects = new Set<string>();
  const attention: string[] = [];
  for (const a of args.attention ?? []) { aspects.add(attentionAspect(a)); attention.push(a); }
  // Aspects the producer owns outright are cleared whether or not it raised a
  // line for them this time — that is what makes a corrected sheet clear the
  // refusal its previous version left behind.
  for (const a of args.attentionOwned ?? []) aspects.add(attentionAspect(a));
  // A cell a human retyped answers its own refusal: the old "can't read" is
  // about a value that no longer exists.
  for (const field of changed) {
    const aspect = REFUSAL_FOR_FIELD[field];
    if (aspect) aspects.add(aspect);
  }
  await deriveStops(tx, before, patch, args.force === true, aspects, attention, changed);
  await deriveAppointments(tx, before, patch, args.force === true, aspects, attention, changed);
  const status = await deriveStatus(tx, before, patch, args.force === true, changed, actor, source);

  // 3. Attention rows, replaced per aspect in the same transaction.
  await mergeAttention(tx, loadId, aspects, attention);

  // 4. Version and trace. A change with nothing changed is not a change.
  if (changed.length === 0 && status.changed === false) {
    return { version: before.version, changed, attention, status: before.status, statusRefused: status.refused };
  }
  const after = await tx.load.update({ where: { id: loadId }, data: { version: { increment: 1 } }, include: { stops: true } });
  const entry = (field: string, from: string | null, to: string | null) =>
    ({ loadId, orgId, atMs, actorId: actor.dispatcherId, actorName: actor.name, source, field, before: from, after: to, note: null as string | null });
  const trace = changed
    .filter((f) => SCALARS.includes(f as Scalar) || f === "carrierId")
    .map((field) => entry(field, rendered((before as Record<string, unknown>)[field]), rendered((after as Record<string, unknown>)[field])));
  // A city retyped on the board is a change like any other and belongs in the
  // trace: it moves the load on the map, and without a row nobody could see
  // who moved it. The value is the address, which is what the cell shows.
  for (const role of ROLES) {
    if (!changed.includes(`stops.${role}`)) continue;
    trace.push(entry(`stops.${role}`,
      before.stops.find((s) => s.type === role)?.address ?? null,
      after.stops.find((s) => s.type === role)?.address ?? null));
  }
  // The Cockpit's whole-list edit (plan A3): one row for the set, the
  // addresses in sequence order on each side — not a row per stop, since the
  // set itself (not any one role) is what the Cockpit changed.
  //
  // F6: `before.stops` is already sequence-ordered (loadRow's own query), but
  // `patch.stopSet` arrives in whatever order the caller sent it — a save that
  // reorders stops otherwise wrote a trace row whose two halves read in two
  // different orders and could not be compared. Sorted by `sequence` here,
  // the same way stopSetUnchanged() above already does.
  if (changed.includes("stopSet")) {
    const afterOrdered = [...(patch.stopSet ?? [])].sort((a, b) => a.sequence - b.sequence);
    trace.push(entry("stopSet",
      before.stops.map((s) => s.address).join(" → ") || null,
      afterOrdered.map((s) => s.address).join(" → ") || null));
  }
  if (trace.length) await tx.loadChange.createMany({ data: trace });
  return { version: after.version, changed, attention, status: after.status, statusRefused: status.refused };
}

export interface StatusArgs {
  loadId: string; orgId: string; actor: Actor; source: ChangeSource; status: string; note: string | null;
  /** Skip the lock check (`assertWritable`) only — the version bump, the
   *  trace row and the status write are unchanged either way. Default false. */
  bypassLock?: boolean;
}

/** The lifecycle's door (spec §6.3): assign, start, deliver, unassign,
 *  reopen move a load's status by structure, not by text. One row of trace,
 *  one version tick, the same lock gate as every other write; no derivation
 *  — the text on the board did not change, only what we know.
 *
 *  `bypassLock` (Fix round 1): for flows that must never hang on a
 *  dispatcher's lock — a cancel already past its own lock check, and a
 *  tender decline. Everything else keeps the lock check. */
export async function applyStatusChange(tx: Tx, args: StatusArgs): Promise<{ version: number; before: string }> {
  const before = await tx.load.findFirst({ where: { id: args.loadId, orgId: args.orgId }, select: { status: true, version: true } });
  if (!before) throw new LoadNotFound(`load ${args.loadId} is not in org ${args.orgId}`);
  if (!args.bypassLock) await assertWritable(tx, args.loadId, args.actor.dispatcherId);
  if (before.status === args.status) {
    return { version: before.version, before: before.status };
  }
  const row = await tx.load.update({ where: { id: args.loadId }, data: { status: args.status, version: { increment: 1 } }, select: { version: true } });
  await tx.loadChange.create({ data: {
    loadId: args.loadId, orgId: args.orgId, atMs: nextAtMs(), actorId: args.actor.dispatcherId, actorName: args.actor.name,
    source: args.source, field: "status", before: before.status, after: args.status, note: args.note,
  } });
  return { version: row.version, before: before.status };
}

// --- derivation (implemented in Tasks 4–6) ---------------------------------
// Each is a no-op stub here so the core is testable on its own; the task that
// owns it replaces the body and its tests prove it.
/** The gazetteer reads "City, ST"; the importer has always handed it the city
 *  without the ZIP, and this does the same so the two agree stop for stop. */
export const geocodeQuery = (address: string): string => address.replace(/\s+\d{5}$/, "").trim();

/** The org's enabled rules. An org that has never had any gets the defaults —
 *  the words on their board — seeded once. To switch a word off, disable it;
 *  deleting every rule brings the defaults back. */
export async function rulesFor(tx: Tx, orgId: string): Promise<UpdateRuleRow[]> {
  let rows = await tx.updateRule.findMany({ where: { orgId } });
  if (rows.length === 0) {
    // skipDuplicates: seeding happens on a READ path, so two first-time
    // requests for the same org can reach this line together. Without it the
    // loser threw P2002 — which the paste route then reported to the
    // dispatcher as "That LOAD# is already on this board".
    await tx.updateRule.createMany({ data: DEFAULT_UPDATE_RULES.map((r) => ({ orgId, prefix: r.prefix, status: r.status })), skipDuplicates: true });
    rows = await tx.updateRule.findMany({ where: { orgId } });
  }
  return rows.map((r) => ({ prefix: r.prefix, status: r.status as UpdateRuleRow["status"], enabled: r.enabled }));
}

const ROLES = ["pickup", "delivery"] as const;

/** True when `wanted` would write nothing new: same count and, position by
 *  position once both are ordered by `sequence`, the same type, address,
 *  dwell, caller-supplied coordinates, and appointment window. Resubmitting
 *  the Cockpit's own list back at it (its GET → PUT round trip) must not
 *  bump the version, duplicate a trace row, or hand every stop and
 *  appointment a new id. */
function stopSetUnchanged(existing: LoadRow["stops"], wanted: StopSetEntry[]): boolean {
  if (existing.length !== wanted.length) return false;
  const bySeq = <T extends { sequence: number }>(a: T, b: T) => a.sequence - b.sequence;
  const have = [...existing].sort(bySeq);
  const next = [...wanted].sort(bySeq);
  return have.every((s, i) => {
    const w = next[i];
    if (s.sequence !== w.sequence || s.type !== w.type || s.address !== w.address) return false;
    if ((s.dwellMin ?? null) !== (w.dwellMin ?? null)) return false;
    // Only a caller-supplied coordinate is a fact worth comparing — a
    // gazetteer hit isn't in the patch to compare against.
    if (w.lat != null && w.lng != null && (s.lat !== w.lat || s.lng !== w.lng)) return false;
    const startEq = (s.appointment?.windowStart?.getTime() ?? null) === (w.windowStart?.getTime() ?? null);
    const endEq = (s.appointment?.windowEnd?.getTime() ?? null) === (w.windowEnd?.getTime() ?? null);
    return startEq && endEq;
  });
}

async function deriveStops(tx: Tx, before: LoadRow, patch: LoadPatch, force: boolean, aspects: Set<string>, attention: string[], changed: string[]): Promise<void> {
  if (patch.stopSet) {
    if (patch.stops) throw new InvalidStopSet("stops and stopSet are mutually exclusive");
    const seen = new Set<number>();
    for (const s of patch.stopSet) {
      if (seen.has(s.sequence)) throw new InvalidStopSet("stop sequences must be unique");
      seen.add(s.sequence);
      // Ruling R11: Appointment.windowEnd is NOT NULL, so a half window
      // (windowStart with no windowEnd) would otherwise be silently dropped
      // on write, and stopSetUnchanged() could never match it back. Reject
      // before anything is written, same as the duplicate-sequence check.
      if (s.windowStart && !s.windowEnd) throw new InvalidStopSet("windowStart requires windowEnd");
    }
    if (stopSetUnchanged(before.stops, patch.stopSet)) return;
    // The Cockpit's list replaces the whole set (N stops, explicit windows).
    // Coordinates the caller supplied are kept; every other address meets
    // the gazetteer, and a miss is `pending` plus its Attention line — the
    // same words the by-role path uses, so one aspect per role.
    await tx.appointment.deleteMany({ where: { stop: { loadId: before.id } } });
    await tx.loadStop.deleteMany({ where: { loadId: before.id } });
    for (const role of ["pickup", "delivery", "intermediate"]) aspects.add(`can't place ${role}`);
    for (const s of patch.stopSet) {
      const own = s.lat != null && s.lng != null;
      const hit = own ? { lat: s.lat!, lng: s.lng! } : gazetteerLookup(geocodeQuery(s.address));
      const stop = await tx.loadStop.create({ data: {
        loadId: before.id, sequence: s.sequence, type: s.type, address: s.address, dwellMin: s.dwellMin ?? undefined,
        lat: hit?.lat ?? null, lng: hit?.lng ?? null, geocodeStatus: hit ? "ok" : "pending",
      } });
      if (!hit) attention.push(`can't place ${s.type} "${s.address}" on the map`);
      if (s.windowEnd) await tx.appointment.create({ data: { stopId: stop.id, windowStart: s.windowStart ?? null, windowEnd: s.windowEnd, type: s.type === "intermediate" ? "delivery" : s.type, kind: "appointment" } });
    }
    changed.push("stopSet");
    return;
  }
  const wanted = patch.stops;
  if (!wanted && !force) return;
  // Both roles exist from the first write: the board's GET reads them by
  // type and shows both columns for every row.
  const byType = new Map(before.stops.map((s) => [s.type, s]));
  if (wanted && (!byType.has("pickup") || !byType.has("delivery"))) {
    const taken = new Set(before.stops.map((s) => s.sequence));
    const free = (want: number): number => { let n = want; while (taken.has(n)) n += 1; taken.add(n); return n; };
    for (const [role, seq] of [["pickup", 1], ["delivery", 2]] as const) {
      if (byType.has(role)) continue;
      const created = await tx.loadStop.create({ data: { loadId: before.id, type: role, address: "", sequence: free(seq), geocodeStatus: "pending" } });
      byType.set(role, { ...created, appointment: null });
    }
  }
  for (const role of ROLES) {
    const stop = byType.get(role);
    if (!stop) continue;
    const next = wanted?.[role]?.address;
    const addressChanged = next !== undefined && next.trim() !== stop.address.trim();
    const needsPlacing = force && stop.address.trim() !== "" && (stop.lat === null || stop.lng === null);
    if (!addressChanged && !needsPlacing) continue;
    const address = addressChanged ? next!.trim() : stop.address;
    const aspect = `can't place ${role}`;
    aspects.add(aspect);
    // The GAZETTEER only, never the provider: this runs inside the caller's
    // transaction, and a paste wraps every load of a block in one. An HTTP
    // call with a 4 s timeout per stop in there is a Postgres transaction
    // held open for as long as the network feels like. A miss stays
    // `pending` with its `can't place` line, and `settlePendingStops()` asks
    // the provider after the commit (spec §4: one writer, no I/O in it).
    const hit = address === "" ? null : gazetteerLookup(geocodeQuery(address));
    await tx.loadStop.update({
      where: { id: stop.id },
      data: { address, lat: hit?.lat ?? null, lng: hit?.lng ?? null, geocodeStatus: hit ? "ok" : "pending" },
    });
    if (!hit && address !== "") attention.push(`${aspect} "${address}" on the map`);
    if (addressChanged) changed.push(`stops.${role}`);
  }
}
/** The text a refusal quotes: the whole cell as the parser read it. */
const apptCellText = (text: string | null): string => (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" / ");

async function upsertAppointment(tx: Tx, stopId: string, type: "pickup" | "delivery", w: ApptWindow): Promise<void> {
  const data = { windowStart: new Date(w.startMs), windowEnd: new Date(w.endMs), type, kind: w.kind };
  await tx.appointment.upsert({ where: { stopId }, create: { stopId, ...data }, update: data });
}

async function deriveAppointments(tx: Tx, before: LoadRow, patch: LoadPatch, force: boolean, aspects: Set<string>, attention: string[], changed: string[]): Promise<void> {
  if (patch.stopSet) return;
  const textChanged = changed.includes("apptText");
  if (!textChanged && !force) return;
  const text = textChanged ? (patch.apptText ?? null) : before.apptText;
  const shipDate = patch.shipDate !== undefined ? patch.shipDate : before.shipDate;
  const year = shipDate ? shipDate.getUTCFullYear() : new Date().getUTCFullYear();
  const lines = (text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const parsed = parseApptText(lines, { year, tz: before.org.timezone });
  const stops = await tx.loadStop.findMany({ where: { loadId: before.id }, include: { appointment: true } });
  for (const [role, window] of [["pickup", parsed.pu], ["delivery", parsed.del]] as const) {
    const stop = stops.find((s) => s.type === role);
    if (!stop) continue;
    const label = role === "pickup" ? "PU" : "DEL";
    const aspect = `can't read ${label} appointment`;
    if (textChanged) aspects.add(aspect);
    if (window) {
      // Under force the text may only FILL a gap: an Appointment that is
      // already there is the record's truth (a Cockpit edit, an import), and
      // the text stays what they typed beside it (spec D3).
      if (textChanged || !stop.appointment) await upsertAppointment(tx, stop.id, role, window);
    } else if (textChanged && lines.length > 0) {
      // Unreadable: the previous appointment stays, and the pill says why.
      attention.push(`${aspect}: "${apptCellText(text)}"`);
    }
  }
}
async function deriveStatus(tx: Tx, before: LoadRow, patch: LoadPatch, force: boolean, changed: string[], actor: Actor, source: ChangeSource): Promise<{ changed: boolean; refused: string | null; status: string }> {
  const relevant = force || changed.includes("updateText") || changed.includes("carrierId");
  if (!relevant) return { changed: false, refused: null, status: before.status };
  const text = changed.includes("updateText") ? (patch.updateText ?? null) : before.updateText;
  const fresh = await tx.load.findUnique({ where: { id: before.id }, select: { carrierId: true, status: true } });
  const target = statusFor(text, await rulesFor(tx, before.orgId), { carrierBooked: fresh?.carrierId != null });
  const current = fresh?.status ?? before.status;
  if (target === null || target === current) return { changed: false, refused: null, status: current };
  // The guard (spec §6.3): a trip one of our drivers runs is moved by the
  // assignment lifecycle, not by a cell. Archived is never moved by text.
  if (before.assignment) return { changed: false, refused: `record says ${current} — advance the trip in the Cockpit`, status: current };
  if (current === "archived") return { changed: false, refused: "record says archived — unarchive it on the board first", status: current };
  await tx.load.update({ where: { id: before.id }, data: { status: target } });
  await tx.loadChange.create({
    // nextAtMs(), not Date.now(): applyLoadChange() already reserved this
    // call's atMs for the scalar trace before invoking derivation, so this
    // tick is guaranteed strictly later — the status entry a text edit
    // caused always outranks that edit in a newest-first change list.
    data: { loadId: before.id, orgId: before.orgId, atMs: nextAtMs(), actorId: actor.dispatcherId, actorName: actor.name, source, field: "status", before: current, after: target, note: text },
  });
  return { changed: true, refused: null, status: target };
}
