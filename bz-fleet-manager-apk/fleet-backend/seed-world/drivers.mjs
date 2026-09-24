import { CAST } from "./cast.mjs";
import { randomHub } from "./cities.mjs";
import { LAST_NAMES, FIRST_NAMES, SECOND_LANGUAGES, randomFullName } from "./names.mjs";
import { chance, pick, pickWeighted, randInt, stableId } from "./prng.mjs";
import { EQUIPMENT_MIX, HAZMAT_RATE, SECOND_LANGUAGE_RATE } from "./targets.mjs";

// Builds the driver ROSTER as plain specs (no DB, no orgId yet) — the cast
// (cast.mjs, fixed) plus `bulkCount` randomly-generated drivers. Every spec
// has the same shape regardless of origin, so drivers.mjs's own row-builders
// below (and current.mjs/history.mjs downstream) never need to branch on
// "is this a cast driver".
//
// Intentionally unused here beyond re-export: FIRST_NAMES/LAST_NAMES aren't
// read directly (randomFullName already closes over them) — re-exporting
// keeps this the one place a caller would look for "the driver name pool".
export { FIRST_NAMES, LAST_NAMES };

const CENTRAL_STATES = new Set(["IL", "WI", "MN", "IA", "MO", "KS", "TX"]);

function timezoneForState(state) {
  return CENTRAL_STATES.has(state) ? "America/Chicago" : "America/Detroit";
}

function bulkExternalId(index) {
  return `WD-BULK-${String(index + 1).padStart(4, "0")}`;
}

function castToSpec(cast) {
  return {
    id: cast.id,
    email: cast.email,
    externalId: cast.externalId,
    name: cast.name,
    firstName: cast.firstName,
    lastName: cast.lastName,
    homeBaseCity: cast.homeBaseCity,
    homeBaseState: cast.homeBaseState,
    homeLat: cast.homeBaseLat,
    homeLng: cast.homeBaseLng,
    equipmentTypes: cast.equipmentTypes,
    hazmatEndorsed: false,
    endorsements: [],
    languages: ["en"],
    preferredLanguage: "en",
    yearsExperience: cast.yearsExperience,
    timezone: timezoneForState(cast.homeBaseState),
    locationSharingEnabled: true,
    hos: cast.hos,
    homeTimeTarget: cast.homeTimeTarget,
    isCast: true,
    castKey: cast.key,
    scenarioCode: cast.scenarioCode,
  };
}

function bulkSpec(rand, index) {
  const hub = randomHub(rand);
  const { full } = randomFullName(rand);
  const equipmentTypes = [pickWeighted(rand, EQUIPMENT_MIX)];
  const hazmatEndorsed = chance(rand, HAZMAT_RATE);
  const hasSecondLanguage = chance(rand, SECOND_LANGUAGE_RATE);
  const secondLanguage = hasSecondLanguage ? pick(rand, SECOND_LANGUAGES) : null;
  const languages = secondLanguage ? ["en", secondLanguage] : ["en"];
  const preferredLanguage = secondLanguage && chance(rand, 0.3) ? secondLanguage : "en";
  const endorsements = [
    ...(hazmatEndorsed ? ["H"] : []),
    ...(equipmentTypes[0] === "Tanker" ? ["N"] : []),
  ];
  const externalId = bulkExternalId(index);

  return {
    id: stableId(`driver:${externalId}`),
    email: `wd-bulk-${String(index + 1).padStart(4, "0")}@greatlakes.demo`,
    externalId,
    name: full,
    firstName: full.split(" ")[0],
    lastName: full.split(" ").slice(1).join(" ") || full,
    homeBaseCity: hub.city,
    homeBaseState: hub.state,
    homeLat: hub.lat,
    homeLng: hub.lng,
    equipmentTypes,
    hazmatEndorsed,
    endorsements,
    languages,
    preferredLanguage,
    yearsExperience: randInt(rand, 1, 25),
    timezone: timezoneForState(hub.state),
    locationSharingEnabled: chance(rand, 0.8),
    hos: randomHos(rand),
    homeTimeTarget: pick(rand, [null, null, null, "weekend", "none"]),
    isCast: false,
    castKey: null,
    scenarioCode: null,
  };
}

function randomHos(rand) {
  const driveRemainingMin = randInt(rand, 0, 660);
  return {
    driveRemainingMin,
    windowRemainingMin: Math.min(840, driveRemainingMin + randInt(rand, 0, 180)),
    cycleRemainingMin: randInt(rand, 300, 4200),
    minutesSinceBreak: randInt(rand, 0, 480),
  };
}

