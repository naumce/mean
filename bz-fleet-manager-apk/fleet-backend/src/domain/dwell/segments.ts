// Dwell segments: contiguous runs of in-geofence pings extracted from a
// driver's raw ping history (Control Tower T5 -- detention evidence).
//
// This is a SEPARATE domain from src/domain/dispatch/ (the assignment
// engine): dispatch consumes a *planned* dwell (LoadStop.dwellMin) a
// dispatcher enters ahead of time, while this module reports what the GPS
// trail actually *observed*. The two facts share a word and nothing else --
// never write one into the other (Global Constraint 2).
//
// Pure function: no DB, no Date, no I/O. Callers pass plain ping objects
// with epoch-ms timestamps and get plain segment objects back. The server
// (a later task) turns segments into a billable claim; this module only
// reports what the pings evidence, understating rather than assuming
// (Global Constraint 5) -- e.g. a segment's firstSeenMs is an upper bound
// on arrival, never an assertion of when the truck actually arrived.

import { haversineMi } from "../dispatch/distance.js";

export interface Ping {
  atMs: number;
  lat: number;
  lng: number;
}

export interface DwellSegment {
  /** first ping observed inside the fence. The truck may have arrived
   *  EARLIER -- this is an upper bound on arrival, so dwell is a lower
   *  bound on reality (Global Constraint 5). */
  firstSeenMs: number;
  /** last ping observed inside the fence before it left (or the last ping
   *  we have, if it never left) */
  lastSeenMs: number;
  /** lastSeen - firstSeen. Time we can actually evidence. */
  observedMin: number;
  pingCount: number;
  /** largest interval between consecutive in-fence pings. A big number
   *  means a hole in the evidence, not necessarily a hole in the dwell. */
  maxGapMin: number;
  /** true when a later ping falls OUTSIDE the fence -- i.e. we watched it
   *  leave. False means the segment is still open or the trail just ends. */
  departureObserved: boolean;
}

export const DWELL_RADIUS_MI = 0.5;

const MS_PER_MIN = 60_000;

/**
 * Split a driver's ping history into contiguous in-geofence segments.
 *
 * A segment is a maximal run of consecutive (time-sorted) pings that all
 * fall within `radiusMi` of `center`. Leaving the fence and coming back
 * always starts a NEW segment: an in/out/in trail never collapses into one
 * span, because that would assert continuous presence the pings actively
 * contradict -- and that invented span is what would eventually get billed
 * to a broker.
 */
export function dwellSegments(
  pings: Ping[],
  center: { lat: number; lng: number },
  radiusMi: number = DWELL_RADIUS_MI,
): DwellSegment[] {
  // Never trust caller ordering: a DB query's ORDER BY is a query detail,
  // not a contract this function can rely on.
  const sorted = [...pings].sort((a, b) => a.atMs - b.atMs);

  const segments: DwellSegment[] = [];
  let run: Ping[] = [];

  const flushRun = (departureObserved: boolean): void => {
    if (run.length === 0) return;
    let maxGapMs = 0;
    for (let i = 1; i < run.length; i++) {
      const gap = run[i].atMs - run[i - 1].atMs;
      if (gap > maxGapMs) maxGapMs = gap;
    }
    const first = run[0];
    const last = run[run.length - 1];
    segments.push({
      firstSeenMs: first.atMs,
      lastSeenMs: last.atMs,
      observedMin: (last.atMs - first.atMs) / MS_PER_MIN,
      pingCount: run.length,
      maxGapMin: maxGapMs / MS_PER_MIN,
      departureObserved,
    });
    run = [];
  };

  for (const ping of sorted) {
    const inFence = haversineMi(ping, center) <= radiusMi;
    if (inFence) {
      run.push(ping);
    } else {
      // A later ping fell outside the fence -- we watched the run end.
      flushRun(true);
    }
  }
  // Trail exhausted with an open run: it may still be inside the fence, or
  // it may just be where our evidence stops. Either way we never watched
  // it leave.
  flushRun(false);

  return segments;
}
