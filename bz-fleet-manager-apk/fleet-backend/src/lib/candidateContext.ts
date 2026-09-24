import type { DriverPreference } from "@prisma/client";
import { prisma } from "../db.js";
import { haversineMi, driveMinutes } from "../domain/dispatch/distance.js";
import {
  availabilityFor,
  cityStateFromAddress,
  lastGeocodedDeliveryStop,
  type DriverAvailabilityView,
} from "./driverAvailability.js";
import { driverMetricsBatch, type DriverMetrics } from "./driverMetrics.js";
import { gazetteerLookup } from "./geocode.js";
import { laneKey, laneRunCounts, laneRunsByDriver } from "./lanes.js";

// Candidate context (AI Dispatch Foundation, Task 6): every dispatch
// candidate row enriched with availability/ETA/HOS/lane experience/on-time
// & response evidence/home-time & preference compatibility/qualifications —
// for a human dispatcher and a future AI reader, NEVER for the deterministic
// engine. Nothing here feeds domain/dispatch/*'s feasibility or score in any
// way; it is attached to rows AFTER suggest() has already produced them
// (lib/rankDrivers.ts). Preferences in particular are context only — a
// driver who "avoids" this exact lane is still ranked and scored as if that
// preference did not exist; `laneAvoided`/`regionAvoided` below are for
// display, not a filter.
//
// Two async factories build the batched query sources, mirroring the two
// shapes callers need (both documented on driverMetricsBatch/laneRunCounts
// already): "many drivers, one load" (rankOrgDrivers ranking a load's whole
// candidate pool) and "one driver, many loads" (dispatcherDriverNext.ts's
// "what's next" list). `buildCandidateContext` itself is pure and synchronous
// so a caller can attach it inside a plain .map() once its sources exist.

export interface CandidateContextInput {
  requiredEquip: string;
  stops: { type: string; address: string; lat: number | null; lng: number | null }[];
  /** As-of instant for the sources this context is built from. Read by the
   *  two factory functions below (defaulting to Date.now() like every other
   *  "nowMs" parameter in this codebase); buildCandidateContext itself never
   *  reads it — availability/metrics are already resolved by the time it
   *  runs. Carried on this type purely so a caller can build ONE object for
   *  both purposes instead of threading nowMs through separately. */
  nowMs?: number;
}

/** The Driver-table slice buildCandidateContext needs beyond what
 *  availability/metrics already cover: home base (for home-time), HOS
 *  remaining (for hosRemaining), and qualifications. Field names match the
 *  Driver model directly. */
export interface DriverRowForContext {
  homeBaseCity: string | null;
  homeBaseState: string | null;
  equipmentTypes: string[];
  endorsements: string[];
  hazmatEndorsed: boolean;
  hos: { driveRemainingMin: number; windowRemainingMin: number } | null;
}

export interface CandidateContext {
  availability: DriverAvailabilityView;
  /** availability.availableAt + (deadheadMi at 50mph), rounded to the ms.
   *  null only if deadheadMi is somehow not a finite number. */
  estimatedArrivalAtPickupMs: number | null;
  hosRemaining: { driveMin: number | null; windowMin: number | null; known: boolean };
  /** `label` is always "Origin City, ST > Dest City, ST" (never abbreviated,
   *  never lowercased) — this is also the exact string format
   *  DriverPreference.avoidLanes entries must use to match (case/whitespace
   *  insensitive on comparison, but the shape is fixed). Task 7's seed data
   *  writes avoidLanes in this format. */
  lane: { key: string | null; label: string | null };
  /** This driver's completed runs on `lane.key` (0 when there is no key). */
  laneRuns: number;
  onTimeRate: number | null;
  responseRate: number | null;
  noResponseIncidents: number;
  homeTime: {
    homeBaseCity: string | null;
    homeBaseState: string | null;
    /** haversine miles, last geocoded delivery stop -> home base. null when
     *  either end is missing/unresolvable — never a guess. */
    deliveryToHomeMi: number | null;
    /** null when the driver has no willingToRelocateMiles set at all. */
    withinRelocate: boolean | null;
  };
  preferences: {
    maxTripMiles: number | null;
    willingToDriveNight: boolean;
    preferredEquipment: string[];
    matchesEquipmentPref: boolean;
    /** DriverPreference.avoidLanes contains this load's `lane.label`
     *  (case/whitespace insensitive). Always false when `lane.label` is
     *  null — nothing to match against. */
    laneAvoided: boolean;
    /** DriverPreference.avoidRegions contains the pickup OR delivery state —
     *  both are 2-letter codes (e.g. "NY"), matched case-insensitively. */
    regionAvoided: boolean;
  } | null;
  qualifications: { equipmentTypes: string[]; endorsements: string[]; hazmatEndorsed: boolean };
}

