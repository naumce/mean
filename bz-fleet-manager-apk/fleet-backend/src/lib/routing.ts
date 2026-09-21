import { prisma } from "../db.js";
import { profileKey, type TruckProfile } from "./truckProfile.js";

// Pluggable road-routing provider. Two are supported, chosen by env:
//
//   ROUTER_URL    an OSRM-compatible HTTP API (self-hosted osrm-backend or
//                 anything speaking /route/v1/driving/{lng},{lat};...).
//   MAPBOX_TOKEN  Mapbox Directions v5. Takes effect only when ROUTER_URL is
//                 unset, so an existing self-hosted deployment is never
//                 silently redirected to a paid third party.
//
// TRUCK ROUTING: Mapbox honours `max_height`, `max_weight` and `max_width`, and
// they matter — a car routes Manhattan -> Queens in 22,941 m while a 4.11 m /
// 36 t combination routes 37,468 m, because the loaded truck is banned from the
// tunnel the car uses. Pass a TruckProfile and the geometry comes back
// truck-legal for DIMENSIONS.
//
// It does NOT cover hazmat: Mapbox rejects `hazmat=` and `max_hazmat=` outright,
// so a placarded load is routed as ordinary freight and hazmat bans are not
// applied. `TruckProfile.hazmatRoutingApplied` carries that fact to callers and
// is always false today. OSRM (ROUTER_URL) applies no dimensions at all.
// Results are cached in RouteDistance keyed by rounded coord pair — fleets
// run the same lanes, so each unique pair costs one provider call ever.
//
// The dispatch engine stays pure and synchronous: callers pre-resolve the
// pairs a plan needs with buildRoadMilesFn() and hand the engine a sync
// lookup. No ROUTER_URL (or any provider failure) -> the lookup returns null
// and the engine falls back to haversine × roadFactor, exactly as before.

export interface LatLng {
  lat: number;
  lng: number;
}

// 12s, not 4s. A truck-constrained route is a bigger computation and a much
// bigger payload — KC->Denver comes back with 6,539 geometry points against the
// car version's few hundred — and at 4s a burst of requests silently lost 7 of
// 31 lanes to timeouts, each one falling back to haversine. The fallback is
// honest (precision stays "estimated") but losing a fifth of the fleet's
// geometry to an impatient timeout is just a bug.
const PROVIDER_TIMEOUT_MS = 12_000;
const METERS_PER_MILE = 1609.344;

/** Rounded to ~110m precision — close enough to share cache entries between
 *  repeated imports of the same facility. */
export function routeKey(from: LatLng, to: LatLng, profile: TruckProfile | null = null): string {
  // The profile is PART OF THE KEY. A 4.11 m / 36 t route is a different road
  // from a car's, and sharing one cache entry would hand a truck the car's
  // geometry — silently, and only on the second request.
  return `${from.lat.toFixed(3)},${from.lng.toFixed(3)}>${to.lat.toFixed(3)},${to.lng.toFixed(3)}|${profileKey(profile)}`;
}

/** What a provider returns for one pair. `geometry` is a GeoJSON LineString's
 *  coordinate array ([lng, lat] pairs) as the provider drew it — the actual
 *  road, not a straight line. Null when the provider gave no geometry. */
export interface RouteResult {
  miles: number;
  minutes: number;
  geometry: [number, number][] | null;
  source: string;
}

type RouteBody = {
  routes?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] } }[];
};

/** Read the first route out of an OSRM-shaped body. Mapbox Directions v5
 *  speaks the same response shape as OSRM (it is OSRM-derived), so one parser
 *  serves both and there is no second definition of "what a route looks like". */
function parseRoute(body: RouteBody, source: string): RouteResult | null {
  const route = body.routes?.[0];
  if (route?.distance == null || !Number.isFinite(route.distance)) return null;
  const coords = route.geometry?.coordinates;
  return {
    miles: route.distance / METERS_PER_MILE,
    minutes: (route.duration ?? 0) / 60,
    geometry: Array.isArray(coords) && coords.length > 1 ? coords : null,
    source,
  };
}

