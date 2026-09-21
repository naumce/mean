// Points of interest along a route — the fuel stops and rest areas a
// dispatcher points a driver at ("there's a rest area 8 miles ahead").
//
// Fetched live from the Mapbox Search Box category API and cached per route,
// because the alternative — bundling a POI dataset — means inventing facility
// coordinates, which this product refuses to do.
//
// PROVIDER LIMITS, stated because they shape what can honestly be offered:
// `gas_station` and `rest_area` return results. `truck_stop`, `weigh_station`,
// `car_repair` and `truck_dealer` return NOTHING from this provider — verified,
// not assumed. So this layer shows fuel and rest, and does not pretend to know
// where a truck-legal service bay or scale is. A `gas_station` is also not
// necessarily truck-accessible: no height, no lane width, no diesel guarantee.
// The UI must not describe these as truck stops.

import { prisma } from "../db.js";
import { haversineMi } from "../domain/dispatch/distance.js";

export type PoiCategory = "gas_station" | "rest_area";

/** The categories worth querying. Ordered: rest first — it is the one tied to
 *  a legal obligation (the HOS break), fuel is an optimisation. */
export const POI_CATEGORIES: PoiCategory[] = ["rest_area", "gas_station"];

export interface RoutePoi {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lng: number;
  address: string | null;
  /** miles from the route's start, measured along the polyline */
  distanceAlongMi: number;
  /** how far the POI sits off the route line itself */
  offRouteMi: number;
}

/** How often to sample the polyline when searching. 40 mi with a ~25 mi
 *  result radius leaves no unsearched gap, without one request per point. */
const SAMPLE_EVERY_MI = 40;
/** A POI further than this from the line is not "along the route". Tight on
 *  purpose: at 12 mi the first live run returned things 9 miles sideways in
 *  downtown Memphis, which is a 20-minute round trip for a truck and not a
 *  stop anyone would take. */
const MAX_OFF_ROUTE_MI = 5;

/** Keep at most one POI per category per this many miles of road. The raw
 *  provider result for a 451-mile lane was 169 places — every gas station in
 *  every town it passes. That is not a map, it is a hairball, and it buries
 *  the one stop a driver actually needs. Thinning to roughly one option per
 *  segment keeps a choice always within reach ahead without the clutter. */
const THIN_SEGMENT_MI = 45;
const PROVIDER_TIMEOUT_MS = 4000;
/** Refetch a route's POIs after this long — facilities open and close. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SamplePoint {
  lat: number;
  lng: number;
  alongMi: number;
}

/** Walk the polyline, emitting a point roughly every SAMPLE_EVERY_MI, and
 *  return the cumulative length so callers can measure "how far along". */
export function sampleAlong(
  geometry: [number, number][],
  everyMi = SAMPLE_EVERY_MI,
): { samples: SamplePoint[]; totalMi: number } {
  const samples: SamplePoint[] = [];
  if (geometry.length < 2) return { samples, totalMi: 0 };
  let along = 0;
  let sinceLast = Infinity; // force a sample at the start
  let prev = { lat: geometry[0][1], lng: geometry[0][0] };
  for (const [lng, lat] of geometry) {
    const here = { lat, lng };
    const step = haversineMi(prev, here);
    along += step;
    sinceLast += step;
    if (sinceLast >= everyMi) {
      samples.push({ lat, lng, alongMi: along });
      sinceLast = 0;
    }
    prev = here;
  }
  return { samples, totalMi: along };
}

/** Distance from a point to the polyline, and how far along the line the
 *  nearest vertex sits. Vertex-granularity is enough here: the provider's own
 *  coordinates are street-level and the line has thousands of points. */
export function nearestOnRoute(
  geometry: [number, number][],
  p: { lat: number; lng: number },
): { offRouteMi: number; alongMi: number } {
  let best = { offRouteMi: Infinity, alongMi: 0 };
  let along = 0;
  let prev = { lat: geometry[0][1], lng: geometry[0][0] };
  for (const [lng, lat] of geometry) {
    const here = { lat, lng };
    along += haversineMi(prev, here);
    const d = haversineMi(p, here);
    if (d < best.offRouteMi) best = { offRouteMi: d, alongMi: along };
    prev = here;
  }
  return best;
}

