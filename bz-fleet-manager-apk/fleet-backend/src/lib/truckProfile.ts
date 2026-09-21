// The vehicle a route is planned FOR — height, width and gross weight.
//
// Mapbox Directions honours `max_height`, `max_weight` and `max_width`, and the
// difference is not cosmetic: on a Manhattan -> Queens run, a car routes 22,941 m
// while a 4.2 m / 36 t combination routes 37,468 m, because the loaded truck is
// banned from the tunnel the car takes. Routing a 13'6" trailer on car geometry
// does not merely mis-estimate the miles; it sends a driver at a bridge that
// will take the roof off.
//
// WHAT THIS DOES NOT COVER, stated plainly because the gap is dangerous:
// hazmat. Mapbox has no hazmat parameter — `hazmat=` and `max_hazmat=` are both
// rejected outright — so a placarded load routed here is routed as ordinary
// freight, and hazmat road/tunnel bans are NOT applied. `hazmatRoutingApplied`
// below is how a caller learns that, and it is always false today.

/** US legal maxima without a permit, in metric because that is what the
 *  provider takes. 13'6" = 4.11 m, 8'6" = 2.59 m, 80,000 lb = 36.29 t. */
export const LEGAL_HEIGHT_M = 4.11;
export const LEGAL_WIDTH_M = 2.59;
export const LEGAL_GROSS_T = 36.29;

/** Empty (tare) weight of a tractor plus trailer, tonnes. A load's own weight
 *  is added on top; without it the gross would be the freight alone, which is
 *  roughly half the truth and would clear weight-restricted roads it should
 *  not. */
const TARE_T = 15.4; // ~34,000 lb tractor + trailer

export interface TruckProfile {
  heightM: number;
  widthM: number;
  /** gross combination weight, tonnes */
  weightT: number;
  /** false whenever the load is placarded — the provider cannot apply hazmat
   *  restrictions, so the caller must not present the route as hazmat-legal */
  hazmatRoutingApplied: boolean;
}

/** Height by trailer type. A flatbed's height depends on what is ON it, which
 *  we do not know, so it takes the legal maximum: over-stating height routes
 *  around a bridge that would have fit, which costs miles. Under-stating it
 *  routes under one that will not, which costs the trailer. */
const HEIGHT_BY_TYPE: Record<string, number> = {
  DryVan: 4.11,
  Reefer: 4.11,
  Intermodal: 4.11,
  Tanker: 4.06,
  // Flatbed/StepDeck: the deck is low but the freight is not. Assume legal max.
  Flatbed: 4.11,
  StepDeck: 4.11,
};

const LBS_PER_TONNE = 2204.62;

/**
 * Build the routing profile for a load on a trailer. Unknown trailer type or
 * missing weight falls back to the LEGAL MAXIMUM rather than to zero — an
 * unknown truck must be routed as the largest one it might be, never as a car.
 */
export function truckProfileFor(args: {
  trailerType?: string | null;
  loadWeightLbs?: number | null;
  hazmatClass?: string | null;
}): TruckProfile {
  const heightM = HEIGHT_BY_TYPE[args.trailerType ?? ""] ?? LEGAL_HEIGHT_M;
  const freightT = args.loadWeightLbs != null ? args.loadWeightLbs / LBS_PER_TONNE : null;
  // Cap at the legal gross: a load heavier than that needs a permit and a
  // routed answer here would be fiction either way.
  const weightT = freightT != null ? Math.min(LEGAL_GROSS_T, TARE_T + freightT) : LEGAL_GROSS_T;
  return {
    heightM,
    widthM: LEGAL_WIDTH_M,
    weightT: Math.round(weightT * 10) / 10,
    // Always false: the provider has no hazmat parameter. Kept as a field
    // rather than a comment so the day a hazmat-capable provider is wired in,
    // every consumer already reads the right thing.
    hazmatRoutingApplied: false,
  };
}

/** A stable, short key fragment for the route cache. A route planned for a
 *  4.11 m / 36 t combination is NOT the route planned for a car, so the two
 *  must never share a cache entry — which they would if the key stayed
 *  coordinates-only. */
export function profileKey(p: TruckProfile | null): string {
  return p ? `h${p.heightM}w${p.widthM}t${p.weightT}` : "car";
}
