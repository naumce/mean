import { castByScenario } from "./cast.mjs";
import { addressIn, hub } from "./cities.mjs";
import { destinationPoint } from "./geo.mjs";
import { stableId } from "./prng.mjs";
import { scenarioByCode } from "./scenarios.mjs";
import { atLocalTime, hoursFromNow, nextWeekdayAtLocalTime } from "./time.mjs";
import { MERIDIAN_FOODS_NAME } from "./customers.mjs";
import { ORG_TIMEZONE } from "./targets.mjs";

// The 8 "open, uncovered" lettered scenarios (A B C D E F G H) — each is one
// open Load a dispatcher is looking at, plus (for A/B/D/E/F) a specific cast
// driver placed at an exact distance from the pickup and left AVAILABLE.
// Ana (C)/Meridian Foods (H) need no positioning: C's candidate is covered
// by scenarioActive.mjs's Ana-inbound trip, and H is about the CUSTOMER, not
// a driver.

function customerByName(customers, name) {
  const found = customers.find((c) => c.name === name);
  if (!found) throw new Error(`scenarioOpen.mjs: no customer "${name}"`);
  return found;
}

function extrasFor(code) {
  const s = scenarioByCode(code);
  return { scenario: { code: s.code, title: s.title, hint: s.hint } };
}

function buildOpenLoad(rand, { code, orgId, pickup, delivery, requiredEquip, customer, pickupWindow, deliveryWindow }) {
  const s = scenarioByCode(code);
  const externalId = s.externalId;
  const loadId = stableId(`load:${externalId}`);
  const pickupStopId = stableId(`loadStop:${externalId}:1`);
  const deliveryStopId = stableId(`loadStop:${externalId}:2`);

  const load = {
    id: loadId, orgId, externalId, status: "open", requiredEquip,
    revenueCents: 0, fscCents: 0,
    customerName: customer.name, customerEmail: customer.primaryEmail, customerId: customer.id,
    agentEnabled: false, agentPolicyId: null, agentPill: "off",
    extras: extrasFor(code),
  };
  const stops = [
    { id: pickupStopId, loadId, sequence: 1, type: "pickup", address: addressIn(rand, pickup), lat: pickup.lat, lng: pickup.lng, geocodeStatus: "ok", dwellMin: 60 },
    { id: deliveryStopId, loadId, sequence: 2, type: "delivery", address: addressIn(rand, delivery), lat: delivery.lat, lng: delivery.lng, geocodeStatus: "ok", dwellMin: 60 },
  ];
  const appointments = [
    { id: stableId(`appt:${externalId}:1`), stopId: pickupStopId, windowStart: pickupWindow.start ?? null, windowEnd: pickupWindow.end, type: "pickup", kind: "appointment" },
    { id: stableId(`appt:${externalId}:2`), stopId: deliveryStopId, windowStart: deliveryWindow.start ?? null, windowEnd: deliveryWindow.end, type: "delivery", kind: "appointment" },
  ];
  return { load, stops, appointments };
}

/** Places a cast driver `distanceMi` from `point` at bearing `bearingDeg`,
 *  returning the coordinate — the caller stamps it onto the driver's
 *  lastLat/lastLng (current.mjs applies these as overrides on top of the
 *  driver's home-base default). Exact by construction (destinationPoint is
 *  haversineMi's own inverse), so the seed-world test's
 *  `haversineMi(position, pickup) ~= distanceMi` check passes to floating-
 *  point precision, not just "close enough". */
function positionNear(point, bearingDeg, distanceMi) {
  return destinationPoint(point, bearingDeg, distanceMi);
}

/**
 * Builds A, B, D, E, F, G, H, and the OPEN half of C (W-C-SOON — Ana's own
 * in_progress inbound trip is scenarioActive.mjs's job). Returns
 * `{ loads, stops, appointments, driverPositions }`, where `driverPositions`
 * is `{ [driverId]: {lat,lng} }` for every cast driver this file positions.
 */
