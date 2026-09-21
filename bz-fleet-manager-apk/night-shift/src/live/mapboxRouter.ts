// The platform's router, wrapped as the agent's RouterPort. Truck profile from
// the load's equipment — the legal maximum when the type is unknown — so the
// line the agent measures against is one a truck can actually drive.
import { resolveRoutes, routeKey, type LatLng } from "../../../fleet-backend/src/lib/routing.js";
import { truckProfileFor } from "../../../fleet-backend/src/lib/truckProfile.js";
import type { GeoPoint, RouteAnswer } from "../core/types.js";
import type { RouterPort } from "../ports/index.js";

type Resolve = typeof resolveRoutes;

export class MapboxRouter implements RouterPort {
  constructor(private readonly resolve: Resolve = resolveRoutes) {}

  async route(from: GeoPoint, to: GeoPoint, opts: { equipment: string; departAtMs: number }): Promise<RouteAnswer> {
    const profile = truckProfileFor({ trailerType: opts.equipment });
    const a: LatLng = { lat: from.lat, lng: from.lng };
    const b: LatLng = { lat: to.lat, lng: to.lng };
    const answers = await this.resolve([[a, b]], profile);
    const r = answers.get(routeKey(a, b, profile));
    if (!r) throw new Error("no truck-legal route from the provider (nothing returned — is MAPBOX_TOKEN set?)");
    if (!r.geometry || r.geometry.length < 2) throw new Error("no truck-legal route from the provider (miles without geometry)");
    return { geometry: r.geometry, distanceMi: r.miles, driveMin: r.minutes };
  }
}
