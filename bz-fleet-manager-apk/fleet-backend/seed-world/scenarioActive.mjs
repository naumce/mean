import { askEvent, buildBrief, buildTrip, unplannedStopAnomalyEvent } from "./agentEvidence.mjs";
import { castByScenario } from "./cast.mjs";
import { addressIn, hub, KALAMAZOO_MI } from "./cities.mjs";
import { buildDwellPings } from "./detention.mjs";
import { tripEconomics, revenueForMiles } from "./economics.mjs";
import { alongRoute, driveMinutes, roadMiles } from "./geo.mjs";
import { alongRoutePings, identicalStopPings, offRoutePings, staleDarkPings } from "./pings.mjs";
import { stableId } from "./prng.mjs";
import { scenarioByCode } from "./scenarios.mjs";
import { atLocalTime } from "./time.mjs";
import { ORG_TIMEZONE, WORLD_LOAD_TAG } from "./targets.mjs";

// The "already moving (or about to be)" half of the scenario set: C's
// Ana-inbound trip (an extra load, no letter of its own — its point is
// entirely to make Ana available for W-C-SOON) plus I, J, K, L, N and M
// (completed, detention). Every one of these produces a Load + stops +
// appointment(s) + Assignment, and most also produce DriverLocation pings
// and/or AgentTrip/AgentEvent rows. Ana's inbound trip and I are the
// exception (invited-brief.md section C): assigned but not yet departed, so
// they carry no pings/trip at all — the real worker starts watching once the
// driver accepts and departs.

function extrasFor(code) {
  const s = scenarioByCode(code);
  return { scenario: { code: s.code, title: s.title, hint: s.hint } };
}

/** Shared shape for an in-progress or completed scenario load: one pickup,
 *  one delivery, an Assignment. `externalId`/`extras` are omitted for the
 *  unlettered Ana-inbound trip (`code: null`). */
function buildActiveLoad(rand, { code, tag, orgId, origin, destination, requiredEquip, customer, driverId, plannedStart, plannedEnd, status, startedAt, completedAt, deliveryWindowStart, deliveryWindowEnd, assignmentStatus }) {
  const externalId = code ? scenarioByCode(code).externalId : `${WORLD_LOAD_TAG}${tag}`;
  const loadId = stableId(`load:${externalId}`);
  const pickupStopId = stableId(`loadStop:${externalId}:1`);
  const deliveryStopId = stableId(`loadStop:${externalId}:2`);
  const economics = (() => {
    const base = tripEconomics(origin, destination, 0, { dwellMin: 60 });
    const revenueCents = revenueForMiles(rand, base.loadedMi);
    return { ...base, marginCents: Math.round(revenueCents * 0.18), revenueCents };
  })();

  const load = {
    id: loadId, orgId, externalId, status, requiredEquip,
    revenueCents: economics.revenueCents, fscCents: Math.round(economics.revenueCents * 0.1),
    customerName: customer.name, customerEmail: customer.primaryEmail, customerId: customer.id,
    agentEnabled: false, agentPolicyId: null, agentPill: "off",
    ...(code ? { extras: extrasFor(code) } : {}),
  };
  const stops = [
    { id: pickupStopId, loadId, sequence: 1, type: "pickup", address: addressIn(rand, origin), lat: origin.lat, lng: origin.lng, geocodeStatus: "ok", dwellMin: 60 },
    { id: deliveryStopId, loadId, sequence: 2, type: "delivery", address: addressIn(rand, destination), lat: destination.lat, lng: destination.lng, geocodeStatus: "ok", dwellMin: 60 },
  ];
  const appointments = [
    { id: stableId(`appt:${externalId}:1`), stopId: pickupStopId, windowStart: null, windowEnd: plannedStart, type: "pickup", kind: "appointment" },
    { id: stableId(`appt:${externalId}:2`), stopId: deliveryStopId, windowStart: deliveryWindowStart ?? null, windowEnd: deliveryWindowEnd, type: "delivery", kind: "appointment" },
  ];
  const assignment = {
    id: stableId(`assignment:${externalId}`), orgId, loadId, driverId,
    plannedStart, plannedEnd,
    deadheadMi: 0, loadedMi: economics.loadedMi, marginCents: economics.marginCents, savedMi: economics.savedMi,
    driveMin: economics.driveMin, onDutyMin: economics.onDutyMin, tookBreak: economics.driveMin > 480,
    status: assignmentStatus, startedAt, completedAt,
  };
  return { load, stops, appointments, assignment, loadId, externalId };
}