export function buildOpenScenarios(rand, { orgId, customers, nowMs }) {
  const loads = []; const stops = []; const appointments = [];
  const driverPositions = {};
  const push = (built) => { loads.push(built.load); stops.push(...built.stops); appointments.push(...built.appointments); };

  const toledo = hub("Toledo");
  const cleveland = hub("Cleveland");
  const columbus = hub("Columbus");
  const detroit = hub("Detroit");
  const chicago = hub("Chicago");
  const nashville = hub("Nashville");
  const grandRapids = hub("Grand Rapids");
  const milwaukee = hub("Milwaukee");

  const standard = customers.filter((c) => c.priority === "standard");
  const customerFor = (i) => standard[i % standard.length];

  // A — Toledo pickup, Milan 40 mi away, AVAILABLE, 96% on-time (from his
  // dedicated history in namedHistory.mjs).
  const milan = castByScenario("A");
  push(buildOpenLoad(rand, {
    code: "A", orgId, pickup: toledo, delivery: cleveland, requiredEquip: "DryVan", customer: customerFor(0),
    pickupWindow: { start: hoursFromNow(nowMs, 6), end: hoursFromNow(nowMs, 30) },
    deliveryWindow: { end: hoursFromNow(nowMs, 40) },
  }));
  driverPositions[milan.id] = positionNear(toledo, 250, 40);

  // B — same load area (Toledo), Dwayne 15 mi away, AVAILABLE, spotty
  // response history (from his dedicated history).
  const dwayne = castByScenario("B");
  push(buildOpenLoad(rand, {
    code: "B", orgId, pickup: toledo, delivery: columbus, requiredEquip: "DryVan", customer: customerFor(1),
    pickupWindow: { start: hoursFromNow(nowMs, 6), end: hoursFromNow(nowMs, 30) },
    deliveryWindow: { end: hoursFromNow(nowMs, 40) },
  }));
  driverPositions[dwayne.id] = positionNear(toledo, 100, 15);

  // C (open half) — Detroit pickup at exactly 12:00 local, tomorrow.
  const cPickupStart = atLocalTime(new Date(nowMs), ORG_TIMEZONE, 11, 30, 1);
  const cPickupEnd = atLocalTime(new Date(nowMs), ORG_TIMEZONE, 12, 0, 1);
  push(buildOpenLoad(rand, {
    code: "C", orgId, pickup: detroit, delivery: columbus, requiredEquip: "DryVan", customer: customerFor(2),
    pickupWindow: { start: cPickupStart, end: cPickupEnd },
    deliveryWindow: { end: hoursFromNow(nowMs, 34) },
  }));

  // D — Detroit pickup, Ray 10 mi away, AVAILABLE, HOS-limited (90 min
  // drive remaining — set on his cast HOS).
  const ray = castByScenario("D");
  push(buildOpenLoad(rand, {
    code: "D", orgId, pickup: detroit, delivery: toledo, requiredEquip: "DryVan", customer: customerFor(3),
    pickupWindow: { end: hoursFromNow(nowMs, 24) },
    deliveryWindow: { end: hoursFromNow(nowMs, 34) },
  }));
  driverPositions[ray.id] = positionNear(detroit, 300, 10);

  // E — Cleveland pickup, Reefer required; Tomasz is the CLOSEST driver (6
  // mi) but Flatbed-only (set on his cast equipmentTypes).
  const tomasz = castByScenario("E");
  push(buildOpenLoad(rand, {
    code: "E", orgId, pickup: cleveland, delivery: columbus, requiredEquip: "Reefer", customer: customerFor(4),
    pickupWindow: { end: hoursFromNow(nowMs, 24) },
    deliveryWindow: { end: hoursFromNow(nowMs, 34) },
  }));
  driverPositions[tomasz.id] = positionNear(cleveland, 60, 6);

  // F — Chicago -> Nashville, verbatim lane; Marcus has run it 14 times
  // (dedicated history, namedHistory.mjs).
  const marcus = castByScenario("F");
  push(buildOpenLoad(rand, {
    code: "F", orgId, pickup: chicago, delivery: nashville, requiredEquip: "DryVan", customer: customerFor(5),
    pickupWindow: { end: hoursFromNow(nowMs, 24) },
    deliveryWindow: { end: hoursFromNow(nowMs, 44) },
  }));
  driverPositions[marcus.id] = positionNear(chicago, 320, 20);

  // G — delivers to Grand Rapids on Friday; Lena's home base (Grand Rapids)
  // and homeTimeTarget "weekend" make this an obvious home-time match.
  const lena = castByScenario("G");
  const gDeliveryStart = nextWeekdayAtLocalTime(new Date(nowMs), ORG_TIMEZONE, 5, 14, 0); // Friday 14:00
  const gDeliveryEnd = nextWeekdayAtLocalTime(new Date(nowMs), ORG_TIMEZONE, 5, 18, 0); // Friday 18:00
  push(buildOpenLoad(rand, {
    code: "G", orgId, pickup: chicago, delivery: grandRapids, requiredEquip: "DryVan", customer: customerFor(6),
    pickupWindow: { end: hoursFromNow(nowMs, 20) },
    deliveryWindow: { start: gDeliveryStart, end: gDeliveryEnd },
  }));
  driverPositions[lena.id] = { lat: lena.homeBaseLat, lng: lena.homeBaseLng };

  // H — high-priority customer (Meridian Foods), requiresDelayNotification.
  // No dedicated driver: this scenario is about the CUSTOMER row, not a
  // candidate.
  push(buildOpenLoad(rand, {
    code: "H", orgId, pickup: chicago, delivery: milwaukee, requiredEquip: "DryVan", customer: customerByName(customers, MERIDIAN_FOODS_NAME),
    pickupWindow: { end: hoursFromNow(nowMs, 24) },
    deliveryWindow: { end: hoursFromNow(nowMs, 34) },
  }));

  return { loads, stops, appointments, driverPositions };
}
