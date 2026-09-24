import { driveMinutes, roadMiles } from "./geo.mjs";

// Assignment economics — the brief's own approximations, applied
// consistently everywhere a Load/Assignment pair is built: "loadedMi ~=
// haversine x 1.2, driveMin ~= loadedMi/50 h, onDutyMin = driveMin + dwell,
// marginCents ~= 18% of revenue". Pure and deterministic given its inputs.
const MARGIN_RATE = 0.18;

export function tripEconomics(origin, destination, revenueCents, { dwellMin = 120, deadheadMi = 0 } = {}) {
  const loadedMi = roadMiles(origin, destination);
  const driveMin = driveMinutes(loadedMi);
  return {
    loadedMi: Math.round(loadedMi * 10) / 10,
    driveMin: Math.round(driveMin),
    onDutyMin: Math.round(driveMin + dwellMin),
    marginCents: Math.round(revenueCents * MARGIN_RATE),
    deadheadMi,
    // A modest, plausible "empty miles avoided" figure — never asserted by
    // any test, just flavor for the same KPI seed-demo.mjs's history feeds.
    savedMi: Math.round(deadheadMi * 0.3),
  };
}

/** revenueCents for a `loadedMi`-mile run at a plausible $1.80-$2.80/loaded
 *  mile — the range every generic historical/current load in this world
 *  prices from. */
export function revenueForMiles(rand, loadedMi, ratePerMileCentsRange = [180, 280]) {
  const [lo, hi] = ratePerMileCentsRange;
  const ratePerMileCents = lo + rand() * (hi - lo);
  return Math.round(loadedMi * ratePerMileCents);
}
