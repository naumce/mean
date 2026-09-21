// T5 Dwell and Detention, Task 4 — the DB-backed assembly of billable
// detention claims, one row per stop across a whole org.
//
// This module computes NOTHING. dwellSegments (segments.ts) turns raw pings
// into in-geofence dwell spans; detentionClaim (detention.ts) turns a span
// into a billable figure or refuses. This file only fetches the real data
// those two pure functions need and maps their output onto one row per stop
// — the same "glue, not math" role restCoverage.ts plays for rest stops.
//
// Query discipline: one driverLocation.findMany PER DISTINCT DRIVER across
// the whole [sinceMs, now) window, never per stop. DriverLocation is indexed
// on (driverId, createdAt); several stops on the same driver's loads share
// one fetch instead of re-querying identical ping history N times — on a
// real fleet (a week of minute-pings is ~10k rows/driver) a per-stop query
// would be catastrophic.
import { prisma } from "../db.js";
import { dwellSegments, type DwellSegment, type Ping } from "../domain/dwell/segments.js";
import { detentionClaim, DEFAULT_FREE_MIN, type DetentionClaim } from "../domain/dwell/detention.js";

export interface StopDetention {
  loadId: string;
  loadRef: string | null;
  stopId: string;
  stopLabel: string;
  stopType: string;
  driverId: string;
  driverName: string;
  /** null when no claim can honestly be made; the reason is in `noClaimReason` */
  claim: DetentionClaim | null;
  /** stated whenever claim is null, so the UI never renders a bare blank */
  noClaimReason: string | null;
  /** observed dwell even when no claim is possible — a real, useful fact */
  observedMin: number | null;
}

/** Final, dispatcher-facing copy for each of the four reasons detentionClaim
 *  can refuse a claim (it returns a bare `null`; this module supplies why).
 *  Checked in this exact order — geocode, then appointment, then evidence
 *  density, then free time — so the MOST FUNDAMENTAL problem is the one
 *  reported: a stop with a bad geocode and no appointment reports the
 *  geocode, because fixing the appointment wouldn't make the claim any more
 *  provable. `segment` may be absent entirely (zero in-fence pings), which
 *  is folded into the same "not enough evidence" bucket as a single ping —
 *  both mean presence, if any, can't be timed. */
function noClaimReasonFor(
  geocodeOk: boolean,
  windowStartMs: number | null,
  segment: DwellSegment | undefined,
): string {
  if (!geocodeOk) {
    return "This stop's location isn't precise enough to prove the truck was actually there.";
  }
  if (windowStartMs === null) {
    return "There is no appointment for this stop, so there's no agreed schedule to be detained against.";
  }
  if (!segment || segment.pingCount < 2) {
    return "There's not enough ping evidence at this stop to show how long the truck was there — at least two pings are needed to establish a duration.";
  }
  return "The dwell at this stop stayed within the agreed free time, so no detention is owed.";
}

/** Multiple disjoint dwell segments can occur at one stop's fence if the
 *  driver left and returned (dwellSegments never merges those — Task 1).
 *  This module reports the single largest one as "the" dwell for the row:
 *  the most substantial, most likely-real visit, and the one most useful to
 *  report even when it can't be billed (Global Constraint 1). Not a
 *  computation — a selection among values the pure function already
 *  produced. */
function primarySegment(segments: DwellSegment[]): DwellSegment | undefined {
  return segments.reduce<DwellSegment | undefined>(
    (best, s) => (!best || s.observedMin > best.observedMin ? s : best),
    undefined,
  );
}

/**
 * Assemble detention claims for every stop of every assigned load in an org.
 *
 * `sinceMs` bounds how far back driver ping history is fetched — the whole
 * window each driver's pings are pulled across, in one query per driver.
 */
