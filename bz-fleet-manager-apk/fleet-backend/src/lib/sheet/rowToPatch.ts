// A header + one sheet row → a LoadPatch for the traced writer
// (loadWriter.ts). Pure data hygiene: a phone's *format*, an appointment's
// *readability*, a rate's *parseability*. No thresholds, no rungs, no
// classifications — that is the agent layer built on this folder.
import type { RawRow } from "./connector.js";
import type { SheetMapping, SheetColumnKey } from "./mapping.js";
import type { LoadPatch } from "../loadWriter.js";
import { parseApptText } from "../apptText.js";
import { parseMoney } from "../brokerSheet.js";
import { AGENT_COLUMN_NAMES } from "./installColumns.js";

export interface RowResult { loadRef: string | null; patch: LoadPatch; attention: string[] }

// One representative attention line per aspect the sheet can raise. Task 8
// passes this as `attentionOwned` so a corrected cell clears its old line —
// see `attentionAspect` in loadWriter.ts (it cuts a line at its first `:` or
// `"`). Every real line this file emits has the grammar `<aspect>: <detail>`
// (blank/missing is a detail, not its own aspect), and derives to the same
// aspect as one of these seven representatives — see the audit test in
// rowToPatch.test.ts.
//
// The sixth ("unknown policy") is never raised by this file — it comes from
// `sync.ts`'s own read of the switch column (a value that names neither
// "OFF"/blank nor one of the org's policies), which this folder cannot see
// (rowToPatch's `mapping` has no key for the switch column at all). It lives
// here anyway, alongside its siblings, because this array IS the single
// list `sync.ts` passes as `attentionOwned` to every `applyLoadChange` call —
// splitting it into two lists would let a corrected switch cell's old
// "unknown policy" line survive a sheet edit that no longer raises it.
//
// The seventh (RATE) was missing until the final fix wave (I9a): a row with
// an unparsable rate raised a line no aspect owned, so `attentionDiffers`
// saw a new line on every tick and rewrote the load every tick.
// The eighth (Slice 4, Task 3) is `sync.ts`'s own, the same way the sixth
// is — a new row bearing an ARCHIVED load's number, which `rowToPatch` has
// no way to know about (it has no DB access at all).
export const SHEET_ATTENTION_ASPECTS: readonly string[] = [
  `driver phone: missing`,
  `can't read DEL appointment: missing`,
  `can't read PU appointment: missing`,
  `needs a load number`,
  `appointment: ignored "note"`,
  `unknown policy: "x"`,
  `can't read RATE "x"`,
  `archived load: "x"`,
];

const E164_RE = /^\+[1-9]\d{6,14}$/;

function normalizePhone(raw: string): { value?: string; attention?: string } {
  if (!raw) return { attention: "driver phone: missing" };
  if (E164_RE.test(raw)) return { value: raw };
  const digits = raw.replace(/[\s\-().]/g, "");
  if (/^\d{10}$/.test(digits)) return { value: `+1${digits}` };
  return { attention: `driver phone "${raw}" is not a full number with country code` };
}

function prefixed(raw: string, role: "PU" | "DEL"): string {
  return new RegExp(`^${role}\\s*:`, "i").test(raw) ? raw : `${role}: ${raw}`;
}

/** Builds the joined `apptText` and its attention lines. Reuses
 *  `parseApptText` both for the pu/del window (readability) and for its
 *  `notes` (the actual reason a line failed, or a leftover it ignored) — the
 *  note text itself is surfaced in the attention line rather than discarded,
 *  so a dispatcher sees *why*, not just *that*. */
interface ApptResult { apptText?: string; attention: string[] }

function buildAppt(pickupCell: string, deliveryCell: string, ctx: { tz: string; year: number }): ApptResult {
  // Both appointments are required (mapping.ts REQUIRED_KEYS — PU joined
  // in the final fix wave, I7), so a blank cell of either is its own
  // "missing" refusal, same shape for both.
  const missing = [
    ...(pickupCell ? [] : [`can't read PU appointment: missing`]),
    ...(deliveryCell ? [] : [`can't read DEL appointment: missing`]),
  ];

  const puLine = pickupCell ? prefixed(pickupCell, "PU") : null;
  const delLine = deliveryCell ? prefixed(deliveryCell, "DEL") : null;
  const lines = [puLine, delLine].filter((l): l is string => l !== null);

  if (!lines.length) return { attention: missing };

  return readAppt(lines, { pu: puLine !== null, del: delLine !== null }, missing, ctx);
}

/** Two-rows-per-load sheets: pickupAppt and deliveryAppt mapped to ONE
 *  column (the broker layout's "APPT SCHEDULE", folded by foldPairs.ts into
 *  a multi-line cell). The cell is a ready-made appointment block: its lines
 *  go to `parseApptText` as-is — no `PU: `/`DEL: ` prefixing, the parser
 *  finds each role by its own label or position — and a side the parser
 *  yields no window for is that side's refusal. */
function buildSharedAppt(cell: string, ctx: { tz: string; year: number }): ApptResult {
  const lines = cell.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (!lines.length) return { attention: [`can't read PU appointment: missing`, `can't read DEL appointment: missing`] };
  return readAppt(lines, { pu: true, del: true }, [], ctx);
}

/** The shared tail of both builders: parse `lines`, turn the parser's own
 *  notes into attention lines by role. `present` says which roles the
 *  caller actually handed over (a role it left out was already reported in
 *  `missing`); for a shared cell both are "present" and the parser's own
 *  "missing" note is the refusal. */
