import { prisma } from "../../db.js";
import { DEFAULT_HARNESS_CONFIG } from "../aiHarness/config.js";

// Demo Mode: the org-level fixtures the story reuses across resets
// (customer, agent policy, AI experiment, John Carter, the pool tractor and
// trailer). Every id/value here is binding. Everything is idempotent —
// upserted by a stable key — so reset can run any number of times against
// the same org and land on the same rows.

export const DEMO_LOAD_REF = "DEMO-CHI-DET";
export const DEMO_DRIVER_EXTERNAL_ID = "DEMO-JOHN";
export const DEMO_TRACTOR_UNIT = "DEMO-TRK-1";
export const DEMO_TRAILER_UNIT = "DEMO-TRL-1";
export const DEMO_HIST_PREFIX = "DEMO-HIST-";
export const DEMO_CUSTOMER_NAME = "Demo Customer";
export const DEMO_CUSTOMER_EMAIL = "demo-customer@example.invalid";
export const DEMO_POLICY_NAME = "Demo (fast)";
export const DEMO_EXPERIMENT_NAME = "Demo";

export const CHICAGO_PICKUP = { address: "2100 S Western Ave, Chicago, IL 60608", lat: 41.8532, lng: -87.6857 };
export const DETROIT_DELIVERY = { address: "1 Woodward Ave, Detroit, MI 48226", lat: 42.329, lng: -83.045 };

/** The demo driver's email is deterministic from the org id — globally
 *  unique (Driver.email has no per-org scope) without a lookup, and stable
 *  across resets so `prisma.driver.upsert` finds the same row every time. */
export function demoDriverEmail(orgId: string): string {
  return `demo.john.carter@${orgId}.demo.invalid`;
}

export async function upsertCustomer(orgId: string): Promise<{ id: string }> {
  const fields = {
    primaryEmail: DEMO_CUSTOMER_EMAIL,
    requiresDelayNotification: true,
    priority: "high",
  };
  return prisma.customer.upsert({
    where: { orgId_name: { orgId, name: DEMO_CUSTOMER_NAME } },
    update: fields,
    create: { orgId, name: DEMO_CUSTOMER_NAME, ...fields },
  });
}

/** dispatcherEmail is a required AgentPolicy column — the org's first
 *  dispatcher email, oldest first. A demo org always has at least the
 *  dispatcher who is calling Reset; the literal fallback below is defensive
 *  only (an org with zero dispatchers cannot authenticate a request to this
 *  route at all). */
async function firstDispatcherEmail(orgId: string): Promise<string> {
  const dispatcher = await prisma.dispatcher.findFirst({ where: { orgId }, orderBy: { createdAt: "asc" }, select: { email: true } });
  return dispatcher?.email ?? `dispatcher@${orgId}.demo.invalid`;
}

/** `delayMin` is high on purpose. Night Shift's delay rule has two branches:
 *  the live ETA past the delivery window (what the story relies on — see
 *  `recordApproval`), and the truck more than `delayMin` behind a plan line
 *  drawn in wall time. With the simulation fast-forwarding the truck and the
 *  scripted stop freezing it, any behind-plan reading during the demo is an
 *  artifact of the two clocks, not a fact about the road; 120 keeps that
 *  branch quiet. `offRouteMi` is wide for the same kind of reason: the
 *  simulation moves the truck along the great circle between the stops,
 *  5–15 miles off the road Night Shift plans on (and over the lake at
 *  first), so anything narrower would raise an off-route ladder about
 *  geometry, not driving. */
export async function upsertPolicy(orgId: string): Promise<{ id: string }> {
  const dispatcherEmail = await firstDispatcherEmail(orgId);
  const fields = {
    stopMin: 1, delayMin: 120, darkMin: 10, darkAtStopMin: 10,
    offRouteMi: 25, offRouteMin: 10, rungGapMin: 1, maxCalls: 0,
    dispatcherEmail, customerEmailOn: false, shadow: true, bossCallOn: false,
  };
  return prisma.agentPolicy.upsert({
    where: { orgId_name: { orgId, name: DEMO_POLICY_NAME } },
    update: fields,
    create: { orgId, name: DEMO_POLICY_NAME, ...fields },
  });
}

