import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

// Shared fixture for tests/dispatch-tools*.test.ts (AI Dispatch Foundation,
// Task 5). Not itself a *.test.ts file — vitest's `dispatch-tools*.test.ts`
// glob does not collect it, so it is safe for every split file to import.
//
// One org (A) telling one coherent story:
//  - D1 "Available Driver": accepting loads, no assignment -> AVAILABLE.
//  - D2 "OnLoad Driver": active assignment on L3 (in_progress) -> ON_LOAD.
//  - D3 "Trip Driver": completed assignment on L4, whose AgentTrip carries a
//    "plan" event (etaAtMs = ETA_PLAN) and a LATER "sheet_write" event
//    (remaining.etaAtMs = ETA_SHEET) — deliberately a SMALLER number than
//    ETA_PLAN, so a test asserting `etaMs === ETA_SHEET` actually proves
//    "newest event wins", not "largest value wins".
//  - L1/L2: open, no assignment ("uncovered"). L1's pickup window ended 3h
//    ago (within the 24h grace -> still listed); L2's ended 2 days ago (past
//    grace -> not listed).
//  - L3: in_progress, D2's assignment, plus interleaved LoadChange/
//    AgentUpdate rows for getLoadEvents' merge-by-time.
//  - L4: delivered, D3's completed assignment, linked to `customer`. Its trip
//    also carries two events with NO resolvable etaAtMs (a "plan" whose
//    etaAtMs is a string, and a "sheet_write" with no `remaining`) AFTER the
//    valid sheet_write, so getCurrentETA's skip-and-fall-back-to-the-older-
//    valid-event branch (review fix round 1, Important #2) is genuinely
//    exercised rather than trivially true on the first event checked.
//  - L5 (review fix round 1, ❌ #1): status "canceled", whose ONLY assignment
//    is also "canceled" — proves a canceled assignment's plannedEnd is never
//    reported as an ETA. Status "canceled" (not "open") so it never lands in
//    any existing status/uncovered assertion below.
//  - L6 (review fix round 1, Important #2): open, no assignment (so it IS
//    "uncovered" by status+assignment), but its first stop carries NO
//    appointment at all — proves the "not evaluable, not a default bucket"
//    branch in both `searchLoads`'s fromMs/toMs filter and
//    `getUncoveredLoads`.
//  - One tractor + one DryVan trailer so findFeasibleDrivers/
//    getDispatchCandidateDetails have a real pool to rank against.
// Org B carries one driver, one customer, and one load for cross-org checks.

export const HOUR = 3_600_000;
export const DAY_MS = 24 * HOUR;
// Real wall-clock "now" at fixture-build time, NOT a fixed historical
// instant: getDriverAvailability/searchDrivers/getAvailableDrivers all call
// availabilityFor() with no `nowMs` override, so they derive ON_LOAD vs.
// AVAILABLE_SOON against the REAL Date.now() at call time. A fixed past
// constant would put D2's assignment's plannedEnd in the past relative to
// that real call, which reads as "AVAILABLE_SOON forever" instead of the
// intended ON_LOAD. Every other fixture time is relative to this same
// NOW_MS, so the handful of milliseconds between building the fixture and a
// test's assertions never approaches any of this suite's hour-scale
// thresholds (AVAILABLE_SOON_WINDOW_MS, the 24h uncovered-loads cutoff).
export const NOW_MS = Date.now();

export const KC = { lat: 39.0997, lng: -94.5786, address: "Kansas City, MO 64101" };
export const DALLAS = { lat: 32.7767, lng: -96.797, address: "Dallas, TX 75201" };

export const ETA_PLAN = NOW_MS + 5 * HOUR;
export const ETA_SHEET = NOW_MS + 4 * HOUR;

interface StopSpec {
  sequence: number;
  type: string;
  address: string;
  lat: number;
  lng: number;
  windowStart?: Date;
  windowEnd?: Date;
}

function stopsData(stops: StopSpec[]) {
  return stops.map((s) => ({
    sequence: s.sequence,
    type: s.type,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    geocodeStatus: "ok",
    ...(s.windowEnd ? { appointment: { create: { windowStart: s.windowStart ?? null, windowEnd: s.windowEnd, type: s.type } } } : {}),
  }));
}

async function createLoad(
  orgId: string,
  status: string,
  stops: StopSpec[],
  extra: { customerId?: string } = {},
) {
  return prisma.load.create({
    data: {
      orgId,
      status,
      requiredEquip: "DryVan",
      revenueCents: 100000,
      customerId: extra.customerId,
      stops: { create: stopsData(stops) },
    },
  });
}

