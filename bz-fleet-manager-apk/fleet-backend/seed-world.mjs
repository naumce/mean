// Deterministic demo world (AI Dispatch Foundation, Task 7): a dedicated org
// ("Great Lakes Freight Co") with ~150 drivers, 20 customers, ~3,000
// historical loads, 200-250 current ones, and 14 named scenarios (A-N) that
// the loadboard, Task 4's driver metrics, and Task 6's candidate context all
// make visible.
//
// Usage: node seed-world.mjs   (reads DATABASE_URL from the environment/.env
// the same way every other seed-*.mjs in this package does; never printed).
//
// Determinism (ruling 2): every random decision below flows through ONE
// mulberry32 stream seeded from the fixed string "fleet-world-2026", and
// `now` is rounded down to the top of the hour — a rerun inside the same
// clock hour is byte-identical. To keep that guarantee airtight, this file
// (and every seed-world/* module it calls) follows a strict COMPUTE-THEN-
// WRITE discipline: every builder is a synchronous, pure function that
// returns plain row arrays; ALL random draws happen during that synchronous
// phase, and the `await`-ing createMany calls below never influence what was
// decided. Every id this file writes is either a fixed identity (org/
// dispatcher/policy, found-or-created) or `stableId(<semantic key>)` — never
// Prisma's random `@default(uuid())` — so a rerun reproduces the identical
// row id for the identical logical row every time.
//
// Idempotency (ruling 3): the org is found by name or created; everything
// under it is purged (purge.mjs) before this file writes a single new row,
// and nothing outside that org is ever touched.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildFleet } from "./seed-world/fleet.mjs";
import { buildLanes } from "./seed-world/lanes.mjs";
import { buildCustomers } from "./seed-world/customers.mjs";
import { buildDriverRoster, driverRows, hosRows, preferenceRows } from "./seed-world/drivers.mjs";
import { buildGenericHistory } from "./seed-world/history.mjs";
import { buildBorisHistory, buildChidiHistory, buildDwayneHistory, buildMarcusHistory, buildMilanHistory } from "./seed-world/namedHistory.mjs";
import { buildGenericCurrentWorld } from "./seed-world/current.mjs";
import { buildScenarioWorld } from "./seed-world/scenarioLoads.mjs";
import { purgeOrgWorld } from "./seed-world/purge.mjs";
import { mulberry32, stableId } from "./seed-world/prng.mjs";
import { roundDownToHour } from "./seed-world/time.mjs";
import { castByKey } from "./seed-world/cast.mjs";
import { SCENARIOS } from "./seed-world/scenarios.mjs";
import {
  AGENT_POLICY_NAME, BULK_DRIVER_BASELINE, CURRENT_ASSIGNED_BASELINE, CURRENT_IN_PROGRESS_BASELINE,
  CURRENT_OPEN_BASELINE, CURRENT_TENDERED_BASELINE, DISPATCHER_EMAIL, DISPATCHER_PASSWORD, HISTORICAL_BASELINE,
  LANE_COUNT, NAMED_HISTORY_RESERVE, ORG_NAME, ORG_TIMEZONE, fleetCount, scaled,
} from "./seed-world/targets.mjs";

// Re-exported so tests/seed-world.test.ts (and any future caller) can import
// everything it needs from this one module instead of reaching into
// seed-world/* directly — the only files this package's hard rules allow a
// test to add are the new seed files and the new test itself, so keeping a
// single typed entry point (seed-world.d.ts, next to this file) is what lets
// that test avoid `any` without a second .d.ts.
export { SCENARIOS } from "./seed-world/scenarios.mjs";
export { ORG_NAME, ORG_TIMEZONE, DISPATCHER_EMAIL, DISPATCHER_PASSWORD, WORLD_LOAD_TAG, WORLD_DRIVER_TAG } from "./seed-world/targets.mjs";
export { CAST } from "./seed-world/cast.mjs";

const PRNG_SEED = "fleet-world-2026";
const CARRIER_NAMES = ["Wolverine Freight Partners", "Buckeye Logistics LLC"];

async function upsertOrgShell(prisma) {
  let org = await prisma.org.findFirst({ where: { name: ORG_NAME } });
  org = org
    ? await prisma.org.update({ where: { id: org.id }, data: { timezone: ORG_TIMEZONE } })
    : await prisma.org.create({ data: { name: ORG_NAME, timezone: ORG_TIMEZONE } });

  const dispatcherHash = await bcrypt.hash(DISPATCHER_PASSWORD, 10);
  await prisma.dispatcher.upsert({
    where: { email: DISPATCHER_EMAIL },
    update: { orgId: org.id, passwordHash: dispatcherHash, name: "World Dispatcher" },
    create: { email: DISPATCHER_EMAIL, passwordHash: dispatcherHash, name: "World Dispatcher", orgId: org.id },
  });

  await prisma.plan.upsert({ where: { orgId: org.id }, update: { tier: "tower" }, create: { orgId: org.id, tier: "tower" } });

  const agentPolicy = await prisma.agentPolicy.upsert({
    where: { orgId_name: { orgId: org.id, name: AGENT_POLICY_NAME } },
    update: { dispatcherEmail: DISPATCHER_EMAIL, shadow: true },
    create: { orgId: org.id, name: AGENT_POLICY_NAME, dispatcherEmail: DISPATCHER_EMAIL, shadow: true },
  });

  return { org, agentPolicy };
}

