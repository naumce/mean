import type { BoardColumn, BoardColumnKey } from "../boardLayout.js";
import type { SheetMapping } from "./mapping.js";

/** Confirmed sheet mapping -> the board's starting `BoardColumn[]` (spec
 *  §5.4, task 7 step 3). Deliberately its own small file rather than living
 *  inside the route: `boardLayout.ts`'s `proposeLayout` derives a layout from
 *  a header row by ALIAS GUESSING; this derives one from a mapping the
 *  dispatcher already CONFIRMED, so the two must never be merged into one
 *  "guess or confirm" function.
 *
 *  Order follows the brief's Step 3 list, not the sheet's own column order —
 *  `layoutFromMapping` is handed the mapping dict and the extras list, not
 *  the full header, so "sheet order" is not reconstructable here; `extras`
 *  itself (built by the route from `header.filter(...)`) already preserves
 *  the sheet's left-to-right order for the unmapped columns. */

const label = (header: string | undefined, key: BoardColumnKey, columns: BoardColumn[]): void => {
  if (!header) return;
  columns.push(key === "extra" ? { key, label: header, source: header } : { key, label: header });
};

export function layoutFromMapping(mapping: SheetMapping, extras: string[]): BoardColumn[] {
  const columns: BoardColumn[] = [];
  label(mapping.loadRef, "loadNo", columns);
  label(mapping.pickup, "pickupCity", columns);
  label(mapping.delivery, "deliveryCity", columns);
  label(mapping.rate, "rate", columns);
  // pickupAppt and deliveryAppt share one board column; deliveryAppt's
  // header wins the label when both are mapped (it is the required key of
  // the pair — see mapping.ts's REQUIRED_KEYS).
  const apptHeader = mapping.deliveryAppt ?? mapping.pickupAppt;
  if (apptHeader) columns.push({ key: "appt", label: apptHeader });
  label(mapping.notes, "update", columns);
  label(mapping.driverPhone, "driverCell", columns);
  label(mapping.carrierPhone, "phone", columns);
  label(mapping.carrierName, "customer", columns);
  label(mapping.driverName, "contact", columns);
  label(mapping.customerEmail, "extra", columns);
  for (const header of extras) columns.push({ key: "extra", label: header, source: header });
  columns.push({ key: "agent", label: "AGENT" });
  return columns;
}
