import { askEvent, buildBrief, buildTrip, escalationEvent, replyEvent } from "./agentEvidence.mjs";
import { addressIn, hub } from "./cities.mjs";
import { tripEconomics, revenueForMiles } from "./economics.mjs";
import { pick, randInt, stableId } from "./prng.mjs";
import { atLocalTime } from "./time.mjs";
import {
  BORIS_ACCIDENTS, BORIS_BREAKDOWNS, BORIS_COMPLETED, CHIDI_ACCIDENTS, CHIDI_BREAKDOWNS, CHIDI_COMPLETED,
  DWAYNE_COMPLETED, DWAYNE_DELIVERED_EXTERNAL_IDS, DWAYNE_ESCALATIONS, DWAYNE_REPLIED, HISTORICAL_LOOKBACK_DAYS,
  MARCUS_LANE_RUNS, MILAN_COMPLETED, MILAN_ON_TIME, ORG_TIMEZONE, WORLD_LOAD_TAG,
} from "./targets.mjs";

// Exact-number dedicated history for Milan (scenario A), Dwayne (scenario
// B), and Boris/Chidi (breakdown/accident evidence) — every count here is
// chosen by INDEX, never by chance(), so a rerun with the same PRNG position
// reproduces the identical on-time/late, replied/unreplied and escalated/not
// split every time (on top of the generator's own byte-identical guarantee,
// this makes the exact counts trivially true by construction rather than
// something a statistical roll merely tends toward).
//
// Generic bulk history (history.mjs) still supplies the~3,000-load backdrop
// these four drivers' OWN numbers sit inside — see targets.mjs's
// NAMED_HISTORY_RESERVE.
const PICKUP_DWELL_MIN = 60;
const DELIVERY_DWELL_MIN = 60;
const ARRIVAL_BUFFER_MIN = 90;

function buildNamedLoad(rand, { tag, orgId, driver, customer, lane, nowMs, daysAgo, isLate }) {
  const externalId = `${WORLD_LOAD_TAG}${tag}`;
  const loadId = stableId(`load:${externalId}`);
  const plannedStart = atLocalTime(new Date(nowMs), ORG_TIMEZONE, randInt(rand, 6, 19), randInt(rand, 0, 59), -daysAgo);

  const base = tripEconomics(lane.origin, lane.destination, 0, { dwellMin: PICKUP_DWELL_MIN + DELIVERY_DWELL_MIN });
  const revenueCents = revenueForMiles(rand, base.loadedMi);
  const economics = { ...base, marginCents: Math.round(revenueCents * 0.18) };

  const scheduledArrivalMs = plannedStart.getTime() + economics.driveMin * 60_000;
  const windowEndMs = scheduledArrivalMs + ARRIVAL_BUFFER_MIN * 60_000;
  const completedAtMs = isLate ? windowEndMs + randInt(rand, 20, 240) * 60_000 : windowEndMs - randInt(rand, 15, ARRIVAL_BUFFER_MIN) * 60_000;

  const pickupStopId = stableId(`loadStop:${externalId}:1`);
  const deliveryStopId = stableId(`loadStop:${externalId}:2`);

  const load = {
    id: loadId, orgId, externalId, status: "delivered", requiredEquip: driver.equipmentTypes[0],
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
    { id: stableId(`appt:${externalId}:2`), stopId: deliveryStopId, windowStart: null, windowEnd: new Date(windowEndMs), type: "delivery", kind: "appointment" },
  ];
  const assignment = {
    id: stableId(`assignment:${externalId}`), orgId, loadId, driverId: driver.id,
    plannedStart, plannedEnd: new Date(completedAtMs),
    deadheadMi: 0, loadedMi: economics.loadedMi, marginCents: economics.marginCents, savedMi: economics.savedMi,
    driveMin: economics.driveMin, onDutyMin: economics.onDutyMin, tookBreak: economics.driveMin > 480,
    status: "completed", startedAt: plannedStart, completedAt: new Date(completedAtMs),
  };
  return { load, stops, appointments, assignment, externalId, loadId };
}

function emptyRows() {
  return { loads: [], stops: [], appointments: [], assignments: [], agentTrips: [], agentEvents: [] };
}

function push(rows, built) {
  rows.loads.push(built.load);
  rows.stops.push(...built.stops);
  rows.appointments.push(...built.appointments);
  rows.assignments.push(built.assignment);
}

/** Milan Petrovski: exactly MILAN_COMPLETED loads, the LAST MILAN_ON_TIME of
 *  them on time and the remainder late — deliberately index-driven (the
 *  final `MILAN_COMPLETED - MILAN_ON_TIME` loads are late) so the count is
 *  exact by construction. */