/** The whole roster: 15 cast + `bulkCount` bulk specs. Pure and synchronous —
 *  every random draw happens here, before any DB call (seed-world.mjs's
 *  compute-then-write rule). */
export function buildDriverRoster(rand, bulkCount) {
  const cast = CAST.map(castToSpec);
  const bulk = Array.from({ length: bulkCount }, (_, i) => bulkSpec(rand, i));
  return [...cast, ...bulk];
}

// A single fixed bcrypt hash (bcrypt("seedseed", 10), pre-computed) reused
// for every driver — the existing seeds' own pattern (seed-control-tower.mjs,
// seed-demo.mjs's mkDetentionDriver): none of these ~163 accounts need a
// real login in any test, so paying bcrypt's ~80ms per call ~163 times would
// be pure waste (ruling 7's performance budget matters far more here than a
// hash nobody verifies).
const FIXED_DRIVER_PASSWORD_HASH = "$2b$10$seedseedseedseedseedse.seedseedseedseedseedseedseedse";

export function driverRows(specs, orgId, nowMs) {
  return specs.map((s) => ({
    id: s.id,
    email: s.email,
    passwordHash: FIXED_DRIVER_PASSWORD_HASH,
    name: s.name,
    firstName: s.firstName,
    lastName: s.lastName,
    status: "offline",
    orgId,
    externalId: s.externalId,
    cdlClass: "A",
    hazmatEndorsed: s.hazmatEndorsed,
    endorsements: s.endorsements,
    equipmentTypes: s.equipmentTypes,
    homeBase: `${s.homeBaseCity}, ${s.homeBaseState}`,
    homeBaseCity: s.homeBaseCity,
    homeBaseState: s.homeBaseState,
    preferredLanguage: s.preferredLanguage,
    languages: s.languages,
    yearsExperience: s.yearsExperience,
    timezone: s.timezone,
    lastLat: s.homeLat,
    lastLng: s.homeLng,
    lastLocationAt: new Date(nowMs),
  }));
}

export function hosRows(specs, nowMs) {
  return specs.map((s) => ({
    driverId: s.id,
    driveRemainingMin: s.hos.driveRemainingMin,
    windowRemainingMin: s.hos.windowRemainingMin,
    cycleRemainingMin: s.hos.cycleRemainingMin,
    minutesSinceBreak: s.hos.minutesSinceBreak,
    importedAt: new Date(nowMs),
  }));
}

function laneLabelBetween(a, b) {
  return `${a.city}, ${a.state} > ${b.city}, ${b.state}`;
}

/** One DriverPreference per driver. Cast members mostly get neutral/empty
 *  preferences (their scenario is about something else) except Lena
 *  (homeTimeTarget "weekend", set on her spec already). Bulk drivers get a
 *  varied, plausible mix — preferredLanes/avoidLanes use the exact "City, ST
 *  > City, ST" label format candidateContext.ts's laneOfContextStops builds,
 *  so a preference that DOES happen to name a real generated lane is a
 *  genuine match, not a coincidence of formatting. */
export function preferenceRows(rand, specs) {
  return specs.map((s) => {
    if (s.isCast) {
      return {
        driverId: s.id,
        maxTripMiles: null,
        preferredRegions: [],
        preferredLanes: [],
        avoidRegions: [],
        avoidLanes: [],
        homeTimeTarget: s.homeTimeTarget,
        willingToDriveNight: true,
        willingToRelocateMiles: null,
        preferredEquipment: [],
      };
    }
    const hubA = randomHub(rand);
    const hubB = randomHub(rand);
    const preferredLanes = chance(rand, 0.25) && hubA.city !== hubB.city ? [laneLabelBetween(hubA, hubB)] : [];
    const hubC = randomHub(rand);
    const hubD = randomHub(rand);
    const avoidLanes = chance(rand, 0.15) && hubC.city !== hubD.city ? [laneLabelBetween(hubC, hubD)] : [];
    return {
      driverId: s.id,
      maxTripMiles: chance(rand, 0.5) ? randInt(rand, 300, 1200) : null,
      preferredRegions: chance(rand, 0.3) ? [pick(rand, [s.homeBaseState])] : [],
      preferredLanes,
      avoidRegions: chance(rand, 0.15) ? [randomHub(rand).state] : [],
      avoidLanes,
      homeTimeTarget: s.homeTimeTarget,
      willingToDriveNight: chance(rand, 0.7),
      willingToRelocateMiles: chance(rand, 0.4) ? randInt(rand, 50, 500) : null,
      preferredEquipment: chance(rand, 0.4) ? [...s.equipmentTypes] : [],
    };
  });
}
