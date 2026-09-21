// Detention claims: whether an observed dwell (src/domain/dwell/segments.ts)
// adds up to a figure a carrier can invoice a broker for.
//
// This suite is deliberately more about REFUSALS than arithmetic. Detention
// is billed to a third party -- a broker's first question is "how do you
// know?" -- so every situation where the evidence doesn't support a claim
// must come back `null`, never a zero-minute row that a dispatcher could
// accidentally send (Global Constraint 1 & 5).

import {
  detentionClaim,
  DEFAULT_FREE_MIN,
  GAP_REVIEW_MIN,
  type DetentionInput,
} from "../src/domain/dwell/detention.js";
import type { DwellSegment } from "../src/domain/dwell/segments.js";

const MIN = 60_000; // one minute, in ms
const HOUR = 60 * MIN;

// A segment with sane, individually-overridable defaults so each test only
// spells out the fields that matter to it. The defaults alone (span of
// 200min, 3 pings, a 10min max gap, departure observed) describe an
// otherwise-clean, otherwise-billable dwell -- so tests that flip a single
// input field are shown suppressing (or flagging) a claim that would
// otherwise go through.
function segment(overrides: Partial<DwellSegment> = {}): DwellSegment {
  return {
    firstSeenMs: 0,
    lastSeenMs: 200 * MIN,
    observedMin: 200,
    // 30, not a token 2-3: a real ping stream is minute-by-minute, and a
    // sparse record now carries its own review reason. These tests are about
    // the GAP and DEPARTURE reasons, so their fixture should not also be
    // tripping the evidence-density one.
    pingCount: 30,
    maxGapMin: 10,
    departureObserved: true,
    ...overrides,
  };
}

function input(
  overrides: Partial<Omit<DetentionInput, "segment">> & { segment?: Partial<DwellSegment> } = {},
): DetentionInput {
  const { segment: segmentOverrides, ...rest } = overrides;
  return {
    segment: segment(segmentOverrides),
    windowStartMs: 0,
    freeMin: DEFAULT_FREE_MIN,
    geocodeOk: true,
    ...rest,
  };
}

// --- The four null cases (Step 1 table) ------------------------------------

it("returns null when geocodeOk is false -- a city-centroid fence is not evidence of being at the dock, even with an otherwise clean, billable claim", () => {
  const claim = detentionClaim(input({ geocodeOk: false }));
  expect(claim).toBeNull();
});

it("returns null when windowStartMs is null -- no appointment means nothing to be late against, even with an otherwise clean, billable claim", () => {
  const claim = detentionClaim(input({ windowStartMs: null }));
  expect(claim).toBeNull();
});

it("returns null when segment.pingCount is below 2 -- one ping proves presence, not a span, even though the timestamps alone would otherwise bill 80min", () => {
  // firstSeenMs/lastSeenMs still span 200min so a naive implementation that
  // forgot this guard would happily bill it; pingCount is what stops it.
  const claim = detentionClaim(input({ segment: { pingCount: 1 } }));
  expect(claim).toBeNull();
});

it("returns null when billableMin would be zero or negative -- inside free time is not a zero-dollar claim, it is no claim", () => {
  // Observed span is 200min (default segment); free time of 250min covers
  // it entirely, so raw billable is negative before clamping.
  expect(detentionClaim(input({ freeMin: 250 }))).toBeNull();
  // Exactly at the boundary -- observed span equals free time exactly, so
  // billableMin lands on 0, not a negative number. Still null: "<= 0" from
  // the brief includes the zero case.
  expect(detentionClaim(input({ freeMin: 200 }))).toBeNull();
});

// --- clockStartMs: later of arrival and window open -------------------------

