import { suggest, type Candidate } from "../src/domain/dispatch/suggest.js";
import type { DriverInput, LoadInput } from "../src/domain/dispatch/types.js";

const H = 3_600_000;
const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const DES_MOINES = { lat: 41.5868, lng: -93.625 };

const load: LoadInput = {
  requiredEquip: "Reefer",
  hazmatClass: null,
  revenueCents: 60000,
  stops: [
    { sequence: 1, type: "pickup", location: KC, windowEnd: 100 * H, dwellMin: 60 },
    { sequence: 2, type: "delivery", location: OMAHA, windowEnd: 100 * H, dwellMin: 60 },
  ],
};

const fresh = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

const driver = (over: Partial<DriverInput> = {}): DriverInput => ({
  status: "active",
  hazmatEndorsed: false,
  availableAt: 0,
  location: KC,
  hos: fresh,
  ...over,
});

const reefer = { type: "Reefer" as const, status: "active" as const };
const tractor = { status: "active" as const };

it("ranks the nearer feasible driver above the farther one", () => {
  const candidates: Candidate[] = [
    { driverId: "far", driver: driver({ location: DES_MOINES }), tractor, trailer: reefer }, // big deadhead
    { driverId: "near", driver: driver({ location: KC }), tractor, trailer: reefer }, // ~0 deadhead
  ];
  const rows = suggest(load, candidates);
  expect(rows[0].driverId).toBe("near");
  expect(rows[0].score!).toBeGreaterThan(rows[1].score!);
  expect(rows.every((r) => typeof r.score === "number")).toBe(true);
});

it("places infeasible drivers last with a blocking reason, never hidden", () => {
  const candidates: Candidate[] = [
    { driverId: "good", driver: driver(), tractor, trailer: reefer },
    { driverId: "wrongEquip", driver: driver(), tractor, trailer: { type: "DryVan", status: "active" } },
    { driverId: "noHours", driver: driver({ hos: { ...fresh, driveRemainingMin: 30 } }), tractor, trailer: reefer },
  ];
  const rows = suggest(load, candidates);
  expect(rows[0].driverId).toBe("good");
  expect(rows[0].feasible).toBe(true);
  const infeasible = rows.filter((r) => !r.feasible);
  expect(infeasible).toHaveLength(2);
  expect(infeasible.every((r) => r.score === null)).toBe(true);
  expect(infeasible.every((r) => typeof r.blockedReason === "string" && r.blockedReason.length > 0)).toBe(true);
});

it("scores each feasible row 0..100 and carries economics", () => {
  const rows = suggest(load, [{ driverId: "d1", driver: driver(), tractor, trailer: reefer }]);
  expect(rows[0].score).toBeGreaterThanOrEqual(0);
  expect(rows[0].score).toBeLessThanOrEqual(100);
  expect(typeof rows[0].marginCents).toBe("number");
  expect(rows[0].etaMs).toBeGreaterThan(0);
});

it("surfaces warnings (tight arrival) without making the row infeasible", () => {
  const tight: LoadInput = {
    ...load,
    stops: [
      { sequence: 1, type: "pickup", location: KC, windowEnd: 100 * H, dwellMin: 60 },
      { sequence: 2, type: "delivery", location: OMAHA, windowEnd: 5.2 * H, dwellMin: 60 }, // arrives ~4h59m
    ],
  };
  const rows = suggest(tight, [{ driverId: "d1", driver: driver(), tractor, trailer: reefer }]);
  expect(rows[0].feasible).toBe(true);
  expect(rows[0].warnings.length).toBeGreaterThan(0);
});

it("respects custom weights (deadhead-only weighting favors the closest)", () => {
  const candidates: Candidate[] = [
    { driverId: "near", driver: driver({ location: KC }), tractor, trailer: reefer },
    { driverId: "far", driver: driver({ location: DES_MOINES }), tractor, trailer: reefer },
  ];
  const weights = { margin: 0, deadhead: 1, hos: 0, appt: 0, hometime: 0, lane: 0 };
  const rows = suggest(load, candidates, { weights });
  expect(rows[0].driverId).toBe("near");
  expect(rows[0].score).toBe(100); // ~0 deadhead -> full deadhead score -> 100
});
