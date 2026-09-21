import { computeEconomics, DEFAULT_RATE_CONFIG } from "../src/domain/dispatch/economics.js";

it("computes cost components from total miles and the rate config", () => {
  // totalMi = 200; fuel = 200/6.5*400 = 12308; pay = 200*60 = 12000; fixed = 200*45 = 9000
  const r = computeEconomics({ revenueCents: 40000, deadheadMi: 40, loadedMi: 160 });
  expect(r.totalMi).toBe(200);
  expect(r.fuelCostCents).toBe(Math.round((200 / 6.5) * 400));
  expect(r.driverPayCents).toBe(12000);
  expect(r.fixedCostCents).toBe(9000);
  expect(r.estCostCents).toBe(r.fuelCostCents + r.driverPayCents + r.fixedCostCents);
  expect(r.marginCents).toBe(40000 - r.estCostCents);
});

it("expresses margin as a fraction of revenue", () => {
  const r = computeEconomics({ revenueCents: 100000, deadheadMi: 0, loadedMi: 100 });
  expect(r.marginPct).toBeCloseTo(r.marginCents / 100000, 9);
  expect(r.marginPct).toBeGreaterThan(0);
});

it("can produce a negative margin on a deadhead-heavy short haul", () => {
  const r = computeEconomics({ revenueCents: 20000, deadheadMi: 150, loadedMi: 60 });
  expect(r.marginCents).toBeLessThan(0);
  expect(r.marginPct).toBeLessThan(0);
});

it("rate per loaded mile excludes deadhead; rate per total mile includes it", () => {
  const r = computeEconomics({ revenueCents: 33200, deadheadMi: 30, loadedMi: 130 });
  expect(r.ratePerLoadedMiCents).toBe(Math.round(33200 / 130));
  expect(r.ratePerTotalMiCents).toBe(Math.round(33200 / 160));
  expect(r.ratePerLoadedMiCents).toBeGreaterThan(r.ratePerTotalMiCents);
});

it("guards divide-by-zero on empty miles and zero revenue", () => {
  const r = computeEconomics({ revenueCents: 0, deadheadMi: 0, loadedMi: 0 });
  expect(r.ratePerLoadedMiCents).toBe(0);
  expect(r.ratePerTotalMiCents).toBe(0);
  expect(r.marginPct).toBe(0);
});

it("honors an overridden rate config", () => {
  const cheap = { ...DEFAULT_RATE_CONFIG, dieselCentsPerGal: 200 };
  const base = computeEconomics({ revenueCents: 40000, deadheadMi: 40, loadedMi: 160 });
  const withCheapFuel = computeEconomics({ revenueCents: 40000, deadheadMi: 40, loadedMi: 160 }, cheap);
  expect(withCheapFuel.fuelCostCents).toBeLessThan(base.fuelCostCents);
  expect(withCheapFuel.marginCents).toBeGreaterThan(base.marginCents);
});

it("rejects a non-positive mpg", () => {
  expect(() => computeEconomics({ revenueCents: 1, deadheadMi: 1, loadedMi: 1 }, { ...DEFAULT_RATE_CONFIG, mpg: 0 })).toThrow();
});
