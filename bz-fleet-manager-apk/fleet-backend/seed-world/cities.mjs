import { pick, randInt } from "./prng.mjs";

// ~25 Midwest / Great Lakes / Texas hubs — driver home bases, drawn from this
// one gazetteer-backed list with lat/lng. Every one of
// these coordinates is copied from src/lib/usCities.ts's own gazetteer
// (`inGazetteer: true` below is therefore true for all of them) so a
// driver's homeBaseCity/State always resolves through gazetteerLookup() —
// candidateContext.ts's home-time distance would silently go null for a
// home base the gazetteer can't find. Kalamazoo (below, separately) is
// deliberately NOT one of these hubs: it is only ever used as an in-transit
// stop address (scenario C), never a home base, so its absence from the
// gazetteer never matters.
export const HUBS = [
  { city: "Chicago", state: "IL", lat: 41.8781, lng: -87.6298, zip: "60601" },
  { city: "Detroit", state: "MI", lat: 42.3314, lng: -83.0458, zip: "48201" },
  { city: "Grand Rapids", state: "MI", lat: 42.9634, lng: -85.6681, zip: "49503" },
  { city: "Toledo", state: "OH", lat: 41.6528, lng: -83.5379, zip: "43604" },
  { city: "Cleveland", state: "OH", lat: 41.4993, lng: -81.6944, zip: "44113" },
  { city: "Columbus", state: "OH", lat: 39.9612, lng: -82.9988, zip: "43215" },
  { city: "Cincinnati", state: "OH", lat: 39.1031, lng: -84.512, zip: "45202" },
  { city: "Indianapolis", state: "IN", lat: 39.7684, lng: -86.1581, zip: "46204" },
  { city: "Fort Wayne", state: "IN", lat: 41.0793, lng: -85.1394, zip: "46802" },
  { city: "Milwaukee", state: "WI", lat: 43.0389, lng: -87.9065, zip: "53202" },
  { city: "Madison", state: "WI", lat: 43.0731, lng: -89.4012, zip: "53703" },
  { city: "Minneapolis", state: "MN", lat: 44.9778, lng: -93.265, zip: "55401" },
  { city: "St. Paul", state: "MN", lat: 44.9537, lng: -93.09, zip: "55101" },
  { city: "Des Moines", state: "IA", lat: 41.5868, lng: -93.625, zip: "50309" },
  { city: "Kansas City", state: "MO", lat: 39.0997, lng: -94.5786, zip: "64106" },
  { city: "St. Louis", state: "MO", lat: 38.627, lng: -90.1994, zip: "63101" },
  { city: "Omaha", state: "NE", lat: 41.2565, lng: -95.9345, zip: "68102" },
  { city: "Wichita", state: "KS", lat: 37.6872, lng: -97.3301, zip: "67202" },
  { city: "Louisville", state: "KY", lat: 38.2527, lng: -85.7585, zip: "40202" },
  { city: "Nashville", state: "TN", lat: 36.1627, lng: -86.7816, zip: "37203" },
  { city: "Memphis", state: "TN", lat: 35.1495, lng: -90.049, zip: "38103" },
  { city: "Dallas", state: "TX", lat: 32.7767, lng: -96.797, zip: "75201" },
  { city: "Fort Worth", state: "TX", lat: 32.7555, lng: -97.3308, zip: "76102" },
  { city: "Houston", state: "TX", lat: 29.7604, lng: -95.3698, zip: "77002" },
  { city: "San Antonio", state: "TX", lat: 29.4241, lng: -98.4936, zip: "78205" },
  { city: "Austin", state: "TX", lat: 30.2672, lng: -97.7431, zip: "78701" },
].map((h) => ({ ...h, inGazetteer: true }));

/** Scenario C's driver is in transit FROM Kalamazoo — a real Midwest city,
 *  but not one of the gazetteer's ~150 entries, and not a hub anyone's home
 *  base uses. Kept here (not inline in the scenario file) because every
 *  location's lat/lng belongs in cities.mjs regardless of gazetteer
 *  coverage. */
export const KALAMAZOO_MI = { city: "Kalamazoo", state: "MI", lat: 42.2917, lng: -85.5872, zip: "49007" };

const STREET_WORDS = [
  "Dock", "Freight", "Industrial", "Commerce", "Logistics", "Warehouse",
  "Distribution", "Terminal", "Rail", "Depot", "Harbor", "Yard",
];
const STREET_SUFFIXES = ["St", "Way", "Pkwy", "Dr", "Blvd", "Rd", "Ave"];

/** A plausible-looking, non-geocoded-to-a-real-dock street address in `hub`,
 *  formatted "<street>, <City>, <ST> <zip>" — the exact shape
 *  cityStateFromAddress (driverAvailability.ts) and geocode.ts's
 *  parseCityState need: a comma before the city, and "ST zip" as the final
 *  comma segment's first token. */
export function addressIn(rand, hub) {
  const number = randInt(rand, 100, 9899);
  const street = `${number} ${pick(rand, STREET_WORDS)} ${pick(rand, STREET_SUFFIXES)}`;
  return `${street}, ${hub.city}, ${hub.state} ${hub.zip}`;
}

export function randomHub(rand) {
  return pick(rand, HUBS);
}

/** The one HUBS entry named `city` — every scenario builder that places a
 *  load or a driver at a specific named hub (rather than a random one) shares
 *  this lookup instead of each re-implementing the same `.find()`. */
export function hub(city) {
  const found = HUBS.find((h) => h.city === city);
  if (!found) throw new Error(`cities.mjs: no hub "${city}"`);
  return found;
}

/** `count` distinct hubs (never the same city twice in one call) — used to
 *  build a lane's origin/destination without ever picking a zero-mile lane. */
export function distinctHubs(rand, count) {
  const chosen = [];
  const pool = [...HUBS];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(rand() * pool.length);
    chosen.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return chosen;
}
