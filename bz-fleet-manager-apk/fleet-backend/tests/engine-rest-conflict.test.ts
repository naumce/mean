import { describe, expect, it } from "vitest";
import { restConflict } from "../src/domain/dispatch/restConflict.js";
import { REST_SEARCH_RADIUS_MI, type RestOption } from "../src/domain/dispatch/restOptions.js";
import type { BreakPoint } from "../src/domain/dispatch/types.js";

describe("restConflict", () => {
  const bp: BreakPoint = {
    atMs: 0,
    afterDriveMin: 480,
    legIndex: 0,
    fraction: 0.5,
    at: { lat: 38.6, lng: -92.1 },
    precision: "estimated",
  };

  const opt: RestOption = {
    id: "rs-1",
    name: "Sample Rest Stop",
    kind: "truck_stop",
    lat: 38.6,
    lng: -92.1,
    spaces: 10,
    detourMi: 1,
    offRouteMi: 1,
  };

  it("blocks when the corridor is covered and nothing is reachable", () => {
    const c = restConflict(bp, { hasData: true, options: [] });
    expect(c?.severity).toBe("block");
    expect(c?.kind).toBe("no_rest");
    expect(c?.detail).toMatch(/no rest option within 35 mi/i);
  });

  it("is SILENT when the org has no rest data in the corridor", () => {
    // The defect this test exists to prevent: refusing a legal plan because a
    // customer has not imported a POI file. Absence is not unavailability.
    expect(restConflict(bp, { hasData: false, options: [] })).toBeNull();
  });

  it("is silent when options exist", () => {
    expect(restConflict(bp, { hasData: true, options: [opt] })).toBeNull();
  });

  it("states WHERE the break falls, not just that it does", () => {
    // The dispatcher needs the location to act on the refusal.
    expect(restConflict(bp, { hasData: true, options: [] })?.detail).toMatch(/38\.6/);
  });

  it("labels an estimated break point as approximate", () => {
    expect(restConflict(bp, { hasData: true, options: [] })?.detail).toContain("≈");
    const routed = restConflict({ ...bp, precision: "routed" }, { hasData: true, options: [] });
    expect(routed?.detail).not.toContain("≈");
  });

  it("cannot fire for a break with no position", () => {
    expect(restConflict({ ...bp, at: null }, { hasData: true, options: [] })).toBeNull();
  });

  it("quotes the same radius the ranker filtered on", () => {
    const c = restConflict(bp, { hasData: true, options: [] });
    expect(c?.detail).toContain(`${REST_SEARCH_RADIUS_MI} mi`);
  });
});
