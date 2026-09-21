// The registered rest/fuel stops the break planner and the stop rule read —
// the platform's own registry, boxed to the route so a cross-country table
// is not loaded for a 40-mile run.
import { prisma } from "../../../fleet-backend/src/db.js";
import { REST_STOP_SEARCH_MI } from "../core/constants.js";
import type { LngLat, RestStop } from "../core/types.js";

const MI_PER_DEG_LAT = 69.09;

export async function restStopsNear(geometry: LngLat[], orgId: string | null): Promise<RestStop[]> {
  if (geometry.length === 0) return [];
  const lats = geometry.map((p) => p[1]);
  const lngs = geometry.map((p) => p[0]);
  const padLat = REST_STOP_SEARCH_MI / MI_PER_DEG_LAT;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLng = padLat / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const rows = await prisma.restStop.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      lat: { gte: Math.min(...lats) - padLat, lte: Math.max(...lats) + padLat },
      lng: { gte: Math.min(...lngs) - padLng, lte: Math.max(...lngs) + padLng },
    },
    select: { name: true, lat: true, lng: true },
  });
  return rows.map((r) => ({ name: r.name, lat: r.lat, lng: r.lng }));
}
