import { addressIn } from "./cities.mjs";
import { tripEconomics, revenueForMiles } from "./economics.mjs";
import { driveMinutes, roadMiles } from "./geo.mjs";
import { alongRoutePings } from "./pings.mjs";
import { chance, pick, randFloat, randInt, shuffle, stableId } from "./prng.mjs";
import { hoursFromNow } from "./time.mjs";
import { NEAR_TERM_PICKUP_HOURS, NEXT_WEEK_MAX_DAYS, NEXT_WEEK_MIN_DAYS, NEXT_WEEK_SHARE_OF_OPEN, WORLD_LOAD_TAG } from "./targets.mjs";
import { AVAILABLE_SOON_WINDOW_MS } from "./constants.mjs";

// Generic bulk current/future loads: open (uncovered), assigned (future),
// in_progress (with pings), tendered (an outstanding offer) — the current-
// world consistency rules, applied to whichever driver each load happens to
// draw. The 14 lettered scenarios (scenarioLoads.mjs) are built entirely
// separately and are never part of this pool.
//
// Compute-then-write: synchronous, returns plain row arrays.
const OFF_DUTY_SHARE_OF_FREE = 0.3;

function buildStopsAndAppointments(rand, externalId, loadId, origin, destination, pickupWindow, deliveryWindow) {
  const pickupStopId = stableId(`loadStop:${externalId}:1`);
  const deliveryStopId = stableId(`loadStop:${externalId}:2`);
  const stops = [
    { id: pickupStopId, loadId, sequence: 1, type: "pickup", address: addressIn(rand, origin), lat: origin.lat, lng: origin.lng, geocodeStatus: "ok", dwellMin: 60 },
    { id: deliveryStopId, loadId, sequence: 2, type: "delivery", address: addressIn(rand, destination), lat: destination.lat, lng: destination.lng, geocodeStatus: "ok", dwellMin: 60 },
  ];
  const appointments = [
    { id: stableId(`appt:${externalId}:1`), stopId: pickupStopId, windowStart: pickupWindow.start ?? null, windowEnd: pickupWindow.end, type: "pickup", kind: "appointment" },
    { id: stableId(`appt:${externalId}:2`), stopId: deliveryStopId, windowStart: deliveryWindow?.start ?? null, windowEnd: deliveryWindow?.end ?? pickupWindow.end, type: "delivery", kind: "appointment" },
  ];
  return { stops, appointments, deliveryStop: stops[1] };
}

function buildOpenLoads(rand, { orgId, count, lanes, customers, nowMs, startIndex }) {
  const loads = []; const stops = []; const appointments = [];
  for (let i = 0; i < count; i++) {
    const externalId = `${WORLD_LOAD_TAG}OPEN-${String(startIndex + i + 1).padStart(5, "0")}`;
    const loadId = stableId(`load:${externalId}`);
    const lane = pick(rand, lanes);
    const customer = pick(rand, customers);
    const isNextWeek = chance(rand, NEXT_WEEK_SHARE_OF_OPEN);
    const pickupStart = isNextWeek
      ? hoursFromNow(nowMs, randInt(rand, NEXT_WEEK_MIN_DAYS * 24, NEXT_WEEK_MAX_DAYS * 24))
      : hoursFromNow(nowMs, randInt(rand, 2, NEAR_TERM_PICKUP_HOURS));
    const pickupEnd = new Date(pickupStart.getTime() + randInt(rand, 2, 6) * 60 * 60_000);
    const built = buildStopsAndAppointments(rand, externalId, loadId, lane.origin, lane.destination, { start: pickupStart, end: pickupEnd }, { end: new Date(pickupEnd.getTime() + randInt(rand, 6, 30) * 60 * 60_000) });
    loads.push({
      id: loadId, orgId, externalId, status: "open", requiredEquip: pick(rand, ["DryVan", "Reefer", "Flatbed", "Tanker"]),
      revenueCents: 0, fscCents: 0, customerName: customer.name, customerEmail: customer.primaryEmail, customerId: customer.id,
      agentEnabled: false, agentPolicyId: null, agentPill: "off",
    });
    stops.push(...built.stops);
    appointments.push(...built.appointments);
  }
  return { loads, stops, appointments };
}

/** Shared shape for assigned/tendered/in_progress: a load a specific driver
 *  is (or will be) running. */