function applyPositionOverrides(rows, overrides) {
  return rows.map((row) => {
    const override = overrides[row.id];
    if (!override) return row;
    return { ...row, lastLat: override.lat, lastLng: override.lng, lastLocationAt: override.at ?? row.lastLocationAt };
  });
}

/**
 * Regenerates the whole demo world. `scale` multiplies only the BULK counts
 * (ruling 1) — drivers beyond the 15-member scenario cast, historical loads
 * beyond the 4 named drivers' dedicated history, and generic current loads
 * beyond the 14 scenario ones. `now` defaults to the real clock; both
 * defaults exist so `node seed-world.mjs` (no args) reproduces the full-
 * scale dev world while `seedWorld(prisma, { scale: 0.15, now: FIXED })`
 * drives the test suite's much smaller, still fully-deterministic one.
 */
export async function seedWorld(prisma, { scale = 1, now = Date.now() } = {}) {
  const nowMs = roundDownToHour(now);
  const rand = mulberry32(PRNG_SEED);

  const { org, agentPolicy } = await upsertOrgShell(prisma);
  const purged = await purgeOrgWorld(prisma, org.id);
  console.log(`[seed-world] org "${org.name}" (${org.id}) — purged ${purged.purgedLoads} loads, ${purged.purgedDrivers} drivers, ${purged.purgedTrips} trips`);

  const carrierRows = CARRIER_NAMES.map((name, i) => ({
    id: stableId(`carrier:${name}`), orgId: org.id, name, mcNumber: `MC-9${String(10000 + i)}`, status: "active",
  }));
  await prisma.carrier.createMany({ data: carrierRows });
  console.log(`[seed-world] carriers: ${carrierRows.length}`);

  // ---- Customers -----------------------------------------------------------
  const customerSpecs = buildCustomers(rand);
  await prisma.customer.createMany({ data: customerSpecs.map((c) => ({ ...c, orgId: org.id })) });
  console.log(`[seed-world] customers: ${customerSpecs.length} (${customerSpecs.filter((c) => c.priority === "high").length} high-priority)`);

  // ---- Driver roster (specs only — DB rows are written once, after every
  // position override below is known) -----------------------------------
  const bulkDriverCount = scaled(BULK_DRIVER_BASELINE, scale);
  const allDriverSpecs = buildDriverRoster(rand, bulkDriverCount);
  const castSpecs = allDriverSpecs.filter((s) => s.isCast);
  const bulkSpecs = allDriverSpecs.filter((s) => !s.isCast);

  const lanes = buildLanes(rand, LANE_COUNT);

  // ---- The 14 scenarios + Ana's inbound trip -------------------------------
  const scenarioWorld = buildScenarioWorld(rand, { orgId: org.id, customers: customerSpecs, nowMs, agentPolicyId: agentPolicy.id });

  // ---- Named drivers' exact-number history (ruling 5) ----------------------
  const milan = castByKey("milan");
  const dwayne = castByKey("dwayne");
  const boris = castByKey("boris");
  const chidi = castByKey("chidi");
  const marcus = castByKey("marcus");
  const milanHistory = buildMilanHistory(rand, { orgId: org.id, driver: milan, customers: customerSpecs, lanes, nowMs });
  const dwayneHistory = buildDwayneHistory(rand, { orgId: org.id, agentPolicyId: agentPolicy.id, driver: dwayne, customers: customerSpecs, lanes, nowMs });
  const borisHistory = buildBorisHistory(rand, { orgId: org.id, agentPolicyId: agentPolicy.id, driver: boris, customers: customerSpecs, lanes, nowMs });
  const chidiHistory = buildChidiHistory(rand, { orgId: org.id, agentPolicyId: agentPolicy.id, driver: chidi, customers: customerSpecs, lanes, nowMs });
  const marcusHistory = buildMarcusHistory(rand, { orgId: org.id, driver: marcus, customers: customerSpecs, nowMs });

  // ---- Generic bulk historical loads (~3,000 x scale, minus the named
  // drivers' reserve above) -------------------------------------------------
  const genericHistoricalCount = Math.max(0, scaled(HISTORICAL_BASELINE, scale) - NAMED_HISTORY_RESERVE);
  const genericHistory = buildGenericHistory(rand, {
    orgId: org.id, agentPolicyId: agentPolicy.id, drivers: bulkSpecs, customers: customerSpecs, lanes, nowMs, count: genericHistoricalCount,
  });

  // ---- Generic bulk current/future loads -----------------------------------
  const currentCounts = {
    open: scaled(CURRENT_OPEN_BASELINE, scale),
    assigned: scaled(CURRENT_ASSIGNED_BASELINE, scale),
    inProgress: scaled(CURRENT_IN_PROGRESS_BASELINE, scale),
    tendered: scaled(CURRENT_TENDERED_BASELINE, scale),
  };
  const genericCurrent = buildGenericCurrentWorld(rand, {
    orgId: org.id, bulkDrivers: bulkSpecs, lanes, customers: customerSpecs, nowMs, counts: currentCounts,
  });

  // ---- Own fleet ------------------------------------------------------------
  const fleet = buildFleet(rand, { orgId: org.id, count: fleetCount(scale), carrierAId: carrierRows[0].id, carrierBId: carrierRows[1].id });

  // ---- Drivers, HOS, preferences (positions merged in from both "current"
  // builders before the one and only Driver createMany) ---------------------
  const positionOverrides = { ...scenarioWorld.driverPositionOverrides, ...genericCurrent.driverPositionOverrides };
  const finalDriverRows = applyPositionOverrides(driverRows(allDriverSpecs, org.id, nowMs), positionOverrides);
  await prisma.driver.createMany({ data: finalDriverRows });
  await prisma.hosState.createMany({ data: hosRows(allDriverSpecs, nowMs) });
  await prisma.driverPreference.createMany({ data: preferenceRows(rand, allDriverSpecs) });
  await prisma.driverAvailability.createMany({ data: [...scenarioWorld.driverAvailability, ...genericCurrent.driverAvailability] });
  await prisma.simDriverState.createMany({ data: scenarioWorld.simDriverStates });
  console.log(`[seed-world] drivers: ${allDriverSpecs.length} (cast ${castSpecs.length}, bulk ${bulkSpecs.length}) — HOS/availability/preference rows for all`);

  await prisma.tractor.createMany({ data: fleet.tractors });
  await prisma.trailer.createMany({ data: fleet.trailers });
  console.log(`[seed-world] fleet: ${fleet.tractors.length} tractors, ${fleet.trailers.length} trailers`);

  // ---- Loads / stops / appointments / assignments / pings / agent evidence,
  // each as ONE createMany across every source (ruling 7: bulk rows via
  // createMany, ids known up front via stableId — no post-insert lookups
  // needed anywhere in this file). One array of the five named-driver
  // histories so adding a sixth later can't forget one of the six flat
  // concatenations below the way hand-listing each by name invites. -------
  const namedHistories = [milanHistory, dwayneHistory, borisHistory, chidiHistory, marcusHistory];
  const namedHistoryLoadCount = namedHistories.reduce((sum, h) => sum + h.loads.length, 0);

  const allLoads = [...scenarioWorld.loads, ...namedHistories.flatMap((h) => h.loads), ...genericHistory.loads, ...genericCurrent.loads];
  const allStops = [...scenarioWorld.stops, ...namedHistories.flatMap((h) => h.stops), ...genericHistory.stops, ...genericCurrent.stops];
  const allAppointments = [...scenarioWorld.appointments, ...namedHistories.flatMap((h) => h.appointments), ...genericHistory.appointments, ...genericCurrent.appointments];
  const allAssignments = [...scenarioWorld.assignments, ...namedHistories.flatMap((h) => h.assignments), ...genericHistory.assignments, ...genericCurrent.assignments];
  const allPings = [...scenarioWorld.driverLocations, ...genericHistory.driverLocations, ...genericCurrent.driverLocations];
  const allTrips = [...scenarioWorld.agentTrips, ...namedHistories.flatMap((h) => h.agentTrips), ...genericHistory.agentTrips];
  const allEvents = [...scenarioWorld.agentEvents, ...namedHistories.flatMap((h) => h.agentEvents), ...genericHistory.agentEvents];

  await prisma.load.createMany({ data: allLoads });
  console.log(`[seed-world] loads: ${allLoads.length} (historical ${namedHistoryLoadCount + genericHistory.loads.length}, current/scenario ${scenarioWorld.loads.length + genericCurrent.loads.length})`);

  await prisma.loadStop.createMany({ data: allStops });
  console.log(`[seed-world] load stops: ${allStops.length}`);

  await prisma.appointment.createMany({ data: allAppointments });
  console.log(`[seed-world] appointments: ${allAppointments.length}`);

  await prisma.assignment.createMany({ data: allAssignments });
  console.log(`[seed-world] assignments: ${allAssignments.length}`);

  await prisma.driverLocation.createMany({ data: allPings });
  console.log(`[seed-world] driver location pings: ${allPings.length}`);

  await prisma.agentTrip.createMany({ data: allTrips });
  await prisma.agentEvent.createMany({ data: allEvents });
  console.log(`[seed-world] agent trips: ${allTrips.length}, agent events: ${allEvents.length}`);

  console.log(`[seed-world] scenarios: ${SCENARIOS.map((s) => s.code).join(", ")} — done`);

  return {
    orgId: org.id,
    counts: {
      customers: customerSpecs.length,
      drivers: allDriverSpecs.length,
      historicalLoads: namedHistoryLoadCount + genericHistory.loads.length,
      currentLoads: scenarioWorld.loads.length + genericCurrent.loads.length,
      loads: allLoads.length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry: `node seed-world.mjs`
// ---------------------------------------------------------------------------
async function main() {
  const prisma = new PrismaClient();
  try {
    await seedWorld(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