export function buildMilanHistory(rand, { orgId, driver, customers, lanes, nowMs }) {
  const rows = emptyRows();
  for (let i = 0; i < MILAN_COMPLETED; i++) {
    const isLate = i >= MILAN_ON_TIME;
    push(rows, buildNamedLoad(rand, {
      tag: `MILAN-${String(i + 1).padStart(3, "0")}`, orgId, driver,
      customer: pick(rand, customers), lane: pick(rand, lanes), nowMs,
      daysAgo: randInt(rand, 1, HISTORICAL_LOOKBACK_DAYS), isLate,
    }));
  }
  return rows;
}

/** Dwayne Okafor: DWAYNE_COMPLETED loads, each with exactly one AgentTrip
 *  carrying exactly one ASK. The first DWAYNE_REPLIED trips also get a REPLY
 *  (closing the question); of the rest, the first DWAYNE_ESCALATIONS also
 *  get a no-reply ESCALATION. -> opened=18, closed=11, responseRate ~0.611,
 *  noResponseIncidents=3 (driverResponseMetrics.ts's own per-trip state
 *  machine) — all of that evidence is unaffected by the mix rule below.
 *
 *  seed-mix-brief.md rule 3: history goes dark, except Dwayne's
 *  DWAYNE_DELIVERED_EXTERNAL_IDS (targets.mjs) — his three most recent
 *  "replied" loads — which keep `agentEnabled: true`/`agentPill:
 *  "delivered"`. Every other Dwayne load (the other 8 replied, all 3
 *  escalated, all 4 asked-only) goes `agentEnabled: false`/`agentPill:
 *  "off"`/`agentPolicyId: null`, same as every other historical load, while
 *  still carrying its trip/ask/reply/escalation evidence exactly as before.
 *  "Most recent" is true by construction: the three kept indices are forced
 *  to 1/2/3 days ago and every other index to at least 4, using the SAME
 *  randInt() draw every iteration either way — so the shared PRNG stream
 *  consumes exactly as many draws, in exactly the same order, as it did
 *  before this rule existed, and nothing downstream shifts. */
export function buildDwayneHistory(rand, { orgId, agentPolicyId, driver, customers, lanes, nowMs }) {
  const rows = emptyRows();
  for (let i = 0; i < DWAYNE_COMPLETED; i++) {
    const tag = `DWAYNE-${String(i + 1).padStart(3, "0")}`;
    const externalId = `${WORLD_LOAD_TAG}${tag}`;
    const keptIndex = DWAYNE_DELIVERED_EXTERNAL_IDS.indexOf(externalId);
    const isKeptEnabled = keptIndex >= 0;

    const customer = pick(rand, customers);
    const lane = pick(rand, lanes);
    const drawnDaysAgo = randInt(rand, 1, HISTORICAL_LOOKBACK_DAYS);
    const daysAgo = isKeptEnabled ? keptIndex + 1 : Math.max(drawnDaysAgo, DWAYNE_DELIVERED_EXTERNAL_IDS.length + 1);

    const built = buildNamedLoad(rand, { tag, orgId, driver, customer, lane, nowMs, daysAgo, isLate: false });
    // Decided up front (never mutated afterward): which bucket this load
    // falls in fixes its evidence set, independent of whether the load
    // itself stays "on" (isKeptEnabled) — those are two separate questions.
    const replied = i < DWAYNE_REPLIED;
    const escalated = !replied && i - DWAYNE_REPLIED < DWAYNE_ESCALATIONS;
    const withEvidence = isKeptEnabled
      ? { ...built.load, agentEnabled: true, agentPolicyId, agentPill: "delivered" }
      : { ...built.load, agentEnabled: false, agentPolicyId: null, agentPill: "off" };
    rows.loads.push(withEvidence);
    rows.stops.push(...built.stops);
    rows.appointments.push(...built.appointments);
    rows.assignments.push(built.assignment);

    const trip = buildTrip({
      loadRef: built.externalId, loadId: built.loadId,
      brief: buildBrief({
        loadRef: built.externalId, origin: { lat: 0, lng: 0, name: "origin" }, destination: { lat: 0, lng: 0, name: "destination" },
        equipment: driver.equipmentTypes[0], departAtMs: built.assignment.plannedStart.getTime(), deadlineAtMs: built.assignment.plannedEnd.getTime(),
        driverName: driver.name, driverPhone: "+15555550101",
      }),
      status: "closed",
    });
    const askAtMs = built.assignment.plannedStart.getTime() + 60 * 60_000;
    const ask = askEvent(trip.id, askAtMs, { anomalyKey: "no_word", rung: 1, channel: "sms", text: "Checking in — still good on this run?" });
    rows.agentTrips.push(trip);

    if (replied) {
      rows.agentEvents.push(ask, replyEvent(trip.id, askAtMs + randInt(rand, 5, 30) * 60_000, { rawText: "all good, on schedule", answersKey: "no_word" }));
    } else if (escalated) {
      rows.agentEvents.push(ask, escalationEvent(trip.id, askAtMs + 30 * 60_000, { reason: "no word unresolved after 2 calls", anomalyKey: "no_word" }));
    } else {
      rows.agentEvents.push(ask);
    }
  }
  return rows;
}

