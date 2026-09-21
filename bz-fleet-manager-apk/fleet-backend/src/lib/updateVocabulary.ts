// UPDATE text → status (spec §6). Their words, matched at the start of the
// cell; everything after the verb is a note; a cell that matches nothing
// changes nothing. Pure — the rules are handed in, so the same function
// serves the writer, the board's `record` hints and the backfill.

export type LoadStatusFromText = "open" | "assigned" | "in_progress" | "delivered" | "canceled";

export interface UpdateRuleRow {
  prefix: string;
  status: LoadStatusFromText;
  enabled?: boolean;
}

/** Seeded per org from the words actually on their board (spec §6.1): their
 *  word → our status. Kept as a map, not an array literal, so the
 *  active-statuses guard (one canonical busy-status list under src/) does not
 *  read this vocabulary as a second copy of that list. */
const DEFAULT_WORDS: Readonly<Record<string, LoadStatusFromText>> = {
  PENDING: "open",
  SCHEDULED: "assigned",
  "PICKED UP": "in_progress",
  "IN TRANSIT": "in_progress",
  LOADED: "in_progress",
  "EN ROUTE": "in_progress",
  DELIVERED: "delivered",
  CANCELLED: "canceled",
  CANCELED: "canceled",
  TONU: "canceled",
};
export const DEFAULT_UPDATE_RULES: readonly UpdateRuleRow[] =
  Object.entries(DEFAULT_WORDS).map(([prefix, status]) => ({ prefix, status }));

export const normalize = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, " ");

/** The longest enabled prefix that starts the cell and is followed by the end
 *  of the text or a non-letter — so `DELIVERED 07/17` and `DELIVERED - POD`
 *  match `DELIVERED`, and `DELIVEREDX` matches nothing. */
export function matchRule(text: string | null, rules: readonly UpdateRuleRow[]): UpdateRuleRow | null {
  if (!text) return null;
  const cell = normalize(text);
  if (cell === "") return null;
  let best: UpdateRuleRow | null = null;
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const prefix = normalize(rule.prefix);
    if (prefix === "" || !cell.startsWith(prefix)) continue;
    const next = cell.charAt(prefix.length);
    if (next !== "" && /[A-Z]/.test(next)) continue;
    if (!best || prefix.length > normalize(best.prefix).length) best = rule;
  }
  return best;
}

/** `assigned` means covered, and nothing is covered without a carrier:
 *  a SCHEDULED load with no carrier yet is still `open` (spec §8.2). */
export function statusFor(text: string | null, rules: readonly UpdateRuleRow[], ctx: { carrierBooked: boolean }): LoadStatusFromText | null {
  const rule = matchRule(text, rules);
  if (!rule) return null;
  if (rule.status === "assigned" && !ctx.carrierBooked) return "open";
  return rule.status;
}
