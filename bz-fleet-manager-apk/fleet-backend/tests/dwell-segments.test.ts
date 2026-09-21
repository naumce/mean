import { dwellSegments, DWELL_RADIUS_MI, type Ping } from "../src/domain/dwell/segments.js";

// Fence center. 0.5mi default radius ~= 0.00725 deg latitude at this
// latitude -- points below are chosen well inside/outside that margin so
// float noise in haversineMi never flips a case, except the boundary test
// which pins the point to the fence radius exactly.
const CENTER = { lat: 39.0997, lng: -94.5786 };

// A point ~2mi east of CENTER -- well outside the 0.5mi fence.
const OUTSIDE = { lat: 39.0997, lng: -94.55 };

const MIN = 60_000; // one minute, in ms

it("pings entirely inside the fence collapse to one segment spanning first..last", () => {
  const pings: Ping[] = [
    { atMs: 0, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 10 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 25 * MIN, lat: CENTER.lat, lng: CENTER.lng },
  ];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(1);
  expect(segs[0]).toMatchObject({
    firstSeenMs: 0,
    lastSeenMs: 25 * MIN,
    observedMin: 25,
    pingCount: 3,
    maxGapMin: 15,
    departureObserved: false,
  });
});

it("in, in, out ends the segment at the last in-fence ping and marks departure observed", () => {
  const pings: Ping[] = [
    { atMs: 0, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 10 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 20 * MIN, lat: OUTSIDE.lat, lng: OUTSIDE.lng },
  ];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(1);
  expect(segs[0]).toMatchObject({
    firstSeenMs: 0,
    lastSeenMs: 10 * MIN,
    observedMin: 10,
    pingCount: 2,
    departureObserved: true,
  });
});

// The case that carries the task: the truck left the geofence and came
// back. Merging in-out-in into one first-to-last span would invent
// continuous presence the pings actively contradict, and that invented
// span is what would get billed to a broker. This must produce TWO
// segments, not one.
it("in, out, in produces TWO segments -- leaving and returning is not one continuous dwell", () => {
  const pings: Ping[] = [
    { atMs: 0, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 10 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 20 * MIN, lat: OUTSIDE.lat, lng: OUTSIDE.lng },
    { atMs: 30 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 40 * MIN, lat: CENTER.lat, lng: CENTER.lng },
  ];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(2);

  expect(segs[0]).toMatchObject({
    firstSeenMs: 0,
    lastSeenMs: 10 * MIN,
    observedMin: 10,
    pingCount: 2,
    departureObserved: true,
  });
  expect(segs[1]).toMatchObject({
    firstSeenMs: 30 * MIN,
    lastSeenMs: 40 * MIN,
    observedMin: 10,
    pingCount: 2,
    // trail ends inside the fence -- we never watched it leave again
    departureObserved: false,
  });
});

it("a single in-fence ping yields a segment with observedMin 0, not dropped", () => {
  const pings: Ping[] = [{ atMs: 5 * MIN, lat: CENTER.lat, lng: CENTER.lng }];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(1);
  expect(segs[0]).toMatchObject({
    firstSeenMs: 5 * MIN,
    lastSeenMs: 5 * MIN,
    observedMin: 0,
    pingCount: 1,
    maxGapMin: 0,
    departureObserved: false,
  });
});

it("no pings at all yields no segments", () => {
  expect(dwellSegments([], CENTER)).toEqual([]);
});

it("no pings inside the fence yields no segments", () => {
  const pings: Ping[] = [
    { atMs: 0, lat: OUTSIDE.lat, lng: OUTSIDE.lng },
    { atMs: 10 * MIN, lat: OUTSIDE.lat, lng: OUTSIDE.lng },
  ];
  expect(dwellSegments(pings, CENTER)).toEqual([]);
});

it("maxGapMin is the largest consecutive gap, not the average", () => {
  // gaps: 2min, 30min, 3min -- largest is 30, average would be ~11.7
  const pings: Ping[] = [
    { atMs: 0, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 2 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 32 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 35 * MIN, lat: CENTER.lat, lng: CENTER.lng },
  ];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(1);
  expect(segs[0].maxGapMin).toBe(30);
});

it("sorts out-of-order pings before processing -- caller ordering is never trusted", () => {
  // Same physical sequence as the "entirely inside" case, but handed in
  // scrambled order. A caller whose DB query lacks (or changes) an
  // ORDER BY must not corrupt dwell.
  const pings: Ping[] = [
    { atMs: 25 * MIN, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 0, lat: CENTER.lat, lng: CENTER.lng },
    { atMs: 10 * MIN, lat: CENTER.lat, lng: CENTER.lng },
  ];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(1);
  expect(segs[0]).toMatchObject({
    firstSeenMs: 0,
    lastSeenMs: 25 * MIN,
    observedMin: 25,
    pingCount: 3,
  });
});

it("a ping exactly on the radius boundary is treated as inside (<=)", () => {
  // Move due north from CENTER by exactly DWELL_RADIUS_MI, using the same
  // great-circle relation haversineMi reduces to when dLng=0 (distance =
  // EARTH_RADIUS_MI * toRad(deltaLat)), then nudge a hair (1e-9deg,
  // ~7e-8mi -- far below the fence's real-world precision) back toward
  // CENTER. That nudge absorbs the ~1e-13mi trig round-off that would
  // otherwise land the analytic boundary a hair OUTSIDE the fence and
  // flip a strict "<=" check by float noise alone, while still pinning
  // the point at the boundary rather than safely inside it.
  const EARTH_RADIUS_MI = 3958.7613;
  const EPS_DEG = 1e-9;
  const deltaLatDeg = (DWELL_RADIUS_MI * 180) / (Math.PI * EARTH_RADIUS_MI) - EPS_DEG;
  const boundary = { lat: CENTER.lat + deltaLatDeg, lng: CENTER.lng };
  const pings: Ping[] = [{ atMs: 0, lat: boundary.lat, lng: boundary.lng }];
  const segs = dwellSegments(pings, CENTER);
  expect(segs).toHaveLength(1);
  expect(segs[0].pingCount).toBe(1);
});
