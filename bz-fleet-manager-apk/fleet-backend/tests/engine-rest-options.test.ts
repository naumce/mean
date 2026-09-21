import { describe, expect, it } from "vitest";
import {
  rankRestOptions,
  REST_SEARCH_RADIUS_MI,
  type RestCandidate,
} from "../src/domain/dispatch/restOptions.js";
import { haversineMi } from "../src/domain/dispatch/distance.js";
import { interpolate } from "../src/domain/dispatch/breakGeo.js";

const KC = { lat: 39.0997, lng: -94.5786 };
const MEM = { lat: 35.1495, lng: -90.049 };

function candidate(overrides: Partial<RestCandidate> & Pick<RestCandidate, "id" | "lat" | "lng">): RestCandidate {
  return {
    name: overrides.id,
    kind: "truck_stop",
    spaces: 10,
    ...overrides,
  };
}

describe("rankRestOptions", () => {
  it("excludes a candidate outside the default 35 mi radius", () => {
    // ~13.8 mi south of KC: well inside the default radius.
    const near = candidate({ id: "near", lat: KC.lat - 0.2, lng: KC.lng });
    // ~207 mi south of KC: nowhere close to reachable from a break point.
    const far = candidate({ id: "far", lat: KC.lat + 3, lng: KC.lng });

    const result = rankRestOptions(KC, MEM, [near, far]);

    expect(result.map((o) => o.id)).toEqual(["near"]);
    expect(result.find((o) => o.id === "far")).toBeUndefined();
  });

  it("ranks a stop ahead on the leg before one behind, when both are equally off-route", () => {
    // Both `ahead` and `behind` sit on the KC-MEM great circle itself,
    // offset from `point` by the same angular fraction in opposite
    // directions, so their offRouteMi (distance from `point`) is
    // effectively identical. `ahead` is closer to legEnd, so it costs
    // far less detour than `behind`, which the driver would have to
    // backtrack to reach.
    const point = interpolate(KC, MEM, 0.3);
    const aheadPos = interpolate(KC, MEM, 0.32);
    const behindPos = interpolate(KC, MEM, 0.28);

    const ahead = candidate({ id: "ahead", lat: aheadPos.lat, lng: aheadPos.lng });
    const behind = candidate({ id: "behind", lat: behindPos.lat, lng: behindPos.lng });

    // Sanity check the fixture: the two candidates really are equally
    // off-route from `point`, to within floating-point noise.
    const offAhead = haversineMi(point, aheadPos);
    const offBehind = haversineMi(point, behindPos);
    expect(Math.abs(offAhead - offBehind)).toBeLessThan(1e-6);

    const result = rankRestOptions(point, MEM, [behind, ahead]);

    expect(result.map((o) => o.id)).toEqual(["ahead", "behind"]);
    expect(result[0].detourMi).toBeLessThan(result[1].detourMi);
  });

  it("computes detourMi as dist(point,stop) + dist(stop,legEnd) - dist(point,legEnd)", () => {
    const stop = candidate({ id: "stop", lat: 38.75, lng: -94.2 });

    const [option] = rankRestOptions(KC, MEM, [stop]);

    const expected =
      haversineMi(KC, { lat: stop.lat, lng: stop.lng }) +
      haversineMi({ lat: stop.lat, lng: stop.lng }, MEM) -
      haversineMi(KC, MEM);

    expect(option.offRouteMi).toBeCloseTo(haversineMi(KC, { lat: stop.lat, lng: stop.lng }), 9);
    expect(option.detourMi).toBeCloseTo(expected, 9);
  });

  it("never returns a negative detourMi, even for a near-collinear stop", () => {
    // `point` sits 95% of the way from KC to MEM, and the stop is placed
    // by great-circle interpolation exactly halfway between `point` and
    // MEM — i.e. genuinely ON the straight line connecting them, not
    // merely "close to" it. So offRouteMi + dist(stop,legEnd) - straight
    // should mathematically be exactly 0, but per the brief actually
    // lands a hair on the negative side from float error (confirmed by
    // probing the raw arithmetic below, before the clamp is applied).
    // The candidate also has to land within the default 35 mi radius
    // (~9.2 mi here) so it isn't filtered out before detourMi is even
    // inspected. The clamp is what keeps the negative raw value from
    // surfacing as a "negative detour".
    const point = interpolate(KC, MEM, 0.95);
    const stopPos = interpolate(point, MEM, 0.5);
    const raw =
      haversineMi(point, stopPos) + haversineMi(stopPos, MEM) - haversineMi(point, MEM);
    // Confirms this fixture actually exercises the negative branch;
    // if this ever stops being true, pick different fractions.
    expect(raw).toBeLessThan(0);
    expect(haversineMi(point, stopPos)).toBeLessThanOrEqual(REST_SEARCH_RADIUS_MI);

    const stop = candidate({ id: "collinear", lat: stopPos.lat, lng: stopPos.lng });
    const [option] = rankRestOptions(point, MEM, [stop]);

    expect(option).toBeDefined();
    expect(option.detourMi).toBe(0);
    expect(option.detourMi).toBeGreaterThanOrEqual(0);
  });

  it("passes spaces: null through unchanged, never coerced to 0", () => {
    const stop = candidate({ id: "unknown-capacity", lat: KC.lat - 0.1, lng: KC.lng, spaces: null });

    const [option] = rankRestOptions(KC, MEM, [stop]);

    expect(option.spaces).toBeNull();
  });

  it("returns [] for an empty candidate list, not an error", () => {
    expect(rankRestOptions(KC, MEM, [])).toEqual([]);
  });

  it("REST_SEARCH_RADIUS_MI is the documented default of 35 miles", () => {
    expect(REST_SEARCH_RADIUS_MI).toBe(35);
  });
});
