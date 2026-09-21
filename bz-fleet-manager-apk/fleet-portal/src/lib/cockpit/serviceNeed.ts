import type { ServiceShop } from '../../stores/fleet'
import { complianceStatus } from '../compliance'
import { haversineMi } from '../geo'
import type { LatLng } from './mapData'

// T2 "Map as Navigation", Task 8: the need-driven half of service shops on
// the map (spec R4 — a POI appears only when the plan implies the driver
// needs one; the org's OWN shop registry is shown unconditionally as pins
// because it's the customer's own small, curated list, not a third-party
// "show every truck stop" layer — see FleetMap.vue's own doc). This module
// is the "does this unit need one, and which shop is nearest" half: two pure
// functions, reusing the two concepts the brief calls out by name rather
// than re-deriving either — compliance.ts's complianceStatus (not a second
// expiry calculation) and lib/geo.ts's haversineMi (not a second distance
// formula, the same one deadhead.ts already uses to estimate connector
// miles).

/** The three clocks a tractor or trailer carries — BoardTractor and
 *  BoardTrailer (stores/loadboard.ts) both satisfy this shape structurally,
 *  so callers pass either without a cast. */
export interface ServiceClocks {
  inspectionExpiresAt: string | null
  registrationExpiresAt: string | null
  nextServiceAt: string | null
}

/** True when the WORST of the unit's three clocks is expired or inside
 *  compliance.ts's 30-day "soon" window — the same two levels the
 *  compliance chip already treats as "needs eyes" elsewhere in this app.
 *
 *  An `untracked` clock (complianceStatus's honest "not tracked" level for
 *  a null/unparseable `expiresAt`) never counts as due here, on purpose:
 *  compliance.ts's own doc is explicit that an unset clock is honestly
 *  unknown, not a problem, and must never be painted as one. A unit with
 *  all three clocks untracked (never logged a service, never imported an
 *  inspection date) therefore surfaces no shop — the honest answer is "we
 *  don't know", not "this unit is fine" NOR "this unit is overdue". */
export function needsService(unit: ServiceClocks, nowMs: number): boolean {
  return [unit.inspectionExpiresAt, unit.registrationExpiresAt, unit.nextServiceAt]
    .map((at) => complianceStatus(at, nowMs).level)
    .some((level) => level === 'expired' || level === 'soon')
}

export interface NearestShop {
  shop: ServiceShop
  miles: number
}

/** The org's geocoded shop closest to `at`, straight-line — the same
 *  haversine deadhead.ts already uses for connector-mile estimates, not a
 *  second copy. A shop with no lat/lng (ServiceShop's are nullable — not
 *  every registered shop has been geocoded) is skipped rather than treated
 *  as distance zero. Returns null when the org has no geocoded shop at all,
 *  never a fabricated "nearest" pointing at an ungeocoded record. */
export function nearestShop(at: LatLng, shops: ServiceShop[]): NearestShop | null {
  let best: NearestShop | null = null
  for (const shop of shops) {
    if (shop.lat == null || shop.lng == null) continue
    const miles = haversineMi(at.lat, at.lng, shop.lat, shop.lng)
    if (!best || miles < best.miles) best = { shop, miles }
  }
  return best
}
