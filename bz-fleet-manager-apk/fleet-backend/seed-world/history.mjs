import { askEvent, buildBrief, buildTrip, escalationEvent, replyEvent } from "./agentEvidence.mjs";
import { addressIn } from "./cities.mjs";
import { buildDwellPings } from "./detention.mjs";
import { tripEconomics, revenueForMiles } from "./economics.mjs";
import { chance, pick, randInt, stableId } from "./prng.mjs";
import { atLocalTime } from "./time.mjs";
import {
  DETENTION_RATE, ESCALATION_RATE, HISTORICAL_LOOKBACK_DAYS, LATE_MAX_MINUTES, LATE_MIN_MINUTES,
  LATE_RATE, NIGHT_LOAD_RATE, ORG_TIMEZONE, REPLY_GIVEN_RATE, TRIP_RATE, WORLD_LOAD_TAG,
} from "./targets.mjs";

// Generic bulk historical loads: ~3,000 historical loads over the past 180
// days across ~60 lanes; ~12% late by 20-240 min; ~15% with detention
// evidence; ~20% with an AgentTrip + AgentEvents, of which ~8% are no-reply
// escalations; ~10% night loads. Milan/Dwayne/Boris/Chidi's EXACT-number
// dedicated history lives in namedHistory.mjs instead — this file only ever
// produces the approximate, PRNG-driven bulk.
//
// Compute-then-write: this whole module is synchronous and returns plain
// row arrays; seed-world.mjs does the actual createMany calls.
const PICKUP_DWELL_MIN = 60;
const DELIVERY_DWELL_MIN = 60;
const ARRIVAL_BUFFER_MIN = 90;
const NIGHT_HOURS = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5];

function pickupHour(rand, isNight) {
  return isNight ? pick(rand, NIGHT_HOURS) : randInt(rand, 6, 19);
}

/** One completed load + its stops/appointments/assignment, and (sometimes)
 *  detention pings and/or agent-trip evidence. `externalId` and every id
 *  derived from it, so a rerun with the same index reproduces the identical
 *  row set. */