async function fetchRoute(from: LatLng, to: LatLng, profile: TruckProfile | null): Promise<RouteResult | null> {
  const osrm = process.env.ROUTER_URL;
  const mapbox = process.env.MAPBOX_TOKEN;
  // ROUTER_URL wins: a deployment that stood up its own router must not start
  // billing a third party because a token happened to be present.
  // OSRM takes no dimensions — a self-hosted router returns car geometry
  // regardless, which is why `source` records which provider answered.
  const truck = profile
    ? `&max_height=${profile.heightM}&max_width=${profile.widthM}&max_weight=${profile.weightT}`
    : "";
  const url = osrm
    ? `${osrm.replace(/\/$/, "")}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`
    : mapbox
      ? `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
        `?overview=full&geometries=geojson&access_token=${encodeURIComponent(mapbox)}${truck}`
      : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseRoute((await res.json()) as RouteBody, osrm ? "osrm" : profile ? "mapbox-truck" : "mapbox");
  } catch {
    return null;
  }
}

/** True when any routing provider is configured. Callers use this to decide
 *  whether a plan's distances can be labelled `routed` or must stay `estimated`. */
export function routingConfigured(): boolean {
  return Boolean(process.env.ROUTER_URL || process.env.MAPBOX_TOKEN);
}

/** Resolve every pair (cache first, then provider) and return a synchronous
 *  lookup for the engine. Without ROUTER_URL this is a constant-null fn —
 *  zero DB or network work. */
export async function resolveRoutes(
  pairs: [LatLng, LatLng][],
  profile: TruckProfile | null = null,
): Promise<Map<string, RouteResult>> {
  const resolved = new Map<string, RouteResult>();
  if (!routingConfigured()) return resolved;

  const unique = new Map<string, [LatLng, LatLng]>();
  for (const [from, to] of pairs) unique.set(routeKey(from, to, profile), [from, to]);

  for (const [key, [from, to]] of unique) {
    const cached = await prisma.routeDistance.findUnique({ where: { key } });
    if (cached) {
      let geometry: [number, number][] | null = null;
      // A cache row written before geometry existed, or by a provider that
      // returned none, still serves its miles — it just cannot draw a road.
      if (cached.geometry) {
        try {
          const parsed: unknown = JSON.parse(cached.geometry);
          if (Array.isArray(parsed) && parsed.length > 1) geometry = parsed as [number, number][];
        } catch {
          geometry = null; // corrupt row: fall back to an arc, never throw
        }
      }
      resolved.set(key, {
        miles: cached.miles,
        minutes: cached.minutes ?? 0,
        geometry,
        source: cached.source,
      });
      continue;
    }
    const fetched = await fetchRoute(from, to, profile);
    if (!fetched) continue; // this pair falls back to haversine
    resolved.set(key, fetched);
    // Best-effort cache write; a race on the unique key is harmless.
    await prisma.routeDistance
      .create({
        data: {
          key,
          miles: fetched.miles,
          minutes: fetched.minutes,
          geometry: fetched.geometry ? JSON.stringify(fetched.geometry) : null,
          source: fetched.source,
        },
      })
      .catch(() => {});
  }

  return resolved;
}

/** The engine's synchronous miles lookup, built from the same resolution pass
 *  that produced the geometry. One provider call feeds BOTH the distance the
 *  plan is costed on and the line the map draws, so the two can never disagree
 *  about where a truck goes. */
export async function buildRoadMilesFn(
  pairs: [LatLng, LatLng][],
  profile: TruckProfile | null = null,
): Promise<(from: LatLng, to: LatLng) => number | null> {
  const routes = await resolveRoutes(pairs, profile);
  return (from, to) => routes.get(routeKey(from, to, profile))?.miles ?? null;
}