/** Loads whose `agentEnabled`/`agentPill` seed-mix-brief.md rule 2 turns
 *  "watching" with NO seeded trip — the real worker creates its own trip and
 *  starts watching in shadow, so no AgentTrip/AgentEvent rows are added here,
 *  unlike scenario J's own seeded-trip pattern. */
function withWatching(load, agentPolicyId) {
  return { ...load, agentEnabled: true, agentPolicyId, agentPill: "watching" };
}

/**
 * Ana's inbound trip (Kalamazoo -> Detroit), the driver behind scenario C.
 * plannedEnd is pinned to exactly 10:20 tomorrow, Detroit time — always in
 * the future relative to `now` (a full calendar day out) regardless of what
 * `now` currently is. The gap between plannedStart and plannedEnd is
 * intentionally NOT required to equal the route's own drive time (real
 * dispatch plans routinely carry slack) — economics (loadedMi/driveMin/etc.)
 * are computed independently from the real Kalamazoo->Detroit distance.
 *
 * invited-brief.md section C: assigned, not yet departed — the live worker
 * only starts tracking once the driver accepts the invite and departs
 * (first ping). plannedStart (and so the pickup appointment's window end,
 * via buildActiveLoad) is 2h after seed time, always comfortably before the
 * day-out plannedEnd above regardless of when this generator runs; startedAt
 * stays null and the assignment itself is "assigned", not "in_progress".
 * No pings/trip are seeded — the real worker creates its own trip once the
 * driver accepts.
 *
 * seed-mix-brief.md rule 2: one of the two "watching, with a phone" loads
 * (Ana's driver phone comes from targets.mjs's CAST_PHONES via drivers.mjs).
 */
function buildAnaInbound(rand, { orgId, customer, nowMs, agentPolicyId }) {
  const ana = castByScenario("C");
  const detroit = hub("Detroit");
  const plannedEnd = atLocalTime(new Date(nowMs), ORG_TIMEZONE, 10, 20, 1);
  const plannedStart = new Date(nowMs + 2 * 60 * 60_000);
  const built = buildActiveLoad(rand, {
    code: null, tag: "C-ANA-INBOUND", orgId, origin: KALAMAZOO_MI, destination: detroit, requiredEquip: "DryVan",
    customer, driverId: ana.id, plannedStart, plannedEnd, status: "assigned",
    startedAt: null, completedAt: null, deliveryWindowEnd: new Date(plannedEnd.getTime() + 60 * 60_000), assignmentStatus: "assigned",
  });
  return { ...built, load: withWatching(built.load, agentPolicyId), driverId: ana.id, destination: detroit };
}

function commonInProgress(rand, { code, orgId, homeHub, destHub, driverId, requiredEquip, customer, nowMs, startedHoursAgo = 2.5 }) {
  const origin = hub(homeHub);
  const destination = hub(destHub);
  const totalDriveMin = driveMinutes(roadMiles(origin, destination));
  const plannedStart = new Date(nowMs - startedHoursAgo * 60 * 60_000);
  const plannedEnd = new Date(plannedStart.getTime() + totalDriveMin * 60_000);
  const elapsedMin = (nowMs - plannedStart.getTime()) / 60_000;
  const planFraction = Math.min(1, Math.max(0, elapsedMin / totalDriveMin));
  const built = buildActiveLoad(rand, {
    code, tag: null, orgId, origin, destination, requiredEquip, customer,
    driverId, plannedStart, plannedEnd, status: "in_progress", startedAt: plannedStart, completedAt: null,
    deliveryWindowEnd: new Date(plannedEnd.getTime() + 60 * 60_000), assignmentStatus: "in_progress",
  });
  return { ...built, origin, destination, totalDriveMin, planFraction };
}