export interface CandidateContextSources {
  availability: Map<string, DriverAvailabilityView>;
  metrics: Map<string, DriverMetrics>;
  preferences: Map<string, DriverPreference>;
  drivers: Map<string, DriverRowForContext>;
  /** driverId (+ the SAME laneKey these sources were built for) -> run
   *  count. Not a plain Map: the "one driver, many loads" shape needs a
   *  per-CALL lane key (laneRunCounts is keyed by lane, not by driver), while
   *  the "many drivers, one load" shape has a single fixed key — this
   *  closure is the one contract both can satisfy. */
  laneRuns: (driverId: string, laneKey: string | null) => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * This load's lane by PICKUP/DELIVERY stop TYPE — the same convention
 * lib/lanes.ts's laneOfStops and lib/driverMetrics.ts's laneOfAssignmentStops
 * already use (first pickup, last delivery). Reimplemented a third time
 * rather than importing either private helper: this one also needs the
 * origin/destination STATE (not just the city) to build the "City, ST >
 * City, ST" label and to match DriverPreference.avoidRegions — a different
 * contract from both existing helpers, which only ever expose the city half
 * of cityStateFromAddress's result.
 */
function laneOfContextStops(stops: CandidateContextInput["stops"]): {
  key: string | null;
  label: string | null;
  originState: string | null;
  destState: string | null;
} {
  const pickup = stops.find((s) => s.type === "pickup");
  const delivery = [...stops].reverse().find((s) => s.type === "delivery");

  const key =
    pickup?.lat != null && pickup.lng != null && delivery?.lat != null && delivery.lng != null
      ? laneKey({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng })
      : null;

  const origin = pickup ? cityStateFromAddress(pickup.address) : { city: null, state: null };
  const dest = delivery ? cityStateFromAddress(delivery.address) : { city: null, state: null };
  const label =
    origin.city != null && origin.state != null && dest.city != null && dest.state != null
      ? `${origin.city}, ${origin.state} > ${dest.city}, ${dest.state}`
      : null;

  return { key, label, originState: origin.state, destState: dest.state };
}

/**
 * Attach context to one candidate row. Pure and synchronous — every I/O
 * result it needs was already fetched into `sources` by one of the two
 * factory functions below. Never reads feasibility/score; never returns
 * anything the engine consumes.
 */
export function buildCandidateContext(
  sources: CandidateContextSources,
  load: CandidateContextInput,
  row: { driverId: string; deadheadMi: number },
): CandidateContext {
  // Every Map below was built for exactly this candidate set (the two
  // factory functions query `driverIds`/`[driverId]` directly) — a miss here
  // means a caller built sources for the wrong drivers, not a fact about
  // this one, so failing loudly beats a silently wrong context (same
  // reasoning as driverMetrics()'s own `batch.get(driverId)!`).
  const availability = sources.availability.get(row.driverId)!;
  const metrics = sources.metrics.get(row.driverId)!;
  const driver = sources.drivers.get(row.driverId)!;
  const preferences = sources.preferences.get(row.driverId) ?? null;

  const lane = laneOfContextStops(load.stops);
  const laneRuns = lane.key ? sources.laneRuns(row.driverId, lane.key) : 0;

  const estimatedArrivalAtPickupMs = Number.isFinite(row.deadheadMi)
    ? Math.round(availability.availableAt + driveMinutes(row.deadheadMi) * 60_000)
    : null;

  const lastDrop = lastGeocodedDeliveryStop(load.stops);
  const homeHit =
    driver.homeBaseCity && driver.homeBaseState
      ? gazetteerLookup(`${driver.homeBaseCity}, ${driver.homeBaseState}`)
      : null;
  const deliveryToHomeMi =
    lastDrop && lastDrop.lat != null && lastDrop.lng != null && homeHit
      ? haversineMi({ lat: lastDrop.lat, lng: lastDrop.lng }, { lat: homeHit.lat, lng: homeHit.lng })
      : null;

  // Local bindings (not `lane.label`/`preferences.*` re-read inline) so the
  // `.some()` closures below narrow cleanly from `| null` to a plain string.
  const laneLabel = lane.label;
  const laneAvoidedFromLabel =
    preferences != null &&
    laneLabel != null &&
    preferences.avoidLanes.some((l) => l.trim().toLowerCase() === laneLabel.trim().toLowerCase());
  const originState = lane.originState;
  const destState = lane.destState;
  const regionAvoided =
    preferences != null &&
    preferences.avoidRegions.some((r) => {
      const code = r.trim().toLowerCase();
      return (originState != null && originState.toLowerCase() === code) ||
        (destState != null && destState.toLowerCase() === code);
    });

  return {
    availability,
    estimatedArrivalAtPickupMs,
    hosRemaining: {
      driveMin: driver.hos?.driveRemainingMin ?? null,
      windowMin: driver.hos?.windowRemainingMin ?? null,
      known: driver.hos != null,
    },
    lane: { key: lane.key, label: lane.label },
    laneRuns,
    onTimeRate: metrics.onTimeRate,
    responseRate: metrics.responseRate,
    noResponseIncidents: metrics.noResponseIncidents,
    homeTime: {
      homeBaseCity: driver.homeBaseCity,
      homeBaseState: driver.homeBaseState,
      deliveryToHomeMi,
      withinRelocate:
        preferences?.willingToRelocateMiles == null ? null : row.deadheadMi <= preferences.willingToRelocateMiles,
    },
    preferences: preferences
      ? {
          maxTripMiles: preferences.maxTripMiles,
          willingToDriveNight: preferences.willingToDriveNight,
          preferredEquipment: [...preferences.preferredEquipment],
          matchesEquipmentPref:
            preferences.preferredEquipment.length === 0 ||
            preferences.preferredEquipment.includes(load.requiredEquip),
          laneAvoided: laneAvoidedFromLabel,
          regionAvoided,
        }
      : null,
    qualifications: {
      equipmentTypes: [...driver.equipmentTypes],
      endorsements: [...driver.endorsements],
      hazmatEndorsed: driver.hazmatEndorsed,
    },
  };
}

// ---------------------------------------------------------------------------
// Batched source factories (the only I/O in this module)
// ---------------------------------------------------------------------------

async function driverRowsForContext(driverIds: string[]): Promise<Map<string, DriverRowForContext>> {
  const rows = await prisma.driver.findMany({
    where: { id: { in: driverIds } },
    select: {
      id: true,
      homeBaseCity: true,
      homeBaseState: true,
      equipmentTypes: true,
      endorsements: true,
      hazmatEndorsed: true,
      hos: { select: { driveRemainingMin: true, windowRemainingMin: true } },
    },
  });
  return new Map(rows.map((d) => [d.id, {
    homeBaseCity: d.homeBaseCity,
    homeBaseState: d.homeBaseState,
    equipmentTypes: d.equipmentTypes,
    endorsements: d.endorsements,
    hazmatEndorsed: d.hazmatEndorsed,
    hos: d.hos,
  }]));
}

/**
 * "Many drivers, one load" — lib/rankDrivers.ts ranking a whole candidate
 * pool against one load. ONE batched query per table regardless of how many
 * `driverIds` are given (brief): availabilityFor, driverMetricsBatch (its
 * own existing fixed-cost batch), driverPreference.findMany, driver rows
 * with hos, and laneRunsByDriver — run together, never per-candidate.
 */
export async function candidateContextSources(
  orgId: string,
  driverIds: string[],
  laneKeyForLoad: string | null,
  nowMs: number,
): Promise<CandidateContextSources> {
  const [availabilityRows, metrics, preferenceRows, drivers, runsByDriver] = await Promise.all([
    availabilityFor(orgId, driverIds, nowMs),
    // CandidateContext never surfaces averageDetentionMinutes —
    // scanDetention's 365-day org-wide scan + per-driver DriverLocation reads
    // would otherwise run on every /suggest call to compute a number nobody
    // reads. See DriverMetricsOptions's own doc comment.
    driverMetricsBatch(orgId, driverIds, nowMs, { includeDetention: false }),
    prisma.driverPreference.findMany({ where: { driverId: { in: driverIds } } }),
    driverRowsForContext(driverIds),
    laneRunsByDriver(orgId, laneKeyForLoad),
  ]);

  return {
    availability: new Map(availabilityRows.map((a) => [a.driverId, a])),
    metrics,
    preferences: new Map(preferenceRows.map((p) => [p.driverId, p])),
    drivers,
    // Defensive equality check: these sources were only ever queried for
    // `laneKeyForLoad`, so a call with any other key has no data to answer
    // from and must say 0, not silently return a different lane's count.
    laneRuns: (driverId, key) => (key === laneKeyForLoad ? runsByDriver.get(driverId) ?? 0 : 0),
  };
}

/**
 * "One driver, many loads" — routes/dispatcherDriverNext.ts ranking every
 * open load for one driver. Same shape of sources as above, but `laneRuns`
 * is backed by laneRunCounts(orgId, driverId) (Task 4), which is keyed BY
 * LANE rather than by driver — built once here so N open loads in the
 * caller's loop cost no additional queries, each just a Map lookup by that
 * load's own lane key.
 */
export async function candidateContextSourcesForDriver(
  orgId: string,
  driverId: string,
  nowMs: number,
): Promise<CandidateContextSources> {
  const [availabilityRows, metrics, preferenceRows, drivers, runsByLane] = await Promise.all([
    availabilityFor(orgId, [driverId], nowMs),
    // Same opt-out as candidateContextSources above, same reason.
    driverMetricsBatch(orgId, [driverId], nowMs, { includeDetention: false }),
    prisma.driverPreference.findMany({ where: { driverId } }),
    driverRowsForContext([driverId]),
    laneRunCounts(orgId, driverId),
  ]);

  return {
    availability: new Map(availabilityRows.map((a) => [a.driverId, a])),
    metrics,
    preferences: new Map(preferenceRows.map((p) => [p.driverId, p])),
    drivers,
    laneRuns: (id, key) => (id === driverId && key != null ? runsByLane.get(key)?.runs ?? 0 : 0),
  };
}