function readAppt(lines: string[], present: { pu: boolean; del: boolean }, missing: string[], ctx: { tz: string; year: number }): ApptResult {
  const parsed = parseApptText(lines, ctx);
  const notesLeft = new Set(parsed.notes);
  // Pulls this role's note out of the pool (and off `notesLeft`), stripping
  // its "PU: "/"DEL: " label since the caller already names the role.
  const takeNote = (role: "PU" | "DEL"): string | undefined => {
    const n = [...notesLeft].find((x) => x.startsWith(`${role}: `));
    if (n === undefined) return undefined;
    notesLeft.delete(n);
    return n.slice(role.length + 2);
  };

  // A role the caller left out of `lines` (blank — already reported in
  // `missing`) still makes parseApptText synthesize a "missing" note for it
  // — discard that artifact rather than surfacing it a second time as a
  // bogus `appointment:` line.
  if (!present.pu) takeNote("PU");
  if (!present.del) takeNote("DEL");

  const quoted = (role: "PU" | "DEL"): string => `"${lines.find((l) => new RegExp(`^${role}\\s*:`, "i").test(l)) ?? lines.join(" / ")}"`;
  const puUnreadable = present.pu && !parsed.pu ? [`can't read PU appointment: ${takeNote("PU") ?? quoted("PU")}`] : [];
  const delUnreadable = present.del && !parsed.del ? [`can't read DEL appointment: ${takeNote("DEL") ?? quoted("DEL")}`] : [];
  // Whatever note is left over described a line that DID parse to a window
  // (an ignored trailing scrap, a PU/DEL-order conflict resolved some other
  // way) — not a read failure, so it gets its own aspect.
  const leftoverNotes = [...notesLeft].map((n) => `appointment: ${n}`);

  return { apptText: lines.join("\n"), attention: [...missing, ...puUnreadable, ...delUnreadable, ...leftoverNotes] };
}

function cellFor(header: string[], row: RawRow, mapping: SheetMapping, key: SheetColumnKey): string {
  const h = mapping[key];
  if (h === undefined) return "";
  const idx = header.indexOf(h);
  if (idx === -1) return "";
  return (row.cells[idx] ?? "").trim();
}

export function rowToPatch(row: RawRow, header: string[], mapping: SheetMapping, ctx: { tz: string; year: number }): RowResult {
  const get = (key: SheetColumnKey): string => cellFor(header, row, mapping, key);

  const loadRef = get("loadRef") || null;
  const phone = normalizePhone(get("driverPhone"));
  const driverName = get("driverName");
  const pickup = get("pickup");
  const delivery = get("delivery");
  const sharedAppt = mapping.pickupAppt !== undefined && mapping.pickupAppt === mapping.deliveryAppt;
  const appt = sharedAppt ? buildSharedAppt(get("pickupAppt"), ctx) : buildAppt(get("pickupAppt"), get("deliveryAppt"), ctx);
  const customerEmail = get("customerEmail");
  const carrierName = get("carrierName");
  const carrierPhone = get("carrierPhone");
  const rateRaw = get("rate");
  const rateCents = rateRaw ? parseMoney(rateRaw) : null;
  const notes = get("notes");

  const stops: NonNullable<LoadPatch["stops"]> = {
    ...(pickup ? { pickup: { address: pickup } } : {}),
    ...(delivery ? { delivery: { address: delivery } } : {}),
  };

  // A mapped header absent from this row's own header array (stale mapping)
  // reads as blank throughout `get`/`cellFor` above; extras below only ever
  // sees headers actually present in `header`, so it never conflicts. The
  // two agent columns are excluded too: a status write (e.g. "● WATCHING")
  // would otherwise land in `extras` and trigger a Load update on the very
  // next tick — the sheet layer already reads the switch column itself
  // (sync.ts) and has no notion of the status column at all.
  const mappedHeaders = new Set(Object.values(mapping));
  const agentHeaders = new Set<string>([AGENT_COLUMN_NAMES.switch, AGENT_COLUMN_NAMES.status]);
  const extras = Object.fromEntries(
    header
      .map((h, idx) => [h, (row.cells[idx] ?? "").trim()] as const)
      .filter(([h, cell]) => cell !== "" && !mappedHeaders.has(h) && !agentHeaders.has(h)),
  );

  const patch: LoadPatch = {
    sheetRowIndex: row.rowIndex,
    ...(loadRef ? { boardLoadNo: loadRef } : {}),
    ...(phone.value ? { driverCell: phone.value } : {}),
    ...(driverName ? { carrierContactName: driverName } : {}),
    ...(Object.keys(stops).length ? { stops } : {}),
    ...(appt.apptText ? { apptText: appt.apptText } : {}),
    ...(customerEmail ? { customerEmail } : {}),
    ...(carrierName ? { carrier: { name: carrierName } } : {}),
    ...(carrierPhone ? { carrierPhone } : {}),
    ...(rateRaw && rateCents !== null ? { revenueCents: rateCents } : {}),
    ...(notes ? { updateText: notes } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
  };

  const attention = [
    ...(loadRef ? [] : ["needs a load number"]),
    ...(phone.attention ? [phone.attention] : []),
    ...appt.attention,
    ...(rateRaw && rateCents === null ? [`can't read RATE "${rateRaw}"`] : []),
  ];

  return { loadRef, patch, attention };
}
