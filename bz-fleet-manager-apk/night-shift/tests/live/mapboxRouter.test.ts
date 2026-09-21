import { describe, expect, it } from "vitest";
import { MapboxRouter } from "../../src/live/mapboxRouter.js";

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const opts = { equipment: "DryVan", departAtMs: Date.now() };

describe("MapboxRouter", () => {
  it("turns the provider's answer into a RouteAnswer, miles and minutes from the same response", async () => {
    // The key the adapter looks up is the platform's own routeKey; the fake
    // answers under exactly that key.
    const resolve = async (pairs: [unknown, unknown][]) => {
      const { routeKey } = await import("../../../fleet-backend/src/lib/routing.js");
      const { truckProfileFor } = await import("../../../fleet-backend/src/lib/truckProfile.js");
      const [a, b] = pairs[0] as [{ lat: number; lng: number }, { lat: number; lng: number }];
      return new Map([[routeKey(a, b, truckProfileFor({ trailerType: "DryVan" })), { miles: 193.4, minutes: 181, geometry: [[-94.58, 39.1], [-94.1, 40.0], [-93.62, 41.59]] as [number, number][], source: "mapbox" }]]);
    };
    const r = await new MapboxRouter(resolve as never).route(KC, DSM, opts);
    expect(r.distanceMi).toBe(193.4);
    expect(r.driveMin).toBe(181);
    expect(r.geometry).toHaveLength(3);
  });

  it("refuses to hand the core a route with no geometry — a plan line needs a line", async () => {
    const resolve = async () => new Map();
    await expect(new MapboxRouter(resolve as never).route(KC, DSM, opts)).rejects.toThrow(/no truck-legal route/);
  });

  const live = process.env.MAPBOX_TOKEN ? it : it.skip;
  if (!process.env.MAPBOX_TOKEN) console.warn("mapboxRouter.test: MAPBOX_TOKEN not set — live route skipped");
  live("routes Kansas City to Des Moines on real road (live, one cached request)", async () => {
    const r = await new MapboxRouter().route(KC, DSM, opts);
    expect(r.distanceMi).toBeGreaterThan(180);
    expect(r.distanceMi).toBeLessThan(215);
    expect(r.geometry.length).toBeGreaterThan(100);
  }, 20_000);
});
