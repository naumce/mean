import { prisma } from "../db.js";
import { DEFAULT_RATE_CONFIG, type RateConfig } from "../domain/dispatch/economics.js";

// The org's cost model, shaped exactly like the pure domain's RateConfig so
// it drops straight into computeEconomics/suggest. Orgless dispatchers (and
// unknown ids) price with the planning defaults — same behavior as before the
// cost model became configurable.
//
// orgRateConfig(orgId) — one shared RateConfig for a whole org, no driver in
// hand — existed here through T1 Task 3 for dispatcherSuggest.ts's ranking.
// Removed in Task 3b: rankOrgDrivers now resolves each candidate driver's OWN
// carrier via rateConfigsForDrivers below, which was its last caller. Its
// last remaining reason to exist (a rollup with no single driver) belongs to
// resolveRateConfig(org, null) directly, e.g. as used by
// dispatcherSettlements.ts before it moved to per-driver pricing too.

const RATE_FIELD_SELECT = {
  mpg: true,
  dieselCentsPerGal: true,
  driverPayCentsPerMi: true,
  fixedCentsPerMi: true,
} as const;

/** Same four fields as RateConfig, but nullable — a carrier's cost model,
 *  where null on any field means "inherit the org's value". Shaped this way
 *  (rather than reusing RateConfig) so the compiler forces every call site to
 *  reckon with the possibility of an unset field instead of assuming a number. */
export interface RateSource {
  mpg: number | null;
  dieselCentsPerGal: number | null;
  driverPayCentsPerMi: number | null;
  fixedCentsPerMi: number | null;
}

/** The ONE place carrier-vs-org cost resolution is decided.
 *
 *  Field by field, `??` not `||`: a carrier that genuinely charges 0 for a
 *  component means 0, and `||` would silently substitute the org's value.
 *  All-or-nothing override was the other tempting shape and is wrong — a
 *  carrier that has set only its driver pay must still inherit fuel and
 *  overhead, not price them at zero. */
export function resolveRateConfig(org: RateConfig | null, carrier: RateSource | null): RateConfig {
  const base = org ?? DEFAULT_RATE_CONFIG;
  if (!carrier) return base;
  return {
    mpg: carrier.mpg ?? base.mpg,
    dieselCentsPerGal: carrier.dieselCentsPerGal ?? base.dieselCentsPerGal,
    driverPayCentsPerMi: carrier.driverPayCentsPerMi ?? base.driverPayCentsPerMi,
    fixedCentsPerMi: carrier.fixedCentsPerMi ?? base.fixedCentsPerMi,
  };
}

/** The cost model to price a specific driver's work with: the driver's
 *  carrier (if any) falling back field-by-field to the driver's org, falling
 *  back to planning defaults. One query, then delegates to resolveRateConfig
 *  so the fallback rule itself is never duplicated at a call site. An unknown
 *  driver id (or a driver with neither org nor carrier) prices with the
 *  planning defaults — resolveRateConfig(null, null) falls through to
 *  DEFAULT_RATE_CONFIG, so this "never blocks on missing config" the same way
 *  every other resolver here does. */
export async function rateConfigForDriver(driverId: string): Promise<RateConfig> {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { org: { select: RATE_FIELD_SELECT }, carrier: { select: RATE_FIELD_SELECT } },
  });
  return resolveRateConfig(driver?.org ?? null, driver?.carrier ?? null);
}

/** Same resolution as rateConfigForDriver, batched: one query for N drivers
 *  instead of N — built for rollups that price a whole page of drivers at
 *  once (e.g. /dispatcher/settlements) and would otherwise N+1 per row. A
 *  driver id with no matching row is simply absent from the returned map;
 *  callers fall back to DEFAULT_RATE_CONFIG the same way rateConfigForDriver
 *  does for an unknown id. */
export async function rateConfigsForDrivers(driverIds: readonly string[]): Promise<Map<string, RateConfig>> {
  if (driverIds.length === 0) return new Map();
  const rows = await prisma.driver.findMany({
    where: { id: { in: [...driverIds] } },
    select: { id: true, org: { select: RATE_FIELD_SELECT }, carrier: { select: RATE_FIELD_SELECT } },
  });
  return new Map(rows.map((d) => [d.id, resolveRateConfig(d.org ?? null, d.carrier ?? null)]));
}

/** All-in operating cost per mile for a config, integer cents. */
export function allInCentsPerMi(config: RateConfig): number {
  return Math.round(config.dieselCentsPerGal / config.mpg + config.driverPayCentsPerMi + config.fixedCentsPerMi);
}
