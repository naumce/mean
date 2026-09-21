// A dispatcher's sheet columns rarely match our field names. This proposes a
// mapping by header alias (never guesses at cell content), and validates a
// mapping someone confirmed. Nothing here knows about phones, dates or
// money — that is `rowToPatch.ts`.
import { normalizeHeader } from "../boardLayout.js";

export type SheetColumnKey =
  | "loadRef" | "driverPhone" | "driverName" | "pickup" | "delivery"
  | "pickupAppt" | "deliveryAppt" | "customerEmail" | "carrierName"
  | "carrierPhone" | "rate" | "notes";

// pickupAppt is required too (final fix wave, I7): the agent's brief needs a
// departure time as much as a deadline, and the writer's own appointment
// derivation raises "can't read PU appointment" on a load whose text has no
// PU line — a column the sheet was never asked for is not a refusal a
// dispatcher can act on, so the sheet is asked for it up front.
export const REQUIRED_KEYS: readonly SheetColumnKey[] = ["loadRef", "driverPhone", "pickup", "delivery", "pickupAppt", "deliveryAppt"];

/** Our key → their header, verbatim (as it appears in the header row). */
export type SheetMapping = Partial<Record<SheetColumnKey, string>>;

const ALIASES: Record<SheetColumnKey, string[]> = {
  loadRef: ["load", "load no", "load number", "load id", "ref", "reference", "pro", "pro number"],
  driverPhone: ["driver phone", "driver cell", "driver tel", "cell", "phone", "driver number"],
  driverName: ["driver", "driver name"],
  pickup: ["pick up", "pickup", "origin", "pu", "pu city", "from", "shipper"],
  delivery: ["delivery", "destination", "dest", "del", "del city", "to", "consignee"],
  pickupAppt: ["pu appt", "pickup appt", "pu time", "pickup time", "pu appointment"],
  deliveryAppt: ["del appt", "delivery appt", "del time", "delivery time", "appt", "appointment", "appt schedule", "delivery appointment"],
  customerEmail: ["customer email", "email", "contact email"],
  carrierName: ["carrier", "carrier name"],
  carrierPhone: ["carrier phone", "carrier tel"],
  rate: ["rate", "customer rate", "revenue", "bill rate"],
  notes: ["notes", "update", "comments", "status"],
};

const KEYS = Object.keys(ALIASES) as SheetColumnKey[];

/** Every valid `SheetColumnKey`, for callers (e.g. dispatcherSheet.ts's
 *  `POST /mapping` zod schema) that need to reject an unknown key at the
 *  boundary rather than silently accept it into a `SheetMapping`. */
export const SHEET_COLUMN_KEYS: readonly SheetColumnKey[] = KEYS;

export function proposeSheetMapping(header: string[]): { mapping: SheetMapping; extras: string[]; missing: SheetColumnKey[] } {
  const taken = new Set<SheetColumnKey>();
  const mapping: SheetMapping = {};
  const extras: string[] = [];
  for (const raw of header) {
    const label = raw.trim();
    if (!label) continue;
    const norm = normalizeHeader(label);
    const hit = KEYS.find((k) => !taken.has(k) && ALIASES[k].includes(norm));
    if (hit) {
      taken.add(hit);
      mapping[hit] = raw;
    } else {
      extras.push(raw);
    }
  }
  const missing = REQUIRED_KEYS.filter((k) => !taken.has(k));
  return { mapping, extras, missing };
}

/** required present, every header exists, no header used twice. */
export function validateMapping(header: string[], mapping: SheetMapping): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const headerSet = new Set(header);
  const usedBy = new Map<string, SheetColumnKey[]>();
  for (const [key, h] of Object.entries(mapping) as [SheetColumnKey, string][]) {
    if (!headerSet.has(h)) {
      errors.push(`"${h}" is not a header in this sheet`);
      continue;
    }
    const list = usedBy.get(h) ?? [];
    usedBy.set(h, [...list, key]);
  }
  for (const [h, keys] of usedBy) {
    if (keys.length > 1) errors.push(`"${h}" is used for both ${keys.join(" and ")}`);
  }
  for (const req of REQUIRED_KEYS) {
    if (!mapping[req]) errors.push(`missing required key "${req}"`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function columnIndexes(header: string[], mapping: SheetMapping): Partial<Record<SheetColumnKey, number>> {
  const result: Partial<Record<SheetColumnKey, number>> = {};
  for (const [key, h] of Object.entries(mapping) as [SheetColumnKey, string][]) {
    const idx = header.indexOf(h);
    if (idx !== -1) result[key] = idx;
  }
  return result;
}