/** I — invited-brief.md section C: assigned, not yet departed, same as
 *  Ana's inbound trip above. Columbus -> Nashville (long enough that once
 *  departed and underway, deriveStatus still reads this driver ON_LOAD, not
 *  AVAILABLE_SOON — the assignment is already active (status "assigned" is
 *  one of activeStatuses.ts's ACTIVE_STATUSES) so the driver reads ON_LOAD
 *  even before departure). plannedStart (and so the pickup appointment's
 *  window end) is 3h after seed time; startedAt stays null. Built directly
 *  (not via commonInProgress, which is shared with J/K/L/N and still models
 *  an already-departed load) so only this scenario's timing changes.
 *  seed-mix-brief.md rule 2: the second "watching, with a phone" load
 *  (Hassan's phone comes from targets.mjs's CAST_PHONES via drivers.mjs). No
 *  pings/trip are seeded — the real worker creates its own once Hassan
 *  accepts and departs. */
function buildScenarioI(rand, { orgId, customer, nowMs, agentPolicyId }) {
  const hassan = castByScenario("I");
  const origin = hub("Columbus");
  const destination = hub("Nashville");
  const totalDriveMin = driveMinutes(roadMiles(origin, destination));
  const plannedStart = new Date(nowMs + 3 * 60 * 60_000);
  const plannedEnd = new Date(plannedStart.getTime() + totalDriveMin * 60_000);
  const built = buildActiveLoad(rand, {
    code: "I", tag: null, orgId, origin, destination, requiredEquip: hassan.equipmentTypes[0], customer,
    driverId: hassan.id, plannedStart, plannedEnd, status: "assigned", startedAt: null, completedAt: null,
    deliveryWindowEnd: new Date(plannedEnd.getTime() + 60 * 60_000), assignmentStatus: "assigned",
  });
  return { ...built, load: withWatching(built.load, agentPolicyId), driverId: hassan.id, origin, destination };
}

/** J — agentEnabled, agentPill "asked", an OPEN unplanned_stop anomaly.
 *  Indianapolis -> Memphis (long enough to stay ON_LOAD — see scenario I's
 *  own note on the 4h AVAILABLE_SOON window). */
function buildScenarioJ(rand, { orgId, customer, nowMs, agentPolicyId }) {
  const wei = castByScenario("J");
  const built = commonInProgress(rand, { code: "J", orgId, homeHub: "Indianapolis", destHub: "Memphis", driverId: wei.id, requiredEquip: wei.equipmentTypes[0], customer, nowMs, startedHoursAgo: 2.5 });
  const pings = alongRoutePings(wei.id, built.origin, built.destination, built.planFraction, nowMs);

  const withAgent = { ...built.load, agentEnabled: true, agentPolicyId, agentPill: "asked" };
  const trip = buildTrip({
    loadRef: built.externalId, loadId: built.loadId,
    brief: buildBrief({
      loadRef: built.externalId, origin: { ...built.origin, name: `${built.origin.city}, ${built.origin.state}` },
      destination: { ...built.destination, name: `${built.destination.city}, ${built.destination.state}` },
      equipment: wei.equipmentTypes[0], departAtMs: built.assignment.plannedStart.getTime(), deadlineAtMs: built.assignment.plannedEnd.getTime(),
      driverName: wei.name, driverPhone: "+15555550103",
    }),
    status: "tracking",
  });
  const stopFraction = Math.max(0, built.planFraction - 0.15);
  const stopPoint = alongRoute(built.origin, built.destination, stopFraction);
  const lastSeenMs = nowMs - 45 * 60_000;
  const firstSeenMs = lastSeenMs - 18 * 60_000;
  const anomaly = unplannedStopAnomalyEvent(trip.id, lastSeenMs, {
    firstSeenMs, lastSeenMs, observedMin: 18, pingCount: 4, at: { lat: stopPoint.lat, lng: stopPoint.lng }, thresholdMin: 15,
  });
  const ask = askEvent(trip.id, lastSeenMs + 2 * 60_000, { anomalyKey: "unplanned_stop@" + firstSeenMs, rung: 1, channel: "sms", text: "Everything OK? Noticed an unplanned stop." });

  return { ...built, load: withAgent, pings, agentTrips: [trip], agentEvents: [anomaly, ask], driverId: wei.id };
}

