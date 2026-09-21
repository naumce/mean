// Load economics (Control Tower §4D). Pure; integer cents everywhere (never
// float money). Distances are float miles. The rate config is per-fleet/driver
// and overridable; defaults are sane US-trucking planning numbers.

export interface RateConfig {
  /** miles per gallon; default 6.5 */
  mpg: number;
  /** diesel price in cents per gallon; from a daily feed. default 400 (~$4.00) */
  dieselCentsPerGal: number;
  /** driver pay in cents per total mile; default 60 (~$0.60) */
  driverPayCentsPerMi: number;
  /** allocated maintenance+insurance+overhead in cents per total mile; default 45 */
  fixedCentsPerMi: number;
}

export const DEFAULT_RATE_CONFIG: RateConfig = {
  mpg: 6.5,
  dieselCentsPerGal: 400,
  driverPayCentsPerMi: 60,
  fixedCentsPerMi: 45,
};

export interface RateBreakdown {
  revenueCents: number;
  deadheadMi: number;
  loadedMi: number;
  totalMi: number;
  fuelCostCents: number;
  driverPayCents: number;
  fixedCostCents: number;
  estCostCents: number;
  marginCents: number;
  /** margin as a fraction of revenue (0..1); 0 when revenue is 0 */
  marginPct: number;
  /** revenue per loaded mile, cents; 0 when loadedMi is 0 */
  ratePerLoadedMiCents: number;
  /** revenue per total (loaded + deadhead) mile, cents; 0 when totalMi is 0 */
  ratePerTotalMiCents: number;
}

/**
 * Compute the full economics of running a load with a given deadhead.
 * Revenue in, cost + margin out — the numbers behind the drop modal and the
 * ⚡Suggest score.
 */
export function computeEconomics(
  input: { revenueCents: number; deadheadMi: number; loadedMi: number },
  config: RateConfig = DEFAULT_RATE_CONFIG,
): RateBreakdown {
  if (config.mpg <= 0) throw new Error("mpg must be positive");
  const deadheadMi = Math.max(0, input.deadheadMi);
  const loadedMi = Math.max(0, input.loadedMi);
  const totalMi = deadheadMi + loadedMi;
  const revenueCents = Math.round(input.revenueCents);

  const fuelCostCents = Math.round((totalMi / config.mpg) * config.dieselCentsPerGal);
  const driverPayCents = Math.round(totalMi * config.driverPayCentsPerMi);
  const fixedCostCents = Math.round(totalMi * config.fixedCentsPerMi);
  const estCostCents = fuelCostCents + driverPayCents + fixedCostCents;

  const marginCents = revenueCents - estCostCents;
  const marginPct = revenueCents > 0 ? marginCents / revenueCents : 0;
  const ratePerLoadedMiCents = loadedMi > 0 ? Math.round(revenueCents / loadedMi) : 0;
  const ratePerTotalMiCents = totalMi > 0 ? Math.round(revenueCents / totalMi) : 0;

  return {
    revenueCents,
    deadheadMi,
    loadedMi,
    totalMi,
    fuelCostCents,
    driverPayCents,
    fixedCostCents,
    estCostCents,
    marginCents,
    marginPct,
    ratePerLoadedMiCents,
    ratePerTotalMiCents,
  };
}
