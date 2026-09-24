import { pick, pickWeighted, randInt, stableId } from "./prng.mjs";

// 20 customers, fixed regardless of scale. Exactly 3 are priority "high",
// and "Meridian Foods" (scenario H) is always one of them — both counts and
// that name are verbatim requirements.
const HIGH_PRIORITY_NAMES = ["Meridian Foods", "Cascade Industrial Supply", "TitanCore Manufacturing"];

const STANDARD_NAMES = [
  "Lakeside Produce Co", "Ferrous Metals Inc", "Great Lakes Auto Parts", "Northgate Building Materials",
  "Prairie Grain Cooperative", "Bluewater Paper Products", "Ironclad Fasteners LLC", "Heartland Dairy Partners",
  "Summit Consumer Goods", "Redline Auto Distributors", "Copperline Electronics", "Wolverine Furniture Co",
  "Crossroads Beverage Group", "Anchor Glass & Packaging", "Silverleaf Textiles", "Union Hardware Supply",
  "Pioneer Feed & Grain",
];

const CONTACT_FIRST = ["Karen", "Steve", "Monica", "Derek", "Yolanda", "Phil", "Renee", "Gary", "Tara", "Nolan"];
const CONTACT_LAST = ["Whitaker", "Boone", "Delgado", "Nash", "Osei", "Marchetti", "Voss", "Kim", "Reyes", "Ferris"];
const CHANNELS = [
  { value: "email", weight: 0.55 },
  { value: "sms", weight: 0.25 },
  { value: "phone", weight: 0.2 },
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildOne(rand, name, priority) {
  const contact = `${pick(rand, CONTACT_FIRST)} ${pick(rand, CONTACT_LAST)}`;
  const isHigh = priority === "high";
  return {
    id: stableId(`customer:${name}`),
    name,
    primaryContactName: contact,
    primaryEmail: `${slug(contact)}@${slug(name)}.example`,
    primaryPhone: `${randInt(rand, 200, 989)}-555-${String(randInt(rand, 0, 9999)).padStart(4, "0")}`,
    preferredCommunicationChannel: pickWeighted(rand, CHANNELS),
    timezone: null,
    priority,
    updateCadenceMinutes: isHigh ? randInt(rand, 30, 60) : randInt(rand, 60, 240),
    lateNotificationThresholdMinutes: isHigh ? randInt(rand, 15, 30) : randInt(rand, 30, 90),
    detentionFreeMinutes: pick(rand, [90, 120, 150]),
    requiresArrivalNotification: isHigh ? true : rand() < 0.3,
    // Verbatim for Meridian Foods (scenario H); every high-priority customer
    // gets the same rule for the same reason, and it is also the schema's
    // own default for everyone else.
    requiresDelayNotification: true,
  };
}

/** 20 fully-formed Customer rows (no orgId yet — the caller stamps that on
 *  once, right before createMany, exactly like every other builder in this
 *  package). Deterministic: iteration order is the fixed arrays above, and
 *  the only PRNG draws are for cosmetic fields (contact name/phone/channel/
 *  cadence) that no test asserts on. */
export function buildCustomers(rand) {
  const high = HIGH_PRIORITY_NAMES.map((name) => buildOne(rand, name, "high"));
  const standard = STANDARD_NAMES.map((name) => buildOne(rand, name, "standard"));
  return [...high, ...standard];
}

export const MERIDIAN_FOODS_NAME = "Meridian Foods";