function buildDrivenLoad(rand, { tag, orgId, driver, lane, customer, plannedStart, plannedEnd, status, assignmentStatus, startedAt, tenderedAt }) {
  const externalId = `${WORLD_LOAD_TAG}${tag}`;
  const loadId = stableId(`load:${externalId}`);
  const built = buildStopsAndAppointments(rand, externalId, loadId, lane.origin, lane.destination, { end: plannedStart }, { end: new Date(plannedEnd.getTime() + 60 * 60_000) });

  const base = tripEconomics(lane.origin, lane.destination, 0, { dwellMin: 60 });
  const revenueCents = revenueForMiles(rand, base.loadedMi);
  const economics = { ...base, marginCents: Math.round(revenueCents * 0.18) };

  const load = {
    id: loadId, orgId, externalId, status, requiredEquip: driver.equipmentTypes[0],
    revenueCents, fscCents: Math.round(revenueCents * 0.1),
    customerName: customer.name, customerEmail: customer.primaryEmail, customerId: customer.id,
    agentEnabled: false, agentPolicyId: null, agentPill: "off",
  };
  const assignment = {
    id: stableId(`assignment:${externalId}`), orgId, loadId, driverId: driver.id,
    plannedStart, plannedEnd, deadheadMi: 0, loadedMi: economics.loadedMi, marginCents: economics.marginCents,
    savedMi: economics.savedMi, driveMin: economics.driveMin, onDutyMin: economics.onDutyMin, tookBreak: economics.driveMin > 480,
    status: assignmentStatus, startedAt: startedAt ?? null, completedAt: null, tenderedAt: tenderedAt ?? null,
  };
  return { load, stops: built.stops, appointments: built.appointments, assignment, deliveryStop: built.deliveryStop };
}

function buildAssignedLoads(rand, { orgId, drivers, lanes, customers, nowMs, startIndex }) {
  const loads = []; const stops = []; const appointments = []; const assignments = []; const deliveryStops = [];
  drivers.forEach((driver, i) => {
    const plannedStart = hoursFromNow(nowMs, randInt(rand, 2, 60));
    const lane = pick(rand, lanes);
    const totalDriveMin = driveMinutes(roadMiles(lane.origin, lane.destination));
    const plannedEnd = new Date(plannedStart.getTime() + totalDriveMin * 60_000);
    const built = buildDrivenLoad(rand, { tag: `ASSIGNED-${String(startIndex + i + 1).padStart(5, "0")}`, orgId, driver, lane, customer: pick(rand, customers), plannedStart, plannedEnd, status: "assigned", assignmentStatus: "assigned" });
    loads.push(built.load); stops.push(...built.stops); appointments.push(...built.appointments); assignments.push(built.assignment); deliveryStops.push(built.deliveryStop);
  });
  return { loads, stops, appointments, assignments, deliveryStops };
}

function buildTenderedLoads(rand, { orgId, drivers, lanes, customers, nowMs, startIndex }) {
  const loads = []; const stops = []; const appointments = []; const assignments = []; const deliveryStops = [];
  drivers.forEach((driver, i) => {
    const plannedStart = hoursFromNow(nowMs, randInt(rand, 4, 48));
    const lane = pick(rand, lanes);
    const totalDriveMin = driveMinutes(roadMiles(lane.origin, lane.destination));
    const plannedEnd = new Date(plannedStart.getTime() + totalDriveMin * 60_000);
    const built = buildDrivenLoad(rand, { tag: `TENDER-${String(startIndex + i + 1).padStart(5, "0")}`, orgId, driver, lane, customer: pick(rand, customers), plannedStart, plannedEnd, status: "tendered", assignmentStatus: "tendered", tenderedAt: new Date(nowMs) });
    loads.push(built.load); stops.push(...built.stops); appointments.push(...built.appointments); assignments.push(built.assignment); deliveryStops.push(built.deliveryStop);
  });
  return { loads, stops, appointments, assignments, deliveryStops };
}

function buildInProgressLoads(rand, { orgId, drivers, lanes, customers, nowMs, startIndex }) {
  const loads = []; const stops = []; const appointments = []; const assignments = []; const driverLocations = []; const deliveryStops = [];
  drivers.forEach((driver, i) => {
    const lane = pick(rand, lanes);
    const totalDriveMin = driveMinutes(roadMiles(lane.origin, lane.destination));
    const startedHoursAgo = Math.min(totalDriveMin / 60 - 0.25, randFloat(rand, 0.5, 3));
    const plannedStart = new Date(nowMs - Math.max(0.1, startedHoursAgo) * 60 * 60_000);
    const plannedEnd = new Date(plannedStart.getTime() + totalDriveMin * 60_000);
    const elapsedMin = (nowMs - plannedStart.getTime()) / 60_000;
    const planFraction = Math.min(1, Math.max(0, elapsedMin / totalDriveMin));
    const built = buildDrivenLoad(rand, { tag: `PROGRESS-${String(startIndex + i + 1).padStart(5, "0")}`, orgId, driver, lane, customer: pick(rand, customers), plannedStart, plannedEnd, status: "in_progress", assignmentStatus: "in_progress", startedAt: plannedStart });
    loads.push(built.load); stops.push(...built.stops); appointments.push(...built.appointments); assignments.push(built.assignment); deliveryStops.push(built.deliveryStop);
    driverLocations.push(...alongRoutePings(driver.id, lane.origin, lane.destination, planFraction, nowMs));
  });
  return { loads, stops, appointments, assignments, driverLocations, deliveryStops };
}

function projectedAvailability(assignment, deliveryStop) {
  return {
    availableAt: assignment.plannedEnd,
    availableLat: deliveryStop.lat, availableLng: deliveryStop.lng,
  };
}

