import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { buildRoadMilesFn, routeKey } from "../src/lib/routing.js";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import type { DriverInput, LoadInput, TractorInput, TrailerInput } from "../src/domain/dispatch/types.js";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.ROUTER_URL;
  vi.unstubAllGlobals();
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };

// OSRM answers in meters/seconds.
function stubOsrm(distanceMeters: number, calls: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({ routes: [{ distance: distanceMeters, duration: 7200 }] }),
    };
  }));
  return calls;
}

it("returns a constant-null lookup when no ROUTER_URL is configured", async () => {
  const fn = await buildRoadMilesFn([[KC, OMAHA]]);
  expect(fn(KC, OMAHA)).toBeNull();
});

it("fetches provider miles once and serves repeats from the Postgres cache", async () => {
  process.env.ROUTER_URL = "http://osrm.local";
  const calls = stubOsrm(321_869); // ~200 miles

  const fn = await buildRoadMilesFn([[KC, OMAHA], [KC, OMAHA]]);
  expect(fn(KC, OMAHA)).toBeCloseTo(200, 0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/route/v1/driving/-94.5786,39.0997;-95.9345,41.2565");

  const cached = await prisma.routeDistance.findUnique({ where: { key: routeKey(KC, OMAHA) } });
  expect(cached?.miles).toBeCloseTo(200, 0);

  // A fresh build resolves from the cache — the provider is not called again.
  const fn2 = await buildRoadMilesFn([[KC, OMAHA]]);
  expect(fn2(KC, OMAHA)).toBeCloseTo(200, 0);
  expect(calls).toHaveLength(1);
});

it("provider failure degrades that pair to null (engine falls back to haversine)", async () => {
  process.env.ROUTER_URL = "http://osrm.local";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  const fn = await buildRoadMilesFn([[KC, OMAHA]]);
  expect(fn(KC, OMAHA)).toBeNull();
});

it("evaluate uses provider miles for the legs it was given", () => {
  const load: LoadInput = {
    requiredEquip: "DryVan", hazmatClass: null, revenueCents: 30000,
    stops: [
      { sequence: 1, type: "pickup", location: KC, windowStart: null, windowEnd: null, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: OMAHA, windowStart: null, windowEnd: null, dwellMin: 60 },
    ],
  };
  const driver: DriverInput = {
    status: "active", hazmatEndorsed: true, location: KC, availableAt: Date.UTC(2026, 7, 21, 12, 0),
    hos: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 },
  };
  const tractor: TractorInput = { status: "active" };
  const trailer: TrailerInput = { type: "DryVan", status: "active" };

  const withProvider = evaluate(load, driver, tractor, trailer, {
    roadMilesFn: (a, b) => (a === KC || (a.lat === KC.lat && b.lat === OMAHA.lat) ? 250 : null),
  });
  expect(withProvider.plan.loadedMi).toBe(250);

  const withoutProvider = evaluate(load, driver, tractor, trailer, {});
  // haversine × 1.2 for KC->Omaha is ~190 mi — clearly different from 250.
  expect(withoutProvider.plan.loadedMi).toBeGreaterThan(150);
  expect(withoutProvider.plan.loadedMi).toBeLessThan(220);
});
