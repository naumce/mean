import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { geocodeAddress } from "./geocode.js";

// Shared loads-ingestion core: the dispatcher CSV/JSON import route and the
// public webhook route validate and upsert loads identically — only auth and
// transport differ. Rows are validated independently; an assigned/delivered
// load is never overwritten by a re-push.

export interface RowError {
  row: number;
  error: string;
}

// Per-call batch ceiling: each row costs several DB round-trips, so an
// unbounded array inside the 1MB JSON limit could still tie up the server.
export const MAX_ROWS_PER_CALL = 500;

const optionalNumber = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce.number().optional(),
);
const optionalDate = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce.date().optional(),
);

export const loadRowSchema = z.object({
  externalId: z.coerce.string().min(1),
  requiredEquip: z.enum(["DryVan", "Reefer", "Flatbed", "StepDeck", "Tanker", "Intermodal"]),
  revenueCents: optionalNumber.pipe(z.number().int().min(0).optional()).default(0),
  fscCents: optionalNumber.pipe(z.number().int().min(0).optional()).default(0),
  hazmatClass: z.preprocess((v) => (v === "" ? null : v), z.coerce.string().nullable().optional()),
  commodity: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.string().optional()),
  brokerName: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.string().optional()),
  pickupAddress: z.coerce.string().min(1),
  pickupLat: optionalNumber,
  pickupLng: optionalNumber,
  pickupWindowStart: optionalDate,
  pickupWindowEnd: optionalDate,
  deliveryAddress: z.coerce.string().min(1),
  deliveryLat: optionalNumber,
  deliveryLng: optionalNumber,
  deliveryWindowEnd: optionalDate,
});

/** One row this call actually WROTE something new for — enough for the
 *  caller to announce `load_changed` without a second query. A re-push whose
 *  content is byte-identical to what is already stored does not appear here
 *  at all (see `fieldsChanged`/`stopChanged` below): `Load.version` only
 *  moves, and only the loads that moved end up in this list, matching
 *  `loadEvents.ts`'s own "a write that changed nothing sends nothing" rule.
 *
 *  L8: `fields` names what actually moved — the real scalar keys plus
 *  `pickup`/`delivery` for a stop this push rewrote — not a blanket sentinel.
 *  A brand-new row still reports `["created"]`: there is nothing to diff a
 *  row against that did not exist a moment ago. */
export interface IngestedLoad { loadId: string; version: number; created: boolean; fields: string[] }

const SCALAR_KEYS = ["requiredEquip", "revenueCents", "fscCents", "hazmatClass", "commodity", "brokerName"] as const;

/** The scalars the ingest is authoritative for that actually differ.
 *  `next[k] === undefined` means the incoming row never carried that column
 *  (zod's `.optional()` with no default) — Prisma's `update` treats an
 *  `undefined` value as "leave the column alone", so comparing it against
 *  the stored value would report a change that was never written. */
function fieldsChanged(existing: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return SCALAR_KEYS.filter((k) => next[k] !== undefined && next[k] !== existing[k]);
}

type ExistingStop = {
  address: string; lat: number | null; lng: number | null;
  appointment: { windowStart: Date | null; windowEnd: Date | null } | null;
} | undefined;

/** True when the stop this push describes differs from the one on file —
 *  address, resolved coordinates, or appointment window. No prior stop of
 *  this role at all (`existing` undefined) counts as a change; nothing else
 *  in this file should ever leave a load with one role and not the other,
 *  but a diff that returns "changed" on an unexpected shape is the safe
 *  default, not a diff that silently returns "same". */
function stopChanged(
  existing: ExistingStop, address: string, hit: { lat: number; lng: number } | null,
  windowStart: Date | undefined, windowEnd: Date | undefined,
): boolean {
  if (!existing) return true;
  if (existing.address !== address) return true;
  if ((existing.lat ?? null) !== (hit?.lat ?? null)) return true;
  if ((existing.lng ?? null) !== (hit?.lng ?? null)) return true;
  const haveStart = existing.appointment?.windowStart?.getTime() ?? null;
  const haveEnd = existing.appointment?.windowEnd?.getTime() ?? null;
  return haveStart !== (windowStart?.getTime() ?? null) || haveEnd !== (windowEnd?.getTime() ?? null);
}

/** Validate + upsert a batch of load rows for one org. Returns the per-row
 *  report; persistence errors are captured per row, never thrown. */
