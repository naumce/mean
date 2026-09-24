import { HUBS } from "./cities.mjs";
import { stableId } from "./prng.mjs";

// The scenario cast — always created in full, regardless of scale: 13
// drivers each realizing one lettered scenario (H needs a customer, not a
// driver, so it has none) plus 2 more — Boris/Chidi — whose job is purely to
// carry the "6 breakdowns / 2 accidents on specific ... drivers" reply
// evidence and are never referenced by a scenario letter.
//
// Identity is fully hand-fixed here (never PRNG-derived) so a rerun's
// `stableId("driver:" + externalId)` reproduces the exact same row id every
// time — the seed-world test's "identical scenario driver ids across two
// runs" check depends on this. Bulk drivers (drivers.mjs) use a disjoint
// "WD-BULK-" externalId/email namespace, so a cast identity can never
// collide with a randomly-drawn bulk one.
function hubByCity(city) {
  const hub = HUBS.find((h) => h.city === city);
  if (!hub) throw new Error(`cast.mjs: no hub named "${city}" in cities.mjs`);
  return hub;
}

// HOS defaults for cast members whose scenario doesn't hinge on their clock.
// Ray Delgado (D) is the one deliberate exception (90 min drive remaining,
// verbatim from the brief).
const FRESH_HOS = { driveRemainingMin: 480, windowRemainingMin: 600, cycleRemainingMin: 3000, minutesSinceBreak: 120 };

const RAW_CAST = [
  { key: "milan", scenarioCode: "A", first: "Milan", last: "Petrovski", homeCity: "Toledo", equipmentTypes: ["DryVan"], yearsExperience: 12 },
  { key: "dwayne", scenarioCode: "B", first: "Dwayne", last: "Okafor", homeCity: "Toledo", equipmentTypes: ["DryVan"], yearsExperience: 6 },
  { key: "ana", scenarioCode: "C", first: "Ana", last: "Kovacs", homeCity: "Detroit", equipmentTypes: ["DryVan"], yearsExperience: 8 },
  { key: "ray", scenarioCode: "D", first: "Ray", last: "Delgado", homeCity: "Detroit", equipmentTypes: ["DryVan"], yearsExperience: 15, hos: { driveRemainingMin: 90, windowRemainingMin: 180, cycleRemainingMin: 1200, minutesSinceBreak: 480 } },
  { key: "tomasz", scenarioCode: "E", first: "Tomasz", last: "Nowak", homeCity: "Cleveland", equipmentTypes: ["Flatbed"], yearsExperience: 10 },
  { key: "marcus", scenarioCode: "F", first: "Marcus", last: "Webb", homeCity: "Chicago", equipmentTypes: ["DryVan"], yearsExperience: 9 },
  { key: "lena", scenarioCode: "G", first: "Lena", last: "Fischer", homeCity: "Grand Rapids", equipmentTypes: ["DryVan"], yearsExperience: 7, homeTimeTarget: "weekend" },
  { key: "hassan", scenarioCode: "I", first: "Hassan", last: "Farah", homeCity: "Columbus", equipmentTypes: ["DryVan"], yearsExperience: 5 },
  { key: "wei", scenarioCode: "J", first: "Wei", last: "Chen", homeCity: "Indianapolis", equipmentTypes: ["DryVan"], yearsExperience: 4 },
  { key: "owen", scenarioCode: "K", first: "Owen", last: "Bracken", homeCity: "Milwaukee", equipmentTypes: ["DryVan"], yearsExperience: 11 },
  { key: "ivy", scenarioCode: "L", first: "Ivy", last: "Novak", homeCity: "Minneapolis", equipmentTypes: ["Reefer"], yearsExperience: 6 },
  { key: "grace", scenarioCode: "M", first: "Grace", last: "Adeyemi", homeCity: "Kansas City", equipmentTypes: ["DryVan"], yearsExperience: 9 },
  { key: "petar", scenarioCode: "N", first: "Petar", last: "Ilic", homeCity: "St. Louis", equipmentTypes: ["DryVan"], yearsExperience: 8 },
  { key: "boris", scenarioCode: null, first: "Boris", last: "Yankov", homeCity: "Louisville", equipmentTypes: ["DryVan"], yearsExperience: 14 },
  { key: "chidi", scenarioCode: null, first: "Chidi", last: "Okonkwo", homeCity: "Nashville", equipmentTypes: ["DryVan"], yearsExperience: 13 },
];

/** Fully-resolved cast records: identity (email/externalId/id), home base
 *  coordinates (from cities.mjs's gazetteer-backed hub list), and HOS —
 *  everything drivers.mjs needs to write the Driver/HosState rows, and
 *  everything scenarioLoads.mjs/history.mjs need to reference the right
 *  driver by `.key`. */
export const CAST = RAW_CAST.map((c) => {
  const hub = hubByCity(c.homeCity);
  const externalId = `WD-CAST-${c.key.toUpperCase()}`;
  const email = `wd-cast-${c.key}@greatlakes.demo`;
  return {
    key: c.key,
    scenarioCode: c.scenarioCode,
    name: `${c.first} ${c.last}`,
    firstName: c.first,
    lastName: c.last,
    email,
    externalId,
    id: stableId(`driver:${externalId}`),
    homeBaseCity: hub.city,
    homeBaseState: hub.state,
    homeBaseLat: hub.lat,
    homeBaseLng: hub.lng,
    equipmentTypes: c.equipmentTypes,
    yearsExperience: c.yearsExperience,
    homeTimeTarget: c.homeTimeTarget ?? null,
    hos: c.hos ?? FRESH_HOS,
  };
});

export function castByKey(key) {
  const found = CAST.find((c) => c.key === key);
  if (!found) throw new Error(`cast.mjs: no cast member with key "${key}"`);
  return found;
}

export function castByScenario(code) {
  const found = CAST.find((c) => c.scenarioCode === code);
  if (!found) throw new Error(`cast.mjs: no cast member for scenario "${code}"`);
  return found;
}