function buildOneHistoricalLoad(rand, { index, orgId, driver, customer, lane, nowMs }) {
  const externalId = `${WORLD_LOAD_TAG}HIST-${String(index + 1).padStart(6, "0")}`;
  const loadId = stableId(`load:${externalId}`);
  const daysAgo = randInt(rand, 1, HISTORICAL_LOOKBACK_DAYS);
  const isNight = chance(rand, NIGHT_LOAD_RATE);
  const plannedStart = atLocalTime(new Date(nowMs), ORG_TIMEZONE, pickupHour(rand, isNight), randInt(rand, 0, 59), -daysAgo);

  const requiredEquip = driver.equipmentTypes[0];
  const baseEconomics = tripEconomics(lane.origin, lane.destination, 0, { dwellMin: PICKUP_DWELL_MIN + DELIVERY_DWELL_MIN });
  const revenueCents = revenueForMiles(rand, baseEconomics.loadedMi);
  // A new object with the real revenue-derived margin, rather than mutating
  // the one tripEconomics returned (it computed marginCents from the
  // placeholder revenueCents:0 passed in above, before revenue was known).
  const economics = { ...baseEconomics, marginCents: Math.round(revenueCents * 0.18) };

  const scheduledArrivalMs = plannedStart.getTime() + economics.driveMin * 60_000;
  const windowEndMs = scheduledArrivalMs + ARRIVAL_BUFFER_MIN * 60_000;
  const isLate = chance(rand, LATE_RATE);
  const completedAtMs = isLate
    ? windowEndMs + randInt(rand, LATE_MIN_MINUTES, LATE_MAX_MINUTES) * 60_000
    : scheduledArrivalMs + randInt(rand, 0, ARRIVAL_BUFFER_MIN) * 60_000;

  const pickupStopId = stableId(`loadStop:${externalId}:1`);
  const deliveryStopId = stableId(`loadStop:${externalId}:2`);
  const hasDetention = chance(rand, DETENTION_RATE);
  // A detention claim needs a windowSTART to measure against (detentionClaim
  // refuses without one) — only stamped when this load actually carries
  // detention evidence; every other historical load's delivery appointment
  // stays windowStart: null, matching how a plain "must arrive by" window
  // (no promised start) reads in the real product.
  const deliveryWindowStartMs = hasDetention ? scheduledArrivalMs : null;

  const load = {
    id: loadId, orgId, externalId, status: "delivered", requiredEquip,
    revenueCents, fscCents: Math.round(revenueCents * 0.1),
    customerName: customer.name, customerEmail: customer.primaryEmail, customerId: customer.id,
    agentEnabled: false, agentPolicyId: null, agentPill: "off",
  };
  const stops = [
    { id: pickupStopId, loadId, sequence: 1, type: "pickup", address: addressIn(rand, lane.origin), lat: lane.origin.lat, lng: lane.origin.lng, geocodeStatus: "ok", dwellMin: PICKUP_DWELL_MIN },
    { id: deliveryStopId, loadId, sequence: 2, type: "delivery", address: addressIn(rand, lane.destination), lat: lane.destination.lat, lng: lane.destination.lng, geocodeStatus: "ok", dwellMin: DELIVERY_DWELL_MIN },
  ];
  const appointments = [
    { id: stableId(`appt:${externalId}:1`), stopId: pickupStopId, windowStart: null, windowEnd: plannedStart, type: "pickup", kind: "appointment" },
    { id: stableId(`appt:${externalId}:2`), stopId: deliveryStopId, windowStart: deliveryWindowStartMs === null ? null : new Date(deliveryWindowStartMs), windowEnd: new Date(windowEndMs), type: "delivery", kind: "appointment" },
  ];
  const assignment = {
    id: stableId(`assignment:${externalId}`), orgId, loadId, driverId: driver.id,
    plannedStart, plannedEnd: new Date(completedAtMs),
    deadheadMi: 0, loadedMi: economics.loadedMi, marginCents: economics.marginCents, savedMi: economics.savedMi,
    driveMin: economics.driveMin, onDutyMin: economics.onDutyMin, tookBreak: economics.driveMin > 480,
    status: "completed", startedAt: plannedStart, completedAt: new Date(completedAtMs),
  };

  const driverLocations = hasDetention
    ? buildDwellPings(driver.id, lane.destination, { windowStartMs: deliveryWindowStartMs, billableMin: randInt(rand, 30, 150), freeMin: 120 })
    : [];

  // Agent evidence: a single roll decides the whole shape (never two
  // independent rolls that could double- or under-count), realizing
  // ESCALATION_RATE as a strict subset of TRIP_RATE per targets.mjs's own
  // header comment. History goes dark (seed-mix-brief.md rule 1): every one
  // of these loads is COMPLETED, so the load itself always stays
  // `agentEnabled: false`/`agentPill: "off"`/`agentPolicyId: null` regardless
  // of what its trip looked like — only Dwayne's three named exceptions
  // (namedHistory.mjs) ever keep a historical load "on". The AgentTrip/
  // AgentEvent rows below are still created exactly as before: driver
  // metrics, history, and the drawer all read this evidence directly, never
  // through the load's own agentEnabled/agentPill.
  const roll = rand();
  let agentTrips = [];
  let agentEvents = [];
  if (roll < ESCALATION_RATE || roll < TRIP_RATE) {
    const hasEscalation = roll < ESCALATION_RATE;
    const trip = buildTrip({
      loadRef: externalId, loadId,
      brief: buildBrief({
        loadRef: externalId, origin: { ...lane.origin, name: `${lane.origin.city}, ${lane.origin.state}` },
        destination: { ...lane.destination, name: `${lane.destination.city}, ${lane.destination.state}` },
        equipment: requiredEquip, departAtMs: plannedStart.getTime(), deadlineAtMs: windowEndMs,
        driverName: driver.name, driverPhone: "+15555550100",
      }),
      status: "closed",
    });
    const askAtMs = plannedStart.getTime() + economics.driveMin * 30_000; // roughly mid-trip
    const ask = askEvent(trip.id, askAtMs, { anomalyKey: "no_word", rung: 1, channel: "sms", text: "You still on schedule?" });
    agentTrips = [trip];
    if (hasEscalation) {
      agentEvents = [ask, escalationEvent(trip.id, askAtMs + 20 * 60_000, { reason: "no word unresolved after 2 calls", anomalyKey: "no_word" })];
    } else {
      const hasReply = chance(rand, REPLY_GIVEN_RATE);
      agentEvents = hasReply
        ? [ask, replyEvent(trip.id, askAtMs + randInt(rand, 3, 20) * 60_000, { rawText: "yep, on my way", answersKey: "no_word" })]
        : [ask];
    }
  }

  return { load, stops, appointments, assignment, driverLocations, agentTrips, agentEvents };
}

/** `count` generic historical loads, spread across `drivers`/`customers`/
 *  `lanes` by independent PRNG draws per load. Returns flat arrays ready for
 *  createMany. */
export function buildGenericHistory(rand, { orgId, drivers, customers, lanes, nowMs, count, startIndex = 0 }) {
  const loads = []; const stops = []; const appointments = []; const assignments = [];
  const driverLocations = []; const agentTrips = []; const agentEvents = [];

  for (let i = 0; i < count; i++) {
    const built = buildOneHistoricalLoad(rand, {
      index: startIndex + i, orgId,
      driver: pick(rand, drivers), customer: pick(rand, customers), lane: pick(rand, lanes), nowMs,
    });
    loads.push(built.load);
    stops.push(...built.stops);
    appointments.push(...built.appointments);
    assignments.push(built.assignment);
    driverLocations.push(...built.driverLocations);
    agentTrips.push(...built.agentTrips);
    agentEvents.push(...built.agentEvents);
  }
  return { loads, stops, appointments, assignments, driverLocations, agentTrips, agentEvents };
}
