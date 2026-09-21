// Populate the org's rest-stop registry from REAL provider data.
//
// Why this exists: the break planner resolves each mandatory HOS break against
// `RestStop`, and that table had zero rows — so every break on every run
// reported "no rest data in this area". Honest, and useless. The map already
// fetches real rest areas along each corridor from the Mapbox Search Box
// category API (lib/routePois.ts); this walks the same corridors and files
// what it finds into the registry the planner actually reads.
//
// Nothing here is invented. Every row is a place Mapbox returned, with its own
// name and coordinates, marked `source: "provider"` so it can be told apart
// from an operator's own imported yards. `spaces` stays NULL because the
// category API does not report parking counts, and a made-up capacity is
// exactly the kind of number a driver would plan a night around.
//
// Run: npx tsx seed-rest-stops.ts

import { prisma } from "./src/db.js";
import { poisAlongRoute } from "./src/lib/routePois.js";
import { resolveRoutes, routeKey, type LatLng } from "./src/lib/routing.js";
import { truckProfileFor } from "./src/lib/truckProfile.js";

/** Two rows within this distance of each other are the same place found from
 *  two different corridors. ~0.15 mi at these latitudes. */
const DUPE_DEG = 0.002;

async function main(): Promise<void> {
  if (!process.env.MAPBOX_TOKEN) {
    console.error("MAPBOX_TOKEN is not set — refusing to run rather than seeding nothing silently.");
    process.exit(1);
  }

  // Geometry is not stored on the load — the board resolves it per request
  // (dispatcherLoadboard.ts). Resolve the same corridors here, through the same
  // router and the same truck profile, so the rest stops filed are the ones
  // beside the road the map actually draws.
  const loads = await prisma.load.findMany({
    where: { assignment: { isNot: null } },
    select: {
      id: true,
      orgId: true,
      orderRef: true,
      stops: { select: { lat: true, lng: true, sequence: true }, orderBy: { sequence: "asc" } },
    },
  });
  const routed = loads.filter((l) => l.stops.filter((s) => s.lat != null && s.lng != null).length >= 2);
  console.log(`${routed.length} assigned load(s) with two or more geocoded stops`);

  const profile = truckProfileFor({});
  const pairs: [LatLng, LatLng][] = [];
  for (const l of routed) {
    const pts = l.stops.filter((s) => s.lat != null && s.lng != null);
    for (let i = 0; i < pts.length - 1; i++) {
      pairs.push([
        { lat: pts[i].lat as number, lng: pts[i].lng as number },
        { lat: pts[i + 1].lat as number, lng: pts[i + 1].lng as number },
      ]);
    }
  }
  const routes = await resolveRoutes(pairs, profile);

  const geometryByLoad = new Map<string, [number, number][]>();
  for (const l of routed) {
    const pts = l.stops.filter((s) => s.lat != null && s.lng != null);
    const line: [number, number][] = [];
    let complete = true;
    for (let i = 0; i < pts.length - 1; i++) {
      const leg = routes.get(
        routeKey(
          { lat: pts[i].lat as number, lng: pts[i].lng as number },
          { lat: pts[i + 1].lat as number, lng: pts[i + 1].lng as number },
          profile,
        ),
      );
      if (!leg?.geometry) { complete = false; break; }
      line.push(...(i === 0 ? leg.geometry : leg.geometry.slice(1)));
    }
    if (complete && line.length > 1) geometryByLoad.set(l.id, line);
  }
  console.log(`${geometryByLoad.size} corridor(s) resolved on real road`);

  // Existing rows, so a re-run tops up rather than duplicating.
  const existing = await prisma.restStop.findMany({ select: { orgId: true, lat: true, lng: true } });
  const seen = new Set(existing.map((r) => `${r.orgId}|${r.lat.toFixed(3)}|${r.lng.toFixed(3)}`));

  let inserted = 0;
  let skipped = 0;

  for (const load of routed) {
    const geometry = geometryByLoad.get(load.id);
    if (!geometry) continue;

    const pois = await poisAlongRoute(`seed:${load.id}`, geometry);
    // Only rest areas. A gas station is not a place to take a 30 in a truck,
    // and filing one as a truck stop would be a claim the provider never made.
    const restAreas = pois.filter((p) => p.category === "rest_area");

    for (const poi of restAreas) {
      const key = `${load.orgId}|${poi.lat.toFixed(3)}|${poi.lng.toFixed(3)}`;
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      // Also reject anything essentially on top of a row inserted this run
      // from a different corridor.
      const near = [...seen].some((k) => {
        const [org, la, ln] = k.split("|");
        return (
          org === load.orgId &&
          Math.abs(Number(la) - poi.lat) < DUPE_DEG &&
          Math.abs(Number(ln) - poi.lng) < DUPE_DEG
        );
      });
      if (near) {
        skipped += 1;
        continue;
      }

      await prisma.restStop.create({
        data: {
          orgId: load.orgId,
          name: poi.name,
          kind: "rest_area",
          lat: poi.lat,
          lng: poi.lng,
          // The category API does not report capacity. NULL means unknown and
          // the UI renders it as unknown — never as zero spaces.
          spaces: null,
          amenities: [],
          source: "provider",
        },
      });
      seen.add(key);
      inserted += 1;
    }
    console.log(`  ${load.orderRef ?? load.id}: ${restAreas.length} rest area(s) along route`);
  }

  const total = await prisma.restStop.count();
  console.log(`\ninserted ${inserted}, skipped ${skipped} duplicate(s) — registry now holds ${total}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
