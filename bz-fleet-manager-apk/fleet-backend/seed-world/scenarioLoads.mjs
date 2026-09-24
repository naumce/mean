import { CAST } from "./cast.mjs";
import { buildActiveScenarios } from "./scenarioActive.mjs";
import { buildOpenScenarios } from "./scenarioOpen.mjs";

// Thin orchestrator: combines the 8 open/candidate scenarios (A B C D E F G
// H) with the 6 in-progress-or-completed ones (Ana's inbound + I J K L M N),
// then derives the two things that depend on BOTH halves together — every
// cast driver's DriverAvailability row and their Driver.lastLat/lastLng
// override — so scenarioOpen.mjs/scenarioActive.mjs never need to know about
// each other or about the full cast list.
const AVAILABLE_SOON_WINDOW_MS = 4 * 60 * 60 * 1000; // driverAvailability.ts's own constant, copied (no cross-package import)

function latestPingPerDriver(driverLocations) {
  const latest = new Map();
  for (const ping of driverLocations) {
    const current = latest.get(ping.driverId);
    if (!current || ping.createdAt.getTime() > current.createdAt.getTime()) latest.set(ping.driverId, ping);
  }
  return latest;
}

function cityStateOf(hub) {
  return { city: hub?.city ?? null, state: hub?.state ?? null };
}

/**
 * Everything scenario-specific: the 14 lettered loads + Ana's inbound trip,
 * every cast driver's DriverAvailability row, their SimDriverState rows
 * (K/L/N), and the `driverPositionOverrides` current.mjs stamps onto the
 * Driver rows drivers.mjs already built (home-base default otherwise).
 */
export function buildScenarioWorld(rand, { orgId, customers, nowMs, agentPolicyId }) {
  const open = buildOpenScenarios(rand, { orgId, customers, nowMs });
  const active = buildActiveScenarios(rand, { orgId, customers, nowMs, agentPolicyId });

  const latestPings = latestPingPerDriver(active.driverLocations);
  const busyByDriver = new Map(active.busyDrivers.map((b) => [b.driverId, b]));

  const driverPositionOverrides = { ...open.driverPositions };
  for (const [driverId, ping] of latestPings) {
    driverPositionOverrides[driverId] = { lat: ping.latitude, lng: ping.longitude, at: ping.createdAt };
  }

  const busyIds = new Set(active.busyDrivers.map((b) => b.driverId));
  const driverAvailability = CAST.map((c) => {
    const busy = busyByDriver.get(c.id);
    if (busy) {
      const status = busy.plannedEnd.getTime() - nowMs <= AVAILABLE_SOON_WINDOW_MS ? "AVAILABLE_SOON" : "ON_LOAD";
      const { city, state } = cityStateOf(busy.destination);
      return {
        driverId: c.id, acceptingLoads: true, availabilityStatus: status, source: "derived",
        availableAt: busy.plannedEnd, availableLat: busy.destination?.lat ?? null, availableLng: busy.destination?.lng ?? null,
        availableCity: city, availableState: state,
        locationSharingEnabled: true, locationSharingUpdatedAt: new Date(nowMs),
      };
    }
    return {
      driverId: c.id, acceptingLoads: true, availabilityStatus: "AVAILABLE", source: "derived",
      availableAt: null, availableLat: null, availableLng: null, availableCity: null, availableState: null,
      locationSharingEnabled: true, locationSharingUpdatedAt: new Date(nowMs),
    };
  });

  return {
    loads: [...open.loads, ...active.loads],
    stops: [...open.stops, ...active.stops],
    appointments: [...open.appointments, ...active.appointments],
    assignments: active.assignments,
    driverLocations: active.driverLocations,
    agentTrips: active.agentTrips,
    agentEvents: active.agentEvents,
    simDriverStates: active.simDriverStates,
    driverAvailability,
    driverPositionOverrides,
    busyDriverIds: [...busyIds],
  };
}