/** K — last 4 pings identical for 25 min at a non-stop point; SimDriverState
 *  "stopped". Milwaukee -> Nashville (long enough to stay ON_LOAD).
 *  seed-mix-brief.md rule 2: the intentional "watching, no phone on file"
 *  example — Owen never appears in targets.mjs's CAST_PHONES, so
 *  Driver.phone stays null and the real worker marks this one `attention`
 *  with "no driver or carrier phone on file", exactly as designed. */
function buildScenarioK(rand, { orgId, customer, nowMs, agentPolicyId }) {
  const owen = castByScenario("K");
  const built = commonInProgress(rand, { code: "K", orgId, homeHub: "Milwaukee", destHub: "Nashville", driverId: owen.id, requiredEquip: owen.equipmentTypes[0], customer, nowMs, startedHoursAgo: 2.5 });
  const pings = identicalStopPings(owen.id, built.origin, built.destination, 0.4, 25, nowMs);
  return { ...built, load: withWatching(built.load, agentPolicyId), pings, driverId: owen.id, simMode: "stopped" };
}

/** L — last ping 70 min old; SimDriverState "dark". Minneapolis -> Kansas
 *  City (long enough to stay ON_LOAD). */
function buildScenarioL(rand, { orgId, customer, nowMs }) {
  const ivy = castByScenario("L");
  const built = commonInProgress(rand, { code: "L", orgId, homeHub: "Minneapolis", destHub: "Kansas City", driverId: ivy.id, requiredEquip: ivy.equipmentTypes[0], customer, nowMs, startedHoursAgo: 2.5 });
  const pings = staleDarkPings(ivy.id, built.origin, built.destination, built.planFraction, 70, nowMs);
  return { ...built, pings, driverId: ivy.id, simMode: "dark" };
}

/** N — last 3 pings ~6 mi off the great-circle line; SimDriverState
 *  "offroute". St. Louis -> Omaha (long enough to stay ON_LOAD). */
function buildScenarioN(rand, { orgId, customer, nowMs }) {
  const petar = castByScenario("N");
  const built = commonInProgress(rand, { code: "N", orgId, homeHub: "St. Louis", destHub: "Omaha", driverId: petar.id, requiredEquip: petar.equipmentTypes[0], customer, nowMs, startedHoursAgo: 2.5 });
  const pings = offRoutePings(petar.id, built.origin, built.destination, built.planFraction, 6, nowMs);
  return { ...built, pings, driverId: petar.id, simMode: "offroute" };
}

/** M — completed, 220 min billable detention on a 120-min free window
 *  (total observed dwell 340 min = 120 free + 220 billable, comfortably
 *  clearing the test's ">200 min" bar). */
