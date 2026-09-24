import { prisma } from "../../db.js";
import type { Prisma } from "@prisma/client";
import { availabilityFor, type AvailabilityStatus, type DriverAvailabilityView } from "../driverAvailability.js";
import { driverMetrics, type DriverMetrics } from "../driverMetrics.js";
import { driverHistory, type DriverHistoryRow } from "../driverHistory.js";
import { clampLimit, MAX_LIST_LIMIT } from "./limit.js";

// dispatchTools/drivers.ts (AI Dispatch Foundation, Task 5): read-only driver
// lookups. Every availability-aware function here calls lib/driverAvailability.ts's
// availabilityFor EXACTLY ONCE (never once per driver) and filters/sorts the
// resulting batch in memory — the same discipline driverMetricsBatch already
// uses for its own batch queries.

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 50;

const DRIVER_PROFILE_SELECT = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  status: true,
  orgId: true,
  cdlClass: true,
  hazmatEndorsed: true,
  endorsements: true,
  equipmentTypes: true,
  languages: true,
  preferredLanguage: true,
  homeBaseCity: true,
  homeBaseState: true,
  yearsExperience: true,
  timezone: true,
  lastLat: true,
  lastLng: true,
  lastLocationAt: true,
  hos: true,
} satisfies Prisma.DriverSelect;

type DriverProfileRow = Prisma.DriverGetPayload<{ select: typeof DRIVER_PROFILE_SELECT }>;

export interface DriverProfile extends DriverProfileRow {
  availability: DriverAvailabilityView | null;
}

function withAvailability(driver: DriverProfileRow, view: DriverAvailabilityView | undefined): DriverProfile {
  return { ...driver, availability: view ?? null };
}

/** True when `driverId` exists and belongs to `orgId` — the existence/tenant
 *  check every :id-taking function below runs before doing anything else,
 *  since none of the functions it guards (availabilityFor, driverMetrics,
 *  driverHistory, DriverLocation) has any concept of "missing driver" on its
 *  own; each would just report an empty/zeroed result for a nonexistent id. */
async function driverInOrg(orgId: string, driverId: string): Promise<boolean> {
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { orgId: true } });
  return driver != null && driver.orgId === orgId;
}

/** One driver's profile + current availability, no performance metrics; null
 *  when the driver does not exist or belongs to another org. */
export async function getDriver(orgId: string, driverId: string): Promise<DriverProfile | null> {
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: DRIVER_PROFILE_SELECT });
  if (!driver || driver.orgId !== orgId) return null;
  const [view] = await availabilityFor(orgId, [driverId]);
  return withAvailability(driver, view);
}

export interface SearchDriversOptions {
  status?: AvailabilityStatus;
  equipment?: string;
  language?: string;
  state?: string;
  acceptingLoads?: boolean;
  limit?: number;
}

/** Drivers matching the given filters. `equipment`/`language`/`state` are
 *  pushed down to the database (`equipmentTypes has`, `languages has` OR
 *  `preferredLanguage`, `homeBaseState`); `status`/`acceptingLoads` are
 *  availability facts, checked against ONE batched `availabilityFor` call
 *  scoped to the already-narrowed candidate set. */
export async function searchDrivers(orgId: string, options: SearchDriversOptions = {}): Promise<DriverProfile[]> {
  const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const drivers = await prisma.driver.findMany({
    where: {
      orgId,
      ...(options.equipment ? { equipmentTypes: { has: options.equipment } } : {}),
      ...(options.state ? { homeBaseState: options.state } : {}),
      ...(options.language
        ? { OR: [{ languages: { has: options.language } }, { preferredLanguage: options.language }] }
        : {}),
    },
    select: DRIVER_PROFILE_SELECT,
  });

  const views = await availabilityFor(orgId, drivers.map((d) => d.id));
  const viewByDriver = new Map(views.map((v) => [v.driverId, v]));

  const filtered = drivers
    .map((d) => withAvailability(d, viewByDriver.get(d.id)))
    .filter((d) => {
      if (options.status && d.availability?.status !== options.status) return false;
      if (options.acceptingLoads != null && d.availability?.acceptingLoads !== options.acceptingLoads) return false;
      return true;
    });

  return filtered.slice(0, limit);
}

/** Org drivers currently AVAILABLE or AVAILABLE_SOON and accepting loads,
 *  soonest-available first — exactly `availabilityFor`'s own view, filtered
 *  and sorted, never a second profile-joining query. */
export async function getAvailableDrivers(orgId: string): Promise<DriverAvailabilityView[]> {
  const views = await availabilityFor(orgId);
  return views
    .filter((v) => (v.status === "AVAILABLE" || v.status === "AVAILABLE_SOON") && v.acceptingLoads)
    .sort((a, b) => a.availableAt - b.availableAt);
}

/** One driver's current availability view; null when the driver does not
 *  exist or belongs to another org. */
export async function getDriverAvailability(orgId: string, driverId: string): Promise<DriverAvailabilityView | null> {
  if (!(await driverInOrg(orgId, driverId))) return null;
  const [view] = await availabilityFor(orgId, [driverId]);
  return view ?? null;
}

/** One driver's evidence-derived metrics (Task 4); null when the driver does
 *  not exist or belongs to another org — driverMetrics itself always
 *  succeeds, reporting zero evidence for an unknown id, so the existence
 *  check has to happen here instead. */
export async function getDriverMetrics(orgId: string, driverId: string): Promise<DriverMetrics | null> {
  if (!(await driverInOrg(orgId, driverId))) return null;
  return driverMetrics(orgId, driverId);
}

/** One driver's completed-assignment history, newest first; null when the
 *  driver does not exist or belongs to another org (see getDriverMetrics
 *  above for why the check is repeated at this boundary). */
export async function getDriverHistory(
  orgId: string,
  driverId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<DriverHistoryRow[] | null> {
  if (!(await driverInOrg(orgId, driverId))) return null;
  return driverHistory(orgId, driverId, clampLimit(limit, DEFAULT_HISTORY_LIMIT, MAX_LIST_LIMIT));
}

export interface LocationPoint {
  lat: number;
  lng: number;
  atMs: number;
}

/** Raw location pings for one driver since `sinceMs`, ascending; null when
 *  the driver does not exist or belongs to another org. DriverLocation has no
 *  FK to Driver (schema), so the org check has to run against Driver FIRST,
 *  before this ever filters DriverLocation by driverId alone. */
export async function getDriverLocationHistory(
  orgId: string,
  driverId: string,
  sinceMs: number,
): Promise<LocationPoint[] | null> {
  if (!(await driverInOrg(orgId, driverId))) return null;
  const rows = await prisma.driverLocation.findMany({
    where: { driverId, createdAt: { gte: new Date(sinceMs) } },
    orderBy: { createdAt: "asc" },
    select: { latitude: true, longitude: true, createdAt: true },
  });
  return rows.map((r) => ({ lat: r.latitude, lng: r.longitude, atMs: r.createdAt.getTime() }));
}