it("clockStartMs equals the window open time when the truck arrives before the window opens", () => {
  const claim = detentionClaim(
    input({
      windowStartMs: 5 * HOUR,
      segment: { firstSeenMs: 2 * HOUR, lastSeenMs: 9 * HOUR },
      freeMin: 60,
    }),
  );
  expect(claim).not.toBeNull();
  expect(claim!.clockStartMs).toBe(5 * HOUR);
  // (9h - 5h) - 60min free = 180min billable, counted from window open, not
  // from the 2h arrival.
  expect(claim!.billableMin).toBe(180);
});

it("clockStartMs equals the arrival time when the truck arrives after the window has already opened", () => {
  const claim = detentionClaim(
    input({
      windowStartMs: 0,
      segment: { firstSeenMs: 50 * MIN, lastSeenMs: 200 * MIN },
      freeMin: 20,
    }),
  );
  expect(claim).not.toBeNull();
  expect(claim!.clockStartMs).toBe(50 * MIN);
  expect(claim!.billableMin).toBe(200 - 50 - 20); // 130
});

it("a truck arriving 3h early and sitting 1h past its window start bills only the time after free time from the window, not from arrival", () => {
  const claim = detentionClaim(
    input({
      windowStartMs: 0,
      segment: {
        firstSeenMs: -3 * HOUR, // arrived 3h before the window opened
        lastSeenMs: 1 * HOUR, // still there 1h after the window opened
      },
      freeMin: 30,
    }),
  );
  expect(claim).not.toBeNull();
  // Clock starts at window open (0), not at the 3h-early arrival.
  expect(claim!.clockStartMs).toBe(0);
  // Billable = (1h past window) - 30min free = 30min. A from-arrival
  // calculation would have produced (4h span) - 30min = 210min instead --
  // this pins the correct, much smaller, conservative number.
  expect(claim!.billableMin).toBe(30);
});

it("billableMin is never negative: when the ping trail ends before the detention clock even starts, the claim is clamped to zero and suppressed rather than reported as negative", () => {
  const claim = detentionClaim(
    input({
      windowStartMs: 600 * MIN, // appointment much later
      segment: { firstSeenMs: 0, lastSeenMs: 60 * MIN }, // trail already over
      freeMin: 30,
    }),
  );
  // Raw (lastSeen - clockStart) is deeply negative here; the claim must
  // come back null (billableMin <= 0), never a negative number.
  expect(claim).toBeNull();
});

// --- needsReview: flagged, not suppressed -----------------------------------

it("needsReview is true with a readable reason when maxGapMin exceeds GAP_REVIEW_MIN", () => {
  const gap = GAP_REVIEW_MIN + 15;
  const claim = detentionClaim(input({ segment: { maxGapMin: gap, departureObserved: true } }));
  expect(claim).not.toBeNull();
  expect(claim!.needsReview).toBe(true);
  expect(claim!.reviewReasons).toEqual([`evidence has a ${gap}m gap`]);
});

it("a gap exactly at GAP_REVIEW_MIN does not trigger review -- the threshold is strictly greater-than", () => {
  const claim = detentionClaim(
    input({ segment: { maxGapMin: GAP_REVIEW_MIN, departureObserved: true } }),
  );
  expect(claim).not.toBeNull();
  expect(claim!.needsReview).toBe(false);
  expect(claim!.reviewReasons).toEqual([]);
});

it("needsReview is true with a readable reason when departure was never observed", () => {
  const claim = detentionClaim(
    input({ segment: { maxGapMin: 5, departureObserved: false } }),
  );
  expect(claim).not.toBeNull();
  expect(claim!.needsReview).toBe(true);
  expect(claim!.reviewReasons).toEqual([
    "departure never observed; dwell may be longer or the trail may simply end",
  ]);
});

it("both needsReview reasons fire together when the segment has a large gap AND no observed departure", () => {
  const gap = GAP_REVIEW_MIN + 20;
  const claim = detentionClaim(
    input({ segment: { maxGapMin: gap, departureObserved: false } }),
  );
  expect(claim).not.toBeNull();
  expect(claim!.needsReview).toBe(true);
  expect(claim!.reviewReasons).toEqual([
    `evidence has a ${gap}m gap`,
    "departure never observed; dwell may be longer or the trail may simply end",
  ]);
});

