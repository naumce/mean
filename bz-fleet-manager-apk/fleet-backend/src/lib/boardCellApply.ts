// A `CellPlan` (what a cell means) → a `LoadPatch` (what to write). Pure: the
// writer does the writing, so a paste of forty cells on one load composes
// forty small patches into the load's state one after another.
//
// Two cells need the load's current state to compose their value: APPT is one
// text cell rendered as lines (a write replaces one line), and `extras` is a
// map (a write sets or removes one key).
import { Prisma } from "@prisma/client";
import type { CellPlan } from "./boardCellWrite.js";
import type { LoadPatch } from "./loadWriter.js";

export interface PatchContext {
  apptText: string | null;
  extras: Prisma.JsonValue | null;
  /** the current city/zip halves per role, so a city write keeps the ZIP beside it */
  stopCity?: Partial<Record<"pickup" | "delivery", string>>;
  stopZip?: Partial<Record<"pickup" | "delivery", string>>;
}

/** APPT SCHEDULE is one text cell rendered as lines; a write replaces one
 *  line and keeps the others. Trailing blanks are dropped so an emptied
 *  second line does not leave the cell ending in a newline forever. */
export function spliceLine(text: string | null, line: number, value: string): string | null {
  const lines = (text ?? "").split("\n");
  while (lines.length <= line) lines.push("");
  lines[line] = value;
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length === 0 ? null : lines.join("\n");
}

/** `extras` is a plain object; an emptied cell removes its key rather than
 *  storing "" forever, and the last key removed takes the column back to null. */
export function mergeExtras(current: Prisma.JsonValue | null, key: string, value: string): Prisma.InputJsonValue | null {
  const base: Record<string, string> = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, string>) } : {};
  if (value === "") delete base[key];
  else base[key] = value;
  return Object.keys(base).length === 0 ? null : base;
}

export function planToPatch(plan: CellPlan, ctx: PatchContext): LoadPatch {
  switch (plan.kind) {
    case "load": return { [plan.field]: plan.value } as LoadPatch;
    case "money": return { [plan.field]: plan.cents } as LoadPatch;
    case "date": return { shipDate: plan.at };
    case "carrier": return plan.field === "name" ? { carrier: { name: plan.value } } : { carrier: { mcNumber: plan.value } };
    case "stop": return { stops: { [plan.stop]: { address: plan.part === "city" ? composeAddress(plan.value, ctx.stopZip?.[plan.stop] ?? "") : composeAddress(ctx.stopCity?.[plan.stop] ?? "", plan.value) } } } as LoadPatch;
    case "appt": return { apptText: spliceLine(ctx.apptText, plan.line, plan.value) };
    case "extras": return { extras: mergeExtras(ctx.extras, plan.key, plan.value) };
    case "refuse": throw new Error(`refused plan translated: ${plan.reason}`);
  }
}

/** A paste lands several cells on one load; the writer takes ONE patch per
 *  load, so the version bumps once and the trace is one batch. Scalars: the
 *  later cell wins. `stops` and `carrier` merge one level deep, so a pickup
 *  city and a delivery ZIP pasted together both survive. */
export function mergePatch(acc: LoadPatch, next: LoadPatch): LoadPatch {
  const out: LoadPatch = { ...acc, ...next };
  if (acc.stops || next.stops) out.stops = { ...acc.stops, ...next.stops };
  if (acc.carrier || next.carrier) out.carrier = { ...acc.carrier, ...next.carrier };
  return out;
}

/** The context the NEXT cell of the same load translates against, after this
 *  one's patch: the APPT text it splices a line into, the extras it adds a
 *  key to, the city/ZIP halves it composes an address with. Returns a new
 *  context; the one handed in is left alone. */
export function advanceContext(ctx: PatchContext, patch: LoadPatch): PatchContext {
  const stopCity = { ...ctx.stopCity };
  const stopZip = { ...ctx.stopZip };
  for (const role of ["pickup", "delivery"] as const) {
    const address = patch.stops?.[role]?.address;
    if (address === undefined) continue;
    const parts = splitAddress(address);
    stopCity[role] = parts.city;
    stopZip[role] = parts.zip;
  }
  return {
    apptText: "apptText" in patch ? (patch.apptText ?? null) : ctx.apptText,
    extras: "extras" in patch ? ((patch.extras ?? null) as Prisma.JsonValue | null) : ctx.extras,
    stopCity,
    stopZip,
  };
}

/** A stop write on the board is a city or a ZIP, and the address is both.
 *  "Henderson, NV 89074" ⇄ { city: "Henderson, NV", zip: "89074" } — the
 *  same split the board's GET does when it renders the two columns. */
export const composeAddress = (city: string, zip: string): string => (zip ? `${city.trim()} ${zip}`.trim() : city.trim());
export const splitAddress = (address: string): { city: string; zip: string } => ({
  city: address.replace(/\s*\d{5}$/, "").trim(),
  zip: address.match(/(\d{5})$/)?.[1] ?? "",
});