/**
 * The whole generic bulk current world: `counts.{open,assigned,inProgress,
 * tendered}` loads, drawn from `bulkDrivers` (already excludes the 15
 * scenario-cast drivers — current.mjs never touches them) — plus a
 * DriverAvailability row for every one of `bulkDrivers` (busy ones from the
 * assigned/in_progress/tendered draw; the rest split AVAILABLE/OFF_DUTY).
 */
export function buildGenericCurrentWorld(rand, { orgId, bulkDrivers, lanes, customers, nowMs, counts }) {
  const shuffled = shuffle(rand, bulkDrivers);
  const assignedDrivers = shuffled.slice(0, Math.min(counts.assigned, shuffled.length));
  const inProgressDrivers = shuffled.slice(assignedDrivers.length, assignedDrivers.length + Math.min(counts.inProgress, shuffled.length - assignedDrivers.length));
  const tenderedDrivers = shuffled.slice(
    assignedDrivers.length + inProgressDrivers.length,
    assignedDrivers.length + inProgressDrivers.length + Math.min(counts.tendered, Math.max(0, shuffled.length - assignedDrivers.length - inProgressDrivers.length)),
  );
  const busyIds = new Set([...assignedDrivers, ...inProgressDrivers, ...tenderedDrivers].map((d) => d.id));
  const freeDrivers = bulkDrivers.filter((d) => !busyIds.has(d.id));

  const openBuilt = buildOpenLoads(rand, { orgId, count: counts.open, lanes, customers, nowMs, startIndex: 0 });
  const assignedBuilt = buildAssignedLoads(rand, { orgId, drivers: assignedDrivers, lanes, customers, nowMs, startIndex: 0 });
  const tenderedBuilt = buildTenderedLoads(rand, { orgId, drivers: tenderedDrivers, lanes, customers, nowMs, startIndex: 0 });
  const inProgressBuilt = buildInProgressLoads(rand, { orgId, drivers: inProgressDrivers, lanes, customers, nowMs, startIndex: 0 });

  const busyAssignmentByDriver = new Map();
  for (const built of [assignedBuilt, tenderedBuilt, inProgressBuilt]) {
    built.assignments.forEach((a, i) => busyAssignmentByDriver.set(a.driverId, { assignment: a, deliveryStop: built.deliveryStops[i] }));
  }

  const driverAvailability = bulkDrivers.map((driver) => {
    const busy = busyAssignmentByDriver.get(driver.id);
    if (busy) {
      const { assignment, deliveryStop } = busy;
      const status = assignment.plannedEnd.getTime() - nowMs <= AVAILABLE_SOON_WINDOW_MS ? "AVAILABLE_SOON" : "ON_LOAD";
      const proj = deliveryStop ? projectedAvailability(assignment, deliveryStop) : { availableAt: assignment.plannedEnd, availableLat: null, availableLng: null };
      return {
        driverId: driver.id, acceptingLoads: true, availabilityStatus: status, source: "derived",
        availableAt: proj.availableAt, availableLat: proj.availableLat, availableLng: proj.availableLng,
        availableCity: null, availableState: null, locationSharingEnabled: driver.locationSharingEnabled, locationSharingUpdatedAt: new Date(nowMs),
      };
    }
    const offDuty = chance(rand, OFF_DUTY_SHARE_OF_FREE);
    return offDuty
      ? { driverId: driver.id, acceptingLoads: false, availabilityStatus: "OFF_DUTY", source: "manual", availableAt: null, availableLat: null, availableLng: null, availableCity: null, availableState: null, locationSharingEnabled: driver.locationSharingEnabled, locationSharingUpdatedAt: new Date(nowMs) }
      : { driverId: driver.id, acceptingLoads: true, availabilityStatus: "AVAILABLE", source: "derived", availableAt: null, availableLat: null, availableLng: null, availableCity: null, availableState: null, locationSharingEnabled: driver.locationSharingEnabled, locationSharingUpdatedAt: new Date(nowMs) };
  });

  // Only in_progress drivers get a live position override — their
  // Driver.lastLat/lastLng becomes their latest ping; assigned/tendered
  // drivers haven't moved yet, so they stay at their home-base default.
  const driverPositionOverrides = {};
  for (const ping of inProgressBuilt.driverLocations) {
    const current = driverPositionOverrides[ping.driverId];
    if (!current || ping.createdAt.getTime() > current.at.getTime()) {
      driverPositionOverrides[ping.driverId] = { lat: ping.latitude, lng: ping.longitude, at: ping.createdAt };
    }
  }

  return {
    loads: [...openBuilt.loads, ...assignedBuilt.loads, ...tenderedBuilt.loads, ...inProgressBuilt.loads],
    stops: [...openBuilt.stops, ...assignedBuilt.stops, ...tenderedBuilt.stops, ...inProgressBuilt.stops],
    appointments: [...openBuilt.appointments, ...assignedBuilt.appointments, ...tenderedBuilt.appointments, ...inProgressBuilt.appointments],
    assignments: [...assignedBuilt.assignments, ...tenderedBuilt.assignments, ...inProgressBuilt.assignments],
    driverLocations: inProgressBuilt.driverLocations,
    driverAvailability,
    driverPositionOverrides,
    freeDriverCount: freeDrivers.length,
  };
}
