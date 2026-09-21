// The other half of geocoding (spec §4). `applyLoadChange` runs inside the
// caller's transaction and may only consult the in-memory gazetteer, so a
// stop the gazetteer does not know is written `pending` with its
// `can't place <role> "…" on the map` line. This settles those stops
// afterwards, OUTSIDE any transaction, against the configured provider — the
// slow, network-bound half that must never hold a Postgres transaction open.
//
// With no provider configured (the default, and every test that does not set
// GEOCODER_URL) the gazetteer IS the whole geocoder: there is nothing left to
// try, so this returns 0 without touching the database at all.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { geocodeAddress, providerConfigured } from "./geocode.js";
import { attentionAspect, geocodeQuery, nextAtMs } from "./loadWriter.js";

/** One load this call placed at least one stop for: the roles it placed, and
 *  the version AFTER the bump — the same shape `load_changed` needs, so a
 *  caller can hand this straight to `emitLoadChanged`. */
export interface SettledLoad { loadId: string; version: number; roles: string[] }

/** Ask the provider about every still-unplaced stop of these loads. A hit is
 *  written to the stop and clears that stop's `can't place <role>` attention
 *  row — the refusal is about a stop we could not place, and we just did.
 *
 *  M6: before this fix the coordinate writes landed with no version bump and
 *  no trace row — a stop the provider placed was invisible to every other
 *  board until someone reloaded, and the row kept showing its old "can't
 *  place" state. Every load that got at least one stop placed is now settled
 *  in its own transaction — one version bump, one `LoadChange` row, matching
 *  the shape `POST /loads/:id/geocode` (dispatcherLoads.ts) already uses —
 *  and returned so the caller can announce it. Returns one entry per load
 *  actually touched, not a load with nothing placed. */
export async function settlePendingStops(orgId: string, loadIds: string[]): Promise<SettledLoad[]> {
  if (!providerConfigured() || loadIds.length === 0) return [];
  const ids = [...new Set(loadIds)];
  const stops = await prisma.loadStop.findMany({
    // Org-scoped through the load, never by id alone: these ids reach this
    // function from a route body.
    where: { loadId: { in: ids }, load: { orgId }, OR: [{ lat: null }, { lng: null }] },
    select: { id: true, loadId: true, type: true, address: true },
  });
  // The network half runs first and OUTSIDE any transaction, exactly as
  // before — a provider call inside a Postgres transaction is the bug this
  // whole module exists to avoid. Only once every hit is known do the writes
  // for one load land together, atomically, with their version bump.
  const hits: { stopId: string; loadId: string; role: string; lat: number; lng: number }[] = [];
  for (const stop of stops) {
    const address = stop.address.trim();
    if (address === "") continue;
    const hit = await geocodeAddress(geocodeQuery(address));
    if (!hit) continue;
    hits.push({ stopId: stop.id, loadId: stop.loadId, role: stop.type, lat: hit.lat, lng: hit.lng });
  }
  if (hits.length === 0) return [];
  const byLoad = new Map<string, typeof hits>();
  for (const h of hits) byLoad.set(h.loadId, [...(byLoad.get(h.loadId) ?? []), h]);

  const settled: SettledLoad[] = [];
  for (const [loadId, loadHits] of byLoad) {
    const roles = [...new Set(loadHits.map((h) => h.role))];
    const version = await prisma.$transaction(async (tx) => {
      for (const h of loadHits) {
        await tx.loadStop.update({ where: { id: h.stopId }, data: { lat: h.lat, lng: h.lng, geocodeStatus: "ok" } });
      }
      for (const role of roles) await clearPlaceAttention(loadId, role, tx);
      const bumped = await tx.load.update({ where: { id: loadId }, data: { version: { increment: 1 } }, select: { version: true } });
      await tx.loadChange.create({
        data: {
          loadId, orgId, atMs: nextAtMs(), actorId: null, actorName: "geocoder",
          source: "system", field: "geocode", before: null, after: `placed ${roles.join(", ")}`, note: null,
        },
      });
      return bumped.version;
    });
    settled.push({ loadId, version, roles });
  }
  return settled;
}

/** Drop the `can't place <role>` row for one stop, and only that one — the
 *  other role's refusal, and every unrelated aspect, stay exactly as they
 *  are (attention is replaced per aspect, never wholesale).
 *
 *  `db` defaults to the bare client (this function's original shape, still
 *  right for `settlePendingStops` above, which runs deliberately OUTSIDE any
 *  transaction) but accepts a `Prisma.TransactionClient` so a caller that
 *  needs this row cleared atomically alongside its own writes — e.g.
 *  `dispatcherLoads.ts`'s geocode recovery route — can pass its `tx` through. */
export async function clearPlaceAttention(loadId: string, role: string, db: PrismaClient | Prisma.TransactionClient = prisma): Promise<void> {
  const aspect = `can't place ${role}`;
  const rows = await db.agentUpdate.findMany({ where: { loadId, kind: "attention" }, select: { id: true, text: true } });
  const stale = rows.filter((r) => attentionAspect(r.text) === aspect).map((r) => r.id);
  if (stale.length) await db.agentUpdate.deleteMany({ where: { id: { in: stale } } });
}
