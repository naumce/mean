// One board cell → where it goes. The exact inverse of the mapping
// `dispatcherBrokerBoard.ts` uses to build the two rows of a load, expressed
// as a plan so the decision is pure and testable and the route only executes.
//
// Three rules run through all of it:
//   · A cell nobody can honestly write (PROFIT, the "MC" label, the agent's
//     own column) is REFUSED, with the sentence the dispatcher will read.
//   · Free text — UPDATE, APPT, names, phones — is stored exactly as typed.
//   · A cell with no field of its own goes to `extras` rather than nowhere:
//     a paste must never silently drop what someone typed.
import type { BoardColumnKey } from "./boardLayout.js";
import { parseMoney, parseSheetDate } from "./brokerSheet.js";

export type BoardRow = "top" | "bottom";

export interface CellWrite {
  row: BoardRow;
  key: BoardColumnKey;
  /** the sheet's own header text, for an `extra` column */
  source?: string;
  value: string;
}

export type CellPlan =
  | { kind: "load"; field: LoadTextField; value: string | null }
  | { kind: "money"; field: "revenueCents" | "soldRateCents"; cents: number | null }
  | { kind: "date"; field: "shipDate"; at: Date | null }
  | { kind: "carrier"; field: "name" | "mcNumber"; value: string }
  | { kind: "stop"; stop: "pickup" | "delivery"; part: "city" | "zip"; value: string }
  | { kind: "appt"; line: number; value: string }
  | { kind: "extras"; key: string; value: string }
  | { kind: "refuse"; reason: string };

export type LoadTextField =
  | "bolNumber" | "customerName" | "trackingUrl" | "orderRef" | "updateText"
  | "carrierPhone" | "carrierContactName" | "boardLoadNo" | "driverCell";

/** Text columns, by the row they sit on. Empty clears the field to null. */
const TEXT: Record<BoardRow, Partial<Record<BoardColumnKey, LoadTextField>>> = {
  top: { bol: "bolNumber", customer: "customerName", phone: "trackingUrl", loadNo: "orderRef", update: "updateText", driverCell: "driverCell" },
  bottom: { phone: "carrierPhone", contact: "carrierContactName", loadNo: "boardLoadNo" },
};

const MONEY: Partial<Record<BoardColumnKey, "revenueCents" | "soldRateCents">> = { rate: "revenueCents", soldRate: "soldRateCents" };
const STOPS: Partial<Record<BoardColumnKey, { stop: "pickup" | "delivery"; part: "city" | "zip" }>> = {
  pickupCity: { stop: "pickup", part: "city" }, puZip: { stop: "pickup", part: "zip" },
  deliveryCity: { stop: "delivery", part: "city" }, delZip: { stop: "delivery", part: "zip" },
};
/** Columns the carrier owns, on the carrier line only. */
const CARRIER: Partial<Record<BoardColumnKey, "name" | "mcNumber">> = { customer: "name", mc: "mcNumber" };

/** Every column the board can render — anything else is a bad request, not a
 *  cell to file away under `extras`. */
const KNOWN: ReadonlySet<string> = new Set<BoardColumnKey>([
  "bol", "customer", "phone", "contact", "pickupCity", "puZip", "delZip", "deliveryCity",
  "rate", "soldRate", "profit", "mc", "loadNo", "shipDate", "update", "appt", "agent", "driverCell", "extra",
]);

const refuse = (reason: string): CellPlan => ({ kind: "refuse", reason });

export function planCellWrite(write: CellWrite): CellPlan {
  const { row, key, value } = write;
  if (!KNOWN.has(key)) return refuse(`There is no "${key}" column on this board`);

  if (key === "profit") return refuse("PROFIT is RATE minus SOLD RATE — edit one of those and it follows");
  if (key === "agent") return refuse("The AGENT column is the agent's own status; it is not typed");
  if (key === "mc" && row === "top") return refuse('The customer line prints the label "MC"; the number goes on the carrier line under it');

  if (key === "extra") {
    const header = write.source?.trim();
    if (!header) return refuse("That column has no header, so there is nowhere to keep the value");
    return { kind: "extras", key: row === "top" ? header : `${header}:2`, value };
  }

  if (key === "appt") return { kind: "appt", line: row === "top" ? 0 : 1, value };

  if (row === "bottom" && CARRIER[key]) return { kind: "carrier", field: CARRIER[key] as "name" | "mcNumber", value: value.trim() };

  const text = TEXT[row][key];
  if (text) return { kind: "load", field: text, value: value === "" ? null : value };

  // Money, dates and stops only exist on the customer line; the same column
  // on the carrier line is a cell their sheet uses for something else.
  if (row === "top") {
    const money = MONEY[key];
    if (money) {
      if (value.trim() === "") return { kind: "money", field: money, cents: null };
      const cents = parseMoney(value);
      if (cents === null) return refuse(`"${value}" is not an amount — ${key === "rate" ? "RATE" : "SOLD RATE"} keeps the number it had`);
      return { kind: "money", field: money, cents };
    }
    if (key === "shipDate") {
      if (value.trim() === "") return { kind: "date", field: "shipDate", at: null };
      const at = parseSheetDate(value);
      if (at === null) return refuse(`"${value}" is not a date — write it as 7/13/2026`);
      return { kind: "date", field: "shipDate", at };
    }
    const stop = STOPS[key];
    if (stop) {
      if (stop.part === "zip" && value.trim() !== "" && !/^\d{5}$/.test(value.trim())) return refuse(`"${value}" is not a ZIP code`);
      return { kind: "stop", stop: stop.stop, part: stop.part, value: stop.part === "zip" ? value.trim() : value };
    }
  }

  // Everything left is a real column with no field on this line: the second
  // line of a ship date, a rate typed under a rate, a contact name on the
  // customer row. Keep it verbatim, keyed by line.
  return { kind: "extras", key: `${key}:${row === "top" ? 1 : 2}`, value };
}