// --- a clean claim -----------------------------------------------------------

it("a clean claim (small gap, departure observed) has needsReview false, reviewReasons empty, and carries its evidence through unchanged", () => {
  const claim = detentionClaim(
    input({
      windowStartMs: 0,
      freeMin: DEFAULT_FREE_MIN,
      segment: {
        firstSeenMs: 0,
        lastSeenMs: 200 * MIN,
        pingCount: 30,
        maxGapMin: 10,
        departureObserved: true,
      },
    }),
  );
  expect(claim).not.toBeNull();
  expect(claim).toEqual({
    clockStartMs: 0,
    freeMin: DEFAULT_FREE_MIN,
    billableMin: 200 - DEFAULT_FREE_MIN, // 80
    evidence: {
      pingCount: 30,
      maxGapMin: 10,
      firstSeenMs: 0,
      lastSeenMs: 200 * MIN,
      departureObserved: true,
    },
    needsReview: false,
    reviewReasons: [],
  });
});

// Controller addition: `maxGapMin` is a raw ms/60000 quotient and this string
// is rendered to a dispatcher verbatim by a later task, so it must not leak
// float noise into copy a broker may end up reading.
describe("review reason copy", () => {
  it("rounds the gap in the reason string", () => {
    const claim = detentionClaim({
      geocodeOk: true,
      windowStartMs: 0,
      freeMin: 0,
      segment: {
        firstSeenMs: 0,
        lastSeenMs: 4 * 60 * 60_000,
        observedMin: 240,
        pingCount: 30,
        maxGapMin: 187.53333333333333,
        departureObserved: true,
      },
    });
    expect(claim).not.toBeNull();
    expect(claim!.reviewReasons).toContain("evidence has a 188m gap");
    expect(claim!.reviewReasons.join(" ")).not.toMatch(/\d\.\d/);
  });
});

// Controller addition. The rules as written happily produce a ten-hour claim
// from two pings twelve hours apart: the gap reason fires, but it describes
// ONE hole rather than how thin the whole record is. "How do you know?" is
// the first question a broker asks, and pingCount is the answer.
describe("evidence density", () => {
  const longSparse = {
    firstSeenMs: 0,
    lastSeenMs: 12 * 60 * 60_000,
    observedMin: 720,
    pingCount: 2,
    maxGapMin: 720,
    departureObserved: true,
  };

  it("flags a long claim standing on very few pings", () => {
    const claim = detentionClaim({ geocodeOk: true, windowStartMs: 0, freeMin: 120, segment: longSparse });
    expect(claim).not.toBeNull();
    expect(claim!.billableMin).toBeCloseTo(600, 5);
    expect(claim!.needsReview).toBe(true);
    expect(claim!.reviewReasons).toContain("claim rests on only 2 pings over 600m");
  });

  it("does not flag density when the record is dense", () => {
    const claim = detentionClaim({
      geocodeOk: true, windowStartMs: 0, freeMin: 120,
      segment: { ...longSparse, pingCount: 40, maxGapMin: 5 },
    });
    expect(claim).not.toBeNull();
    expect(claim!.reviewReasons).toEqual([]);
    expect(claim!.needsReview).toBe(false);
  });

  it("does not flag density on a short claim", () => {
    // 3h dwell, 2h free -> 60m billable, right at the threshold: two pings is
    // thin but the claim is small, and noise here would train dispatchers to
    // ignore the review flag entirely.
    const claim = detentionClaim({
      geocodeOk: true, windowStartMs: 0, freeMin: 120,
      segment: { ...longSparse, lastSeenMs: 3 * 60 * 60_000, maxGapMin: 5 },
    });
    expect(claim!.reviewReasons).toEqual([]);
  });
});
