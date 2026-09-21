// How much diesel a plan burns. Pure arithmetic over miles and the carrier's
// own mpg — no price, no state, no I/O. Price lives in FuelPrice and is a
// separate question deliberately (Global Constraint 5).

export interface FuelBurn {
  deadheadGal: number;
  loadedGal: number;
  totalGal: number;
  /** null when mpg is unusable. Callers must render unknown, never 0 gal. */
  mpgUsed: number | null;
}

export function fuelBurn(plan: { deadheadMi: number; loadedMi: number }, mpg: number): FuelBurn {
  // An unusable mpg divides into Infinity and would render as a confident,
  // enormous fuel bill. Refuse to answer instead.
  if (!Number.isFinite(mpg) || mpg <= 0) {
    return { deadheadGal: 0, loadedGal: 0, totalGal: 0, mpgUsed: null };
  }
  const deadheadGal = plan.deadheadMi / mpg;
  const loadedGal = plan.loadedMi / mpg;
  return { deadheadGal, loadedGal, totalGal: deadheadGal + loadedGal, mpgUsed: mpg };
}
