// The fleet's own GPS, fed to the agent (slice "platform GPS + rich brief",
// 2026-09-19). Until now a trip only ever saw the fixes its driver web link
// posted (driverLink.ts) — a driver who never opened the link left the
// agent blind while the Tracking screen showed him moving. Every poll this
// reads what `DriverLocation` gained since the last one for each watched
// driver and hands it to the same `onPing` the link uses, so both streams
// merge under the agent's own out-of-order guard.
import { prisma } from "../../../fleet-backend/src/db.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";

export class PlatformPings {
  /** Newest platform fix handed over, per trip. A trip starts at its own
   *  start time so a stale fix from before the switch was flipped is never
   *  replayed as "he is there now". Replaced, never mutated. */
  private cursor: Record<string, number> = {};

  async feed(registry: Registry): Promise<void> {
    for (const trip of registry.all()) {
      const driverId = trip.brief.context?.driverId ?? null;
      if (!driverId) continue;
      const since = this.cursor[trip.tripId] ?? trip.startedAtMs;
      try {
        const rows = await prisma.driverLocation.findMany({
          where: { driverId, createdAt: { gt: new Date(since) } },
          orderBy: { createdAt: "asc" },
          select: { latitude: true, longitude: true, createdAt: true },
        });
        for (const row of rows) {
          await trip.agent.onPing({ atMs: row.createdAt.getTime(), lat: row.latitude, lng: row.longitude });
        }
        if (rows.length) this.cursor = { ...this.cursor, [trip.tripId]: rows[rows.length - 1].createdAt.getTime() };
      } catch (e) {
        log("error", "platform pings: one trip failed this poll; continuing with the rest", { tripId: trip.tripId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Forget trips that are gone, so the cursor map does not grow forever.
    const live = new Set(registry.all().map((t) => t.tripId));
    this.cursor = Object.fromEntries(Object.entries(this.cursor).filter(([id]) => live.has(id)));
  }
}
