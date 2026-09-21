import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";

// The board is "theirs" because the layout is data: the column order and the
// labels of one org's sheet (spec §5.4). Import proposes it from the header
// row; the dispatcher confirms once; every board read carries it.

export type BoardColumnKey =
  | "bol" | "customer" | "phone" | "contact" | "pickupCity" | "puZip" | "delZip" | "deliveryCity"
  | "rate" | "soldRate" | "profit" | "mc" | "loadNo" | "shipDate" | "update" | "appt"
  | "agent" | "driverCell" | "extra";

export interface BoardColumn {
  key: BoardColumnKey;
  label: string;
  /** For `extra`: the sheet's own header, so export can put it back. */
  source?: string;
}

/** The customer's board, verbatim, plus the agent pill (spec §4.1). */
export const DEFAULT_BROKER_LAYOUT: BoardColumn[] = [
  { key: "bol", label: "BOL#" }, { key: "customer", label: "CUSTOMER /CARRIER" }, { key: "phone", label: "TELEPHONE#" },
  { key: "contact", label: "CONTACT NAME" }, { key: "pickupCity", label: "PICK UP" }, { key: "puZip", label: "PU ZIP" },
  { key: "delZip", label: "DEL ZIP" }, { key: "deliveryCity", label: "DELIVERY" }, { key: "rate", label: "RATE" },
  { key: "soldRate", label: "SOLD RATE" }, { key: "profit", label: "PROFIT" }, { key: "mc", label: "M.C. #" },
  { key: "loadNo", label: "LOAD#" }, { key: "shipDate", label: "SHIP DATE" }, { key: "update", label: "****UPDATE****" },
  { key: "appt", label: "APPT SCHEDULE" }, { key: "agent", label: "AGENT" },
];

/** Normalized header → key. Order inside a list does not matter; a header
 *  matches when its normalized form equals an alias exactly. */
const ALIASES: Record<Exclude<BoardColumnKey, "agent" | "driverCell" | "extra">, string[]> = {
  bol: ["bol", "bol number", "bol no"],
  customer: ["customer carrier", "customer", "customer name", "shipper", "customer / carrier"],
  phone: ["telephone", "phone", "tel", "phone number", "telephone number"],
  contact: ["contact name", "contact", "carrier contact"],
  pickupCity: ["pick up", "pickup", "origin", "pu", "pu city", "pickup city", "from"],
  puZip: ["pu zip", "pickup zip", "origin zip", "from zip"],
  delZip: ["del zip", "delivery zip", "dest zip", "destination zip", "to zip"],
  deliveryCity: ["delivery", "destination", "dest", "del", "del city", "delivery city", "to"],
  rate: ["rate", "customer rate", "bill rate", "revenue"],
  soldRate: ["sold rate", "carrier rate", "sold", "cost", "carrier pay"],
  profit: ["profit", "margin", "gross"],
  mc: ["mc", "m c", "mc number", "mc no", "carrier mc"],
  loadNo: ["load", "load no", "load number", "load id", "ref", "reference"],
  shipDate: ["ship date", "pickup date", "pu date", "date", "ship"],
  update: ["update", "updates", "status", "notes status"],
  appt: ["appt schedule", "appt", "appointment", "appointments", "appt time", "schedule"],
};

export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/\./g, "").replace(/[#*():'"_$%-]+/g, " ").replace(/\//g, " ").replace(/\s+/g, " ").trim();
}

const REQUIRED: BoardColumnKey[] = ["bol", "customer", "pickupCity", "deliveryCity", "rate", "loadNo", "appt"];

export function proposeLayout(headerRow: string[]): { columns: BoardColumn[]; unmatched: string[]; missing: BoardColumnKey[] } {
  const taken = new Set<BoardColumnKey>();
  const columns: BoardColumn[] = [];
  const unmatched: string[] = [];
  for (const raw of headerRow) {
    const label = raw.trim();
    if (!label) continue;
    const norm = normalizeHeader(label);
    if (norm === "agent" && !taken.has("agent")) {
      taken.add("agent");
      columns.push({ key: "agent", label });
      continue;
    }
    const hit = (Object.keys(ALIASES) as Array<keyof typeof ALIASES>).find((k) => !taken.has(k) && ALIASES[k].includes(norm));
    if (hit) { taken.add(hit); columns.push({ key: hit, label }); }
    else { unmatched.push(label); columns.push({ key: "extra", label, source: label }); }
  }
  if (!taken.has("agent")) columns.push({ key: "agent", label: "AGENT" });
  const missing = REQUIRED.filter((k) => !taken.has(k));
  return { columns, unmatched, missing };
}

export async function layoutFor(orgId: string): Promise<BoardColumn[]> {
  const row = await prisma.boardLayout.findUnique({ where: { orgId } });
  return row ? (row.columns as unknown as BoardColumn[]) : DEFAULT_BROKER_LAYOUT.map((c) => ({ ...c }));
}

/** `db` defaults to the global client but accepts a `Prisma.TransactionClient`
 *  so a caller (e.g. dispatcherSheet.ts's POST /mapping) can fold this save
 *  into its own transaction instead of leaving it as a separate commit that
 *  could succeed or fail independently of the write it's meant to accompany —
 *  same pattern as geocodeSettle.ts's `clearPlaceAttention`. */
export async function saveLayout(
  orgId: string,
  columns: BoardColumn[],
  db: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<void> {
  const json = columns as unknown as Prisma.InputJsonValue;
  await db.boardLayout.upsert({ where: { orgId }, create: { orgId, columns: json }, update: { columns: json } });
}