export async function ingestLoadRows(
  orgId: string,
  rows: Record<string, unknown>[],
): Promise<{ imported: number; errors: RowError[]; touched: IngestedLoad[] }> {
  const errors: RowError[] = [];
  const touched: IngestedLoad[] = [];
  let imported = 0;

  for (const [i, raw] of rows.entries()) {
    const parsed = loadRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      continue;
    }
    const row = parsed.data;
    try {
      const existing = await prisma.load.findFirst({ where: { orgId, externalId: row.externalId } });
      if (existing && existing.status !== "open") {
        errors.push({ row: i + 1, error: `load ${row.externalId} is already ${existing.status}; not overwritten` });
        continue;
      }
      // Address-only rows get geocoded here (gazetteer, then any configured
      // provider); a miss leaves the stop "pending" — the engine will refuse
      // to dispatch it until coordinates exist, never guess.
      const pickup =
        row.pickupLat != null && row.pickupLng != null
          ? { lat: row.pickupLat, lng: row.pickupLng }
          : await geocodeAddress(row.pickupAddress);
      const delivery =
        row.deliveryLat != null && row.deliveryLng != null
          ? { lat: row.deliveryLat, lng: row.deliveryLng }
          : await geocodeAddress(row.deliveryAddress);
      const stopsCreate = {
        create: [
          {
            sequence: 1, type: "pickup", address: row.pickupAddress,
            lat: pickup?.lat, lng: pickup?.lng,
            geocodeStatus: pickup ? "ok" : "pending",
            ...(row.pickupWindowEnd
              ? { appointment: { create: { windowStart: row.pickupWindowStart, windowEnd: row.pickupWindowEnd, type: "pickup" } } }
              : {}),
          },
          {
            sequence: 2, type: "delivery", address: row.deliveryAddress,
            lat: delivery?.lat, lng: delivery?.lng,
            geocodeStatus: delivery ? "ok" : "pending",
            ...(row.deliveryWindowEnd
              ? { appointment: { create: { windowEnd: row.deliveryWindowEnd, type: "delivery" } } }
              : {}),
          },
        ],
      };
      const fields = {
        requiredEquip: row.requiredEquip,
        revenueCents: row.revenueCents ?? 0,
        fscCents: row.fscCents ?? 0,
        hazmatClass: row.hazmatClass ?? null,
        commodity: row.commodity,
        brokerName: row.brokerName,
      };
      if (existing) {
        // Re-import reconciliation: replace the stop set wholesale.
        //
        // The only transaction in src/ that deliberately carries no
        // respondToWriteConflict: this is not a route handler and holds no
        // `res`. The per-row catch below already answers every failure —
        // including a deadlock or a vanished Load — by recording the row in
        // `errors` and continuing with the rest of the file, which is the
        // right behaviour for a batch import and cannot leave a request
        // unanswered. Do not "fix" it by mapping it to a 409; the caller
        // (routes/dispatcherImport.ts) reports per-row outcomes, not one.
        //
        // Fix round 1: a byte-identical re-push must not move `Load.version`
        // — a webhook that fires on every poll, not just on a real change,
        // would otherwise bump the version (and announce `load_changed`) on
        // every single call, defeating the very echo comparison the event
        // exists to support. The diff is computed and the version bump
        // decided from it INSIDE the same transaction as the overwrite, so
        // "did it change" and "what got written" can never disagree.
        const changedFields = await prisma.$transaction(async (tx) => {
          const stops = await tx.loadStop.findMany({ where: { loadId: existing.id }, include: { appointment: true } });
          const pickupStop = stops.find((s) => s.type === "pickup");
          const deliveryStop = stops.find((s) => s.type === "delivery");
          // L8: the real changed-field names, not a blanket "imported"
          // sentinel — `loadEvents.ts`'s documented vocabulary is field names
          // plus `created`/`deleted`, and a re-push naming neither left the
          // Cockpit's activity feed unable to say what moved.
          const scalars = fieldsChanged(existing, fields);
          const stopFields = [
            ...(stopChanged(pickupStop, row.pickupAddress, pickup, row.pickupWindowStart, row.pickupWindowEnd) ? ["pickup"] : []),
            ...(stopChanged(deliveryStop, row.deliveryAddress, delivery, undefined, row.deliveryWindowEnd) ? ["delivery"] : []),
          ];
          const changed = [...scalars, ...stopFields];
          const stopIds = stops.map((s) => s.id);
          await tx.appointment.deleteMany({ where: { stopId: { in: stopIds } } });
          await tx.loadStop.deleteMany({ where: { loadId: existing.id } });
          await tx.load.update({
            where: { id: existing.id },
            data: { ...fields, stops: stopsCreate, ...(changed.length > 0 ? { version: { increment: 1 } } : {}) },
          });
          return changed;
        });
        if (changedFields.length > 0) {
          const fresh = await prisma.load.findUniqueOrThrow({ where: { id: existing.id }, select: { version: true } });
          touched.push({ loadId: existing.id, version: fresh.version, created: false, fields: changedFields });
        }
      } else {
        const createdRow = await prisma.load.create({ data: { orgId, externalId: row.externalId, status: "open", ...fields, stops: stopsCreate } });
        touched.push({ loadId: createdRow.id, version: createdRow.version, created: true, fields: ["created"] });
      }
      imported++;
    } catch (err) {
      // unique(orgId, externalId) race: a concurrent push created this load
      // between our findFirst and create.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        errors.push({ row: i + 1, error: `load ${row.externalId} was imported concurrently; re-push to reconcile` });
      } else {
        errors.push({ row: i + 1, error: err instanceof Error ? err.message : "import failed" });
      }
    }
  }

  return { imported, errors, touched };
}

/** Persist the audit row every ingestion call leaves behind. */
export async function auditIngestBatch(
  orgId: string,
  source: string,
  entity: string,
  imported: number,
  errors: RowError[],
): Promise<string> {
  const batch = await prisma.importBatch.create({
    data: { orgId, source, entity, rows: imported, errors: errors.length ? JSON.stringify(errors) : null },
  });
  return batch.id;
}