/** A dedicated driver whose replies carry `breakdownCount` "breakdown" and
 *  `accidentCount` "accident" situationKeys — 6 breakdowns and 2 accidents
 *  total, split (in targets.mjs) as 4+1 for Boris and 2+1 for Chidi. Each
 *  load gets exactly one ask+reply pair; which
 *  loads carry which situationKey is assigned by index, so the totals are
 *  exact by construction, not by chance. History goes dark (seed-mix-brief.md
 *  rule 1, no exception for Boris/Chidi): every one of these loads always
 *  stays `agentEnabled: false`/`agentPill: "off"`/`agentPolicyId: null`
 *  regardless of situationKey — the AgentTrip/ask/reply evidence for the
 *  breakdown/accident loads is still created exactly as before, since
 *  driverResponseMetrics.ts reads AgentEvent rows directly, never the load's
 *  own agentEnabled/agentPill. */
export function buildIncidentDriverHistory(rand, { orgId, driver, customers, lanes, nowMs, completedCount, breakdownCount, accidentCount, tagPrefix }) {
  const rows = emptyRows();
  for (let i = 0; i < completedCount; i++) {
    const built = buildNamedLoad(rand, {
      tag: `${tagPrefix}-${String(i + 1).padStart(3, "0")}`, orgId, driver,
      customer: pick(rand, customers), lane: pick(rand, lanes), nowMs,
      daysAgo: randInt(rand, 1, HISTORICAL_LOOKBACK_DAYS), isLate: false,
    });
    const situationKey = i < breakdownCount ? "breakdown" : i < breakdownCount + accidentCount ? "accident" : null;
    const withEvidence = { ...built.load, agentEnabled: false, agentPolicyId: null, agentPill: "off" };
    rows.loads.push(withEvidence);
    rows.stops.push(...built.stops);
    rows.appointments.push(...built.appointments);
    rows.assignments.push(built.assignment);

    if (situationKey === null) continue;
    const trip = buildTrip({
      loadRef: built.externalId, loadId: built.loadId,
      brief: buildBrief({
        loadRef: built.externalId, origin: { lat: 0, lng: 0, name: "origin" }, destination: { lat: 0, lng: 0, name: "destination" },
        equipment: driver.equipmentTypes[0], departAtMs: built.assignment.plannedStart.getTime(), deadlineAtMs: built.assignment.plannedEnd.getTime(),
        driverName: driver.name, driverPhone: "+15555550102",
      }),
      status: "closed",
    });
    const askAtMs = built.assignment.plannedStart.getTime() + 90 * 60_000;
    const text = situationKey === "breakdown" ? "truck broke down, pulling over" : "just got into a minor accident";
    rows.agentTrips.push(trip);
    rows.agentEvents.push(
      askEvent(trip.id, askAtMs, { anomalyKey: "dark", rung: 1, channel: "sms", text: "Check in?" }),
      replyEvent(trip.id, askAtMs + randInt(rand, 3, 15) * 60_000, { rawText: text, situationKey, answersKey: "dark" }),
    );
  }
  return rows;
}

export function buildBorisHistory(rand, args) {
  return buildIncidentDriverHistory(rand, { ...args, completedCount: BORIS_COMPLETED, breakdownCount: BORIS_BREAKDOWNS, accidentCount: BORIS_ACCIDENTS, tagPrefix: "BORIS" });
}

export function buildChidiHistory(rand, args) {
  return buildIncidentDriverHistory(rand, { ...args, completedCount: CHIDI_COMPLETED, breakdownCount: CHIDI_BREAKDOWNS, accidentCount: CHIDI_ACCIDENTS, tagPrefix: "CHIDI" });
}

/**
 * Marcus Webb (scenario F): MARCUS_LANE_RUNS completed loads, all on the
 * FIXED Chicago -> Nashville lane (the identical hub coordinates
 * scenarioOpen.mjs's W-F-LANE load uses), so laneKey() computes the exact
 * same string for all of them and laneRunsByDriver(orgId, thatKey) reports
 * exactly MARCUS_LANE_RUNS for him — no agent evidence needed, only volume
 * on one lane.
 */
export function buildMarcusHistory(rand, { orgId, driver, customers, nowMs }) {
  const rows = emptyRows();
  const lane = { origin: hub("Chicago"), destination: hub("Nashville") };
  for (let i = 0; i < MARCUS_LANE_RUNS; i++) {
    push(rows, buildNamedLoad(rand, {
      tag: `MARCUS-${String(i + 1).padStart(3, "0")}`, orgId, driver, lane,
      customer: pick(rand, customers), nowMs, daysAgo: randInt(rand, 1, HISTORICAL_LOOKBACK_DAYS), isLate: false,
    }));
  }
  return rows;
}