export async function scanDetention(orgId: string, sinceMs: number): Promise<StopDetention[]> {
  const since = new Date(sinceMs);

  const [assignments, org] = await Promise.all([
    prisma.assignment.findMany({
      // orgId is the tenant boundary: a second org's loads must never appear
      // in this scan, however their assignments/drivers/pings are shaped.
      where: { orgId },
      select: {
        loadId: true,
        driverId: true,
        driver: { select: { name: true } },
        load: {
          select: {
            externalId: true,
            orderRef: true,
            stops: {
              orderBy: { sequence: "asc" },
              select: {
                id: true,
                address: true,
                type: true,
                lat: true,
                lng: true,
                geocodeStatus: true,
                detentionFreeMin: true,
                appointment: { select: { windowStart: true } },
              },
            },
          },
        },
      },
    }),
    prisma.org.findUnique({ where: { id: orgId }, select: { detentionFreeMin: true } }),
  ]);

  // Free time resolves stop -> org -> hardcoded default, field by field, `??`
  // never `||` (same pattern as resolveRateConfig in rateConfig.ts): a stop
  // that explicitly negotiated 0 free minutes means exactly that, and must
  // never be silently replaced by the org's default just because 0 is falsy.
  const orgFreeMin = org?.detentionFreeMin ?? DEFAULT_FREE_MIN;

  // One driverLocation query per DISTINCT driver, not per stop — several
  // stops (even across different loads) sharing a driver reuse the same
  // fetched ping list below instead of re-querying it.
  const driverIds = [...new Set(assignments.map((a) => a.driverId))];
  const pingsByDriver = new Map<string, Ping[]>();
  await Promise.all(
    driverIds.map(async (driverId) => {
      const rows = await prisma.driverLocation.findMany({
        where: { driverId, createdAt: { gte: since } },
        select: { latitude: true, longitude: true, createdAt: true },
      });
      pingsByDriver.set(
        driverId,
        rows.map((r) => ({ atMs: r.createdAt.getTime(), lat: r.latitude, lng: r.longitude })),
      );
    }),
  );

  const results: StopDetention[] = [];

  for (const a of assignments) {
    const pings = pingsByDriver.get(a.driverId) ?? [];

    for (const stop of a.load.stops) {
      const hasCoords = stop.lat != null && stop.lng != null;
      // Coordinates alone gate whether we can even ATTEMPT to measure dwell.
      // geocodeStatus alone gates whether a measured dwell is trustworthy
      // enough to bill — the two are checked separately so a "pending"
      // geocode with real coordinates still reports its observedMin
      // honestly, even though it can never produce a claim.
      const segments = hasCoords
        ? dwellSegments(pings, { lat: stop.lat as number, lng: stop.lng as number })
        : [];
      const segment = primarySegment(segments);

      const geocodeOk = stop.geocodeStatus === "ok" && hasCoords;
      const windowStartMs = stop.appointment?.windowStart?.getTime() ?? null;
      const freeMin = stop.detentionFreeMin ?? orgFreeMin;

      const claim = segment
        ? detentionClaim({ segment, windowStartMs, freeMin, geocodeOk })
        : null;

      // A stop where we observed NO dwell has no detention story to tell —
      // not a claim, and not a refusal either. Reporting it as "no claim, no
      // appointment" is technically true and practically noise: the first
      // live run returned 41 rows of which 38 were historical stops with no
      // pings at all, burying the three that mattered. A panel a dispatcher
      // has to scroll past is a panel they stop opening.
      //
      // Note this is NOT the same as a dwell we cannot bill: the seeded
      // bad-geocode stop has 180 real observed minutes and DOES belong here,
      // stating why it cannot be claimed. The distinction is whether the
      // truck was ever seen sitting there, not whether we can invoice it.
      if (!segment || segment.observedMin <= 0) continue;

      results.push({
        loadId: a.loadId,
        loadRef: a.load.externalId ?? a.load.orderRef ?? null,
        stopId: stop.id,
        stopLabel: stop.address,
        stopType: stop.type,
        driverId: a.driverId,
        driverName: a.driver.name,
        claim,
        noClaimReason: claim ? null : noClaimReasonFor(geocodeOk, windowStartMs, segment),
        observedMin: segment ? segment.observedMin : null,
      });
    }
  }

  return results;
}
