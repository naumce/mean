// Whether a sheet row's patch (and its attention lines) says anything a Load
// does not already say. Kept out of sync.ts so that file stays a coordinator
// (read, decide, write) rather than growing a second job — comparing values —
// inside it. Nothing here writes anything; both functions are pure.
import { rendered, type LoadPatch } from "../loadWriter.js";

/** The columns `rowToPatch` can put in a patch, minus `stops`, `extras` and
 *  `carrier` — each of those three needs its own comparison below (`stops`
 *  and `carrier` are relations, not columns; `extras` is a JSON blob) rather
 *  than a plain `rendered()` equality. */
const SCALAR_PATCH_KEYS = [
  "boardLoadNo", "updateText", "apptText", "carrierPhone", "carrierContactName",
  "driverCell", "revenueCents", "customerEmail", "sheetRowIndex",
] as const;

/** The Load columns/relations `patchDiffers` reads. A Prisma `Load` row
 *  (plus its `stops` and `carrier`) is a structural superset of this. */
export interface CurrentLoad {
  [key: string]: unknown;
  extras: unknown;
  stops: { type: string; address: string }[];
  carrier: { name: string; mcNumber: string | null } | null;
}

function extrasDiffer(next: LoadPatch["extras"], current: unknown): boolean {
  if (next === undefined) return false;
  const a = (next ?? null) as Record<string, string> | null;
  const b = (current ?? null) as Record<string, string> | null;
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return true;
  return aKeys.some((k, i) => k !== bKeys[i] || a[k] !== b[k]);
}

function stopsDiffer(next: LoadPatch["stops"], stops: CurrentLoad["stops"]): boolean {
  if (!next) return false;
  return (["pickup", "delivery"] as const).some((role) => {
    const want = next[role]?.address;
    if (want === undefined) return false;
    const have = stops.find((s) => s.type === role)?.address ?? "";
    return want.trim() !== have.trim();
  });
}

/** `rowToPatch` only ever sends `carrier.name` (never `mcNumber`), but
 *  compare both keys the patch can carry so a future producer on this same
 *  `LoadPatch.carrier` shape is covered too. `rendered()` on both sides,
 *  same as every other scalar. */
function carrierDiffers(next: LoadPatch["carrier"], carrier: CurrentLoad["carrier"]): boolean {
  if (!next) return false;
  if (next.name !== undefined && rendered(next.name) !== rendered(carrier?.name ?? null)) return true;
  if (next.mcNumber !== undefined && rendered(next.mcNumber) !== rendered(carrier?.mcNumber ?? null)) return true;
  return false;
}

/** True when applying `patch` to `current` would change at least one field
 *  the sheet can write. Compared the same way `applyLoadChange` itself
 *  decides a scalar changed (`rendered()` on both sides), so this never
 *  disagrees with the writer about what counts as a difference. */
export function patchDiffers(patch: LoadPatch, current: CurrentLoad): boolean {
  for (const key of SCALAR_PATCH_KEYS) {
    if (!(key in patch)) continue;
    const next = (patch as Record<string, unknown>)[key];
    if (rendered(next) !== rendered(current[key])) return true;
  }
  if (extrasDiffer(patch.extras, current.extras)) return true;
  if (stopsDiffer(patch.stops, current.stops)) return true;
  if (carrierDiffers(patch.carrier, current.carrier)) return true;
  return false;
}

/** True when the row's attention lines differ from what the load already
 *  carries for the aspects the sheet owns — order does not matter, only the
 *  set of lines. */
export function attentionDiffers(next: string[], current: string[]): boolean {
  const a = [...next].sort();
  const b = [...current].sort();
  if (a.length !== b.length) return true;
  return a.some((line, i) => line !== b[i]);
}