function buildScenarioM(rand, { orgId, customer, nowMs }) {
  const grace = castByScenario("M");
  const origin = hub("Kansas City");
  const destination = hub("Wichita");
  const daysAgo = 6;
  const plannedStart = new Date(nowMs - daysAgo * 24 * 60 * 60_000);
  const windowStart = new Date(plannedStart.getTime() + 4 * 60 * 60_000);
  const billableMin = 220;
  const freeMin = 120;
  const completedAtMs = windowStart.getTime() + (billableMin + freeMin + 15) * 60_000;
  const built = buildActiveLoad(rand, {
    code: "M", tag: null, orgId, origin, destination, requiredEquip: grace.equipmentTypes[0], customer,
    driverId: grace.id, plannedStart, plannedEnd: new Date(completedAtMs), status: "delivered",
    startedAt: plannedStart, completedAt: new Date(completedAtMs),
    deliveryWindowStart: windowStart, deliveryWindowEnd: new Date(windowStart.getTime() + (billableMin + freeMin) * 60_000),
    assignmentStatus: "completed",
  });
  const pings = buildDwellPings(grace.id, destination, { windowStartMs: windowStart.getTime(), billableMin, freeMin });
  return { ...built, pings, driverId: grace.id };
}

/**
 * Builds Ana's inbound trip + I, J, K, L, M, N. Returns the flat row arrays
 * plus `simDriverStates` (K/L/N) and `anaDriverId` (so scenarioLoads.mjs can
 * fold Ana into the same "busy cast driver" bookkeeping as I/J/K/L/N).
 */
export function buildActiveScenarios(rand, { orgId, customers, nowMs, agentPolicyId }) {
  const standard = customers.filter((c) => c.priority === "standard");
  const customerFor = (i) => standard[i % standard.length];

  const parts = [
    buildAnaInbound(rand, { orgId, customer: customerFor(7), nowMs, agentPolicyId }),
    buildScenarioI(rand, { orgId, customer: customerFor(8), nowMs, agentPolicyId }),
    buildScenarioJ(rand, { orgId, customer: customerFor(9), nowMs, agentPolicyId }),
    buildScenarioK(rand, { orgId, customer: customerFor(10), nowMs, agentPolicyId }),
    buildScenarioL(rand, { orgId, customer: customerFor(11), nowMs }),
    buildScenarioM(rand, { orgId, customer: customerFor(12), nowMs }),
    buildScenarioN(rand, { orgId, customer: customerFor(13), nowMs }),
  ];

  const loads = parts.map((p) => p.load);
  const stops = parts.flatMap((p) => p.stops);
  const appointments = parts.flatMap((p) => p.appointments);
  const assignments = parts.map((p) => p.assignment);
  const driverLocations = parts.flatMap((p) => p.pings ?? []);
  const agentTrips = parts.flatMap((p) => p.agentTrips ?? []);
  const agentEvents = parts.flatMap((p) => p.agentEvents ?? []);
  // modeUntil: null — K/L/N's perturbation (stopped/dark/offroute) holds
  // indefinitely until a dispatcher changes the mode or presses Reset, not
  // just for a fixed window after seeding. A demo pressed Start well over an
  // hour after seeding must still see all three behaviours on tick 1.
  const simDriverStates = parts
    .filter((p) => p.simMode)
    .map((p) => ({ driverId: p.driverId, mode: p.simMode, modeUntil: null, offsetLat: 0, offsetLng: 0 }));

  // Busy drivers (ON_LOAD/AVAILABLE_SOON, per scenarioLoads.mjs's
  // DriverAvailability pass) — everyone here except Grace (M's load is
  // COMPLETED, not active; she is simply available afterward, like any
  // other free cast driver). "assigned" counts as busy here too, same as
  // activeStatuses.ts's ACTIVE_STATUSES treats it: Ana and Hassan already
  // have this load even though they haven't departed yet. Carries enough of
  // the projection — availableAt/available* = current load's last delivery
  // stop + plannedEnd — for scenarioLoads.mjs to stamp it without
  // re-deriving it.
  const busyDrivers = parts
    .filter((p) => p.assignment.status === "in_progress" || p.assignment.status === "assigned")
    .map((p) => ({ driverId: p.driverId, plannedEnd: p.assignment.plannedEnd, destination: p.destination }));

  return { loads, stops, appointments, assignments, driverLocations, agentTrips, agentEvents, simDriverStates, busyDrivers };
}