interface SearchFeature {
  properties?: {
    mapbox_id?: string;
    name?: string;
    full_address?: string;
    place_formatted?: string;
    coordinates?: { latitude?: number; longitude?: number };
  };
}

async function searchCategory(
  category: PoiCategory,
  at: SamplePoint,
  token: string,
): Promise<SearchFeature[]> {
  const url =
    `https://api.mapbox.com/search/searchbox/v1/category/${category}` +
    `?proximity=${at.lng},${at.lat}&limit=10&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!res.ok) return [];
    const body = (await res.json()) as { features?: SearchFeature[] };
    return body.features ?? [];
  } catch {
    return []; // one dead sample must not lose the whole corridor
  }
}

/**
 * Fetch every POI along a route, cached by route key. Returns [] when no
 * provider token is configured — the caller renders nothing rather than
 * inventing stops.
 */
export async function poisAlongRoute(
  routeKeyStr: string,
  geometry: [number, number][],
): Promise<RoutePoi[]> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token || geometry.length < 2) return [];

  const cached = await prisma.routePoiCache.findUnique({ where: { key: routeKeyStr } });
  if (cached && Date.now() - cached.createdAt.getTime() < CACHE_TTL_MS) {
    try {
      return JSON.parse(cached.payload) as RoutePoi[];
    } catch {
      // corrupt row: fall through and refetch rather than throwing
    }
  }

  const { samples } = sampleAlong(geometry);
  const byId = new Map<string, RoutePoi>();

  for (const category of POI_CATEGORIES) {
    for (const at of samples) {
      for (const f of await searchCategory(category, at, token)) {
        const id = f.properties?.mapbox_id;
        const lat = f.properties?.coordinates?.latitude;
        const lng = f.properties?.coordinates?.longitude;
        const name = f.properties?.name;
        if (!id || !name || typeof lat !== "number" || typeof lng !== "number") continue;
        if (byId.has(id)) continue;
        const { offRouteMi, alongMi } = nearestOnRoute(geometry, { lat, lng });
        // The category search is proximity-based, so it happily returns places
        // well off the corridor. A "rest area" 40 miles sideways is not on this
        // driver's route and must not be offered as if it were.
        if (offRouteMi > MAX_OFF_ROUTE_MI) continue;
        byId.set(id, {
          id,
          name,
          category,
          lat,
          lng,
          address: f.properties?.full_address ?? f.properties?.place_formatted ?? null,
          distanceAlongMi: alongMi,
          offRouteMi,
        });
      }
    }
  }

  const pois = thinAlongRoute([...byId.values()].sort((a, b) => a.distanceAlongMi - b.distanceAlongMi));
  await prisma.routePoiCache
    .upsert({
      where: { key: routeKeyStr },
      create: { key: routeKeyStr, payload: JSON.stringify(pois) },
      update: { payload: JSON.stringify(pois), createdAt: new Date() },
    })
    .catch(() => {});
  return pois;
}

/**
 * Keep the closest-to-the-road POI in each (category, segment) bucket. Pure and
 * exported so the thinning rule is testable on its own — it decides what a
 * dispatcher sees, so it should not be buried inside a fetch.
 */
export function thinAlongRoute(
  pois: readonly RoutePoi[],
  segmentMi = THIN_SEGMENT_MI,
): RoutePoi[] {
  const best = new Map<string, RoutePoi>();
  for (const p of pois) {
    const bucket = `${p.category}:${Math.floor(p.distanceAlongMi / segmentMi)}`;
    const held = best.get(bucket);
    // Closest to the road wins the segment: least detour for the driver.
    if (!held || p.offRouteMi < held.offRouteMi) best.set(bucket, p);
  }
  return [...best.values()].sort((a, b) => a.distanceAlongMi - b.distanceAlongMi);
}

/**
 * The first POI of a category at or after a point on the route — "the next
 * rest area ahead of where the break falls". Null when there is none ahead,
 * which is a real answer and must not be rendered as the nearest behind.
 */
export function nextPoiAfter(
  pois: readonly RoutePoi[],
  category: PoiCategory,
  afterMi: number,
): RoutePoi | null {
  return pois.find((p) => p.category === category && p.distanceAlongMi >= afterMi) ?? null;
}