/** AiExperiment carries no `@@unique([orgId, name])` — find-then-write
 *  instead of `upsert`. `config: {}` on purpose (the default config):
 *  `resolveHarnessConfig` fills every field in from `DEFAULT_HARNESS_CONFIG`
 *  at run time, so nothing here needs to restate it. */
export async function upsertExperiment(orgId: string): Promise<{ id: string }> {
  const existing = await prisma.aiExperiment.findFirst({ where: { orgId, name: DEMO_EXPERIMENT_NAME } });
  const fields = { promptVersion: "dispatch-v2", config: {} };
  return existing
    ? prisma.aiExperiment.update({ where: { id: existing.id }, data: fields })
    : prisma.aiExperiment.create({ data: { orgId, name: DEMO_EXPERIMENT_NAME, model: DEFAULT_HARNESS_CONFIG.model, ...fields } });
}

export async function upsertDriver(orgId: string): Promise<{ id: string }> {
  const email = demoDriverEmail(orgId);
  const now = new Date();
  const fields = {
    orgId,
    name: "John Carter",
    externalId: DEMO_DRIVER_EXTERNAL_ID,
    phone: "+15550100001",
    cdlClass: "A",
    equipmentTypes: ["DryVan", "Reefer"],
    languages: ["en"],
    homeBase: "Chicago, IL",
    // 20 mi west of the Chicago pickup — exact coordinates, not derived.
    lastLat: 41.88,
    lastLng: -87.98,
    lastLocationAt: now,
    status: "available",
  };
  const driver = await prisma.driver.upsert({
    where: { email },
    update: fields,
    create: { email, passwordHash: "demo-fixture-no-login", ...fields },
  });

  await prisma.hosState.upsert({
    where: { driverId: driver.id },
    update: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 3600, minutesSinceBreak: 0 },
    create: { driverId: driver.id, driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 3600, minutesSinceBreak: 0 },
  });

  await prisma.driverAvailability.upsert({
    where: { driverId: driver.id },
    update: { acceptingLoads: true, availabilityStatus: "AVAILABLE", locationSharingEnabled: true, source: "manual" },
    create: { driverId: driver.id, acceptingLoads: true, availabilityStatus: "AVAILABLE", locationSharingEnabled: true, source: "manual" },
  });

  // A preference row that agrees with the load, so the candidate context the
  // AI reads (`candidateContext.ts`) shows a driver who wants exactly this
  // kind of run — nothing avoided, the load's own equipment preferred.
  const preference = {
    maxTripMiles: null, preferredRegions: ["Midwest"], preferredLanes: [], avoidRegions: [], avoidLanes: [],
    homeTimeTarget: null, willingToDriveNight: true, willingToRelocateMiles: null, preferredEquipment: ["DryVan", "Reefer"],
  };
  await prisma.driverPreference.upsert({
    where: { driverId: driver.id },
    update: preference,
    create: { driverId: driver.id, ...preference },
  });

  return driver;
}

/** Tractor/Trailer carry no unique constraint on `unit` — find-then-write,
 *  same reasoning as `upsertExperiment`. */
export async function upsertEquipment(orgId: string): Promise<{ tractorId: string; trailerId: string }> {
  const existingTractor = await prisma.tractor.findFirst({ where: { orgId, unit: DEMO_TRACTOR_UNIT } });
  const tractor = existingTractor
    ? await prisma.tractor.update({ where: { id: existingTractor.id }, data: { status: "active" } })
    : await prisma.tractor.create({ data: { orgId, unit: DEMO_TRACTOR_UNIT, status: "active" } });

  const existingTrailer = await prisma.trailer.findFirst({ where: { orgId, unit: DEMO_TRAILER_UNIT } });
  const trailer = existingTrailer
    ? await prisma.trailer.update({ where: { id: existingTrailer.id }, data: { status: "active", type: "DryVan" } })
    : await prisma.trailer.create({ data: { orgId, unit: DEMO_TRAILER_UNIT, type: "DryVan", status: "active" } });

  return { tractorId: tractor.id, trailerId: trailer.id };
}