export async function seedDispatchToolsFixture() {
  const orgA = await prisma.org.create({ data: { name: "Acme AI Dispatch" } });
  const orgB = await prisma.org.create({ data: { name: "Org B" } });

  const disp = await prisma.dispatcher.create({ data: { email: "disp@ai-tools.com", passwordHash: "x", name: "D", orgId: orgA.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

  const customer = await prisma.customer.create({ data: { orgId: orgA.id, name: "Acme Foods", priority: "high" } });
  const customerB = await prisma.customer.create({ data: { orgId: orgB.id, name: "Other Foods" } });

  const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

  const d1 = await prisma.driver.create({
    data: {
      email: "d1@ai-tools.com", passwordHash: "x", name: "Available Driver", orgId: orgA.id,
      firstName: "Ava", lastName: "Ilable", cdlClass: "A", hazmatEndorsed: true, endorsements: ["H"],
      equipmentTypes: ["DryVan", "Reefer"], languages: ["en", "es"], preferredLanguage: "en",
      homeBaseCity: "Kansas City", homeBaseState: "MO", yearsExperience: 5, timezone: "America/Chicago",
      lastLat: KC.lat, lastLng: KC.lng, lastLocationAt: new Date(NOW_MS - 10 * 60_000),
      hos: { create: FRESH_HOS },
    },
  });
  await prisma.driverAvailability.create({
    data: { driverId: d1.id, source: "manual", acceptingLoads: true, availabilityStatus: "AVAILABLE" },
  });

  const d2 = await prisma.driver.create({
    data: {
      email: "d2@ai-tools.com", passwordHash: "x", name: "OnLoad Driver", orgId: orgA.id,
      equipmentTypes: ["DryVan"], languages: ["en"], preferredLanguage: "en", homeBaseState: "KS",
      lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH_HOS },
    },
  });

  const d3 = await prisma.driver.create({
    data: {
      email: "d3@ai-tools.com", passwordHash: "x", name: "Trip Driver", orgId: orgA.id,
      equipmentTypes: ["DryVan"], languages: ["en"], preferredLanguage: "en", homeBaseState: "TX",
      lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH_HOS },
    },
  });

  const dB1 = await prisma.driver.create({ data: { email: "db1@ai-tools.com", passwordHash: "x", name: "Org B Driver", orgId: orgB.id } });

  // L1: uncovered, pickup window ended 3h ago -> still within 24h grace.
  const l1 = await createLoad(orgA.id, "open", [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, windowStart: new Date(NOW_MS - 5 * HOUR), windowEnd: new Date(NOW_MS - 3 * HOUR) },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS + 3 * HOUR) },
  ]);

  // L2: uncovered, pickup window ended 2 days ago -> past the 24h grace.
  const l2 = await createLoad(orgA.id, "open", [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, windowStart: new Date(NOW_MS - 2 * DAY_MS - 2 * HOUR), windowEnd: new Date(NOW_MS - 2 * DAY_MS) },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS - 2 * DAY_MS + 6 * HOUR) },
  ]);

  // L6: uncovered by status+assignment (open, no assignment), but its first
  // stop carries no appointment at all -> excluded from both searchLoads'
  // fromMs/toMs filter and getUncoveredLoads (review fix round 1,
  // Important #2 — previously zero fixture coverage of this branch).
  const l6 = await createLoad(orgA.id, "open", [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng }, // no windowEnd -> no appointment
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS + 2 * DAY_MS) },
  ]);

  // L3: in_progress, D2's active assignment. Pickup window set well outside
  // the [NOW-1d, NOW] range searchLoads' fromMs/toMs test uses, so it never
  // interferes with that assertion.
  const l3 = await createLoad(orgA.id, "in_progress", [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, windowEnd: new Date(NOW_MS - 3 * DAY_MS) },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS + 8 * HOUR) },
  ]);
  const l3Assignment = await prisma.assignment.create({
    data: { orgId: orgA.id, loadId: l3.id, driverId: d2.id, status: "in_progress", plannedStart: new Date(NOW_MS - 2 * HOUR), plannedEnd: new Date(NOW_MS + 10 * HOUR) },
  });

  await prisma.loadChange.create({ data: { loadId: l3.id, orgId: orgA.id, atMs: BigInt(1000), actorName: "Dispatcher A", source: "board", field: "status", before: "open", after: "assigned", note: null } });
  await prisma.agentUpdate.create({ data: { loadId: l3.id, atMs: BigInt(2000), kind: "status", text: "Driver en route" } });
  await prisma.loadChange.create({ data: { loadId: l3.id, orgId: orgA.id, atMs: BigInt(3000), actorName: "Dispatcher A", source: "board", field: "status", before: "assigned", after: "in_progress", note: null } });
  await prisma.agentUpdate.create({ data: { loadId: l3.id, atMs: BigInt(500), kind: "eta", text: "ETA updated" } });

  // L4: delivered, D3's completed assignment, linked to `customer`.
  const l4 = await createLoad(
    orgA.id,
    "delivered",
    [
      { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, windowEnd: new Date(NOW_MS - 4 * DAY_MS) },
      { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS - DAY_MS + HOUR) },
    ],
    { customerId: customer.id },
  );
  const l4Assignment = await prisma.assignment.create({
    data: {
      orgId: orgA.id, loadId: l4.id, driverId: d3.id, status: "completed",
      plannedStart: new Date(NOW_MS - 2 * DAY_MS), plannedEnd: new Date(NOW_MS - DAY_MS),
      completedAt: new Date(NOW_MS - DAY_MS + 30 * 60_000),
    },
  });

  const trip = await prisma.agentTrip.create({
    data: { id: `trip-${l4.id}`, loadRef: "L4", loadId: l4.id, driverToken: `tok-${l4.id}`, brief: {}, status: "delivered" },
  });
  await prisma.agentEvent.create({
    data: { tripId: trip.id, atMs: BigInt(0), kind: "plan", evidence: { distanceMi: 500, driveMin: 600, etaAtMs: ETA_PLAN, breakWindow: null, itinerary: {} } },
  });
  await prisma.agentEvent.create({
    data: { tripId: trip.id, atMs: BigInt(30 * 60_000), kind: "reply", evidence: { channel: "chat", rawText: "ok", situationKey: null, confidence: 0.9, answersKey: null } },
  });
  await prisma.agentEvent.create({
    data: { tripId: trip.id, atMs: BigInt(60 * 60_000), kind: "sheet_write", evidence: { cells: {}, remaining: { legs: [], etaAtMs: ETA_SHEET, slackMin: 30 } } },
  });
  // Two more events, NEWER than the valid sheet_write above, neither of
  // which carries a resolvable etaAtMs — getCurrentETA must skip both and
  // still fall back to the older, valid sheet_write's ETA_SHEET (review fix
  // round 1, Important #2: this skip branch was correct by inspection but
  // had no fixture ever exercising it, since the newest event was always
  // already the valid one).
  await prisma.agentEvent.create({
    // A re-plan whose etaAtMs is malformed (wrong type) rather than absent —
    // etaFromEvidence's `typeof === "number"` check must reject this, not
    // just a missing key.
    data: { tripId: trip.id, atMs: BigInt(90 * 60_000), kind: "plan", evidence: { distanceMi: 510, driveMin: 610, etaAtMs: "not-a-number", breakWindow: null, itinerary: {} } },
  });
  await prisma.agentEvent.create({
    // A cells-only sheet_write (no `remaining` key at all) — the real shape
    // night-shift/src/core/agent.ts writes when there is no active plan to
    // re-time (`remaining ? {...} : { cells }`).
    data: { tripId: trip.id, atMs: BigInt(120 * 60_000), kind: "sheet_write", evidence: { cells: { A1: "delivered" } } },
  });

  // L5: status "canceled", whose only Assignment is also "canceled" — the
  // load's own pickup window is irrelevant to getCurrentETA and is set well
  // outside every other test's fromMs/toMs range purely so this load cannot
  // accidentally leak into an unrelated assertion.
  const l5 = await createLoad(orgA.id, "canceled", [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, windowEnd: new Date(NOW_MS - 6 * DAY_MS) },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS - 6 * DAY_MS + 6 * HOUR) },
  ]);
  const l5Assignment = await prisma.assignment.create({
    data: {
      orgId: orgA.id, loadId: l5.id, driverId: d1.id, status: "canceled",
      plannedStart: new Date(NOW_MS - 7 * DAY_MS), plannedEnd: new Date(NOW_MS - 6 * DAY_MS),
    },
  });

  // D1's location trail: 3 pings an hour apart.
  await prisma.driverLocation.create({ data: { driverId: d1.id, latitude: KC.lat, longitude: KC.lng, createdAt: new Date(NOW_MS - 3 * HOUR) } });
  await prisma.driverLocation.create({ data: { driverId: d1.id, latitude: KC.lat + 0.01, longitude: KC.lng + 0.01, createdAt: new Date(NOW_MS - 2 * HOUR) } });
  await prisma.driverLocation.create({ data: { driverId: d1.id, latitude: KC.lat + 0.02, longitude: KC.lng + 0.02, createdAt: new Date(NOW_MS - 1 * HOUR) } });

  const tractorA = await prisma.tractor.create({ data: { orgId: orgA.id, unit: "T-A1", status: "active" } });
  const trailerA = await prisma.trailer.create({ data: { orgId: orgA.id, unit: "TR-A1", type: "DryVan", status: "active" } });

  const lB1 = await createLoad(orgB.id, "open", [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng, windowEnd: new Date(NOW_MS - HOUR) },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date(NOW_MS + 5 * HOUR) },
  ]);

  return {
    orgA, orgB, disp, auth,
    d1, d2, d3, dB1,
    l1, l2, l3, l4, l5, l6, lB1,
    l3Assignment, l4Assignment, l5Assignment,
    customer, customerB,
    tractorA, trailerA,
  };
}
