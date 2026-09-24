import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { driverMetrics, driverMetricsBatch } from "../src/lib/driverMetrics.js";
import { laneKey } from "../src/lib/lanes.js";
import { responseMetricsFor } from "../src/lib/driverResponseMetrics.js";
import { candidateContextSourcesForDriver } from "../src/lib/candidateContext.js";

// AI Dispatch Foundation, Task 4 — driverMetrics/driverMetricsBatch
// (lib/driverMetrics.ts) and the two routes built on top of them
// (dispatcherDriverSupply.ts). One fixture (seedFixture below) builds the
// whole exact-numbers scenario the task-4 brief describes: 6 completed
// assignments (2 late, 1 not evaluable, 2 lanes), 2 AgentTrips (3 asks / 2
// replies, 1 breakdown, 1 no-response escalation), and one detention claim —
// reused by both the direct service tests and the route tests below so
// there is exactly one source of truth for "what the fixture means".

beforeEach(resetDb);

const HOUR = 3_600_000;
// Fixed reference "now" for every direct driverMetrics/driverMetricsBatch
// call below — NOT real wall-clock time — so loadsLast30Days/nightLoads are
// fully deterministic regardless of when this suite actually runs. 2026-07-20
// is comfortably inside EDT (America/Detroit), which the night-load dates
// below depend on.
const NOW_MS = Date.parse("2026-07-20T00:00:00.000Z");

// Coordinates round (toFixed(1)) into two clearly distinct lane buckets —
// same convention tests/customers.test.ts uses for its own lane fixture.
const KC = { lat: 39.0997, lng: -94.5786, address: "Kansas City, MO 64101" };
const DALLAS = { lat: 32.7767, lng: -96.797, address: "Dallas, TX 75201" };
const TULSA = { lat: 36.154, lng: -95.9928, address: "Tulsa, OK 74101" };
const AMARILLO = { lat: 35.222, lng: -101.8313, address: "Amarillo, TX 79101" };
// Detention-only stop, far from every lane coordinate above so its pings
// never fall inside another stop's dwell fence.
const CHI = { lat: 41.8781, lng: -87.6298, address: "Chicago, IL 60601" };

interface StopSpec {
  sequence: number;
  type: string;
  address: string;
  lat: number;
  lng: number;
  windowStart?: Date;
  windowEnd?: Date;
}

async function createLoad(orgId: string, stops: StopSpec[], extra: { externalId?: string; customerId?: string } = {}) {
  return prisma.load.create({
    data: {
      orgId,
      requiredEquip: "DryVan",
      revenueCents: 100000,
      externalId: extra.externalId,
      customerId: extra.customerId,
      stops: {
        create: stops.map((s) => ({
          sequence: s.sequence,
          type: s.type,
          address: s.address,
          lat: s.lat,
          lng: s.lng,
          geocodeStatus: "ok",
          // Omitted entirely (not even a windowEnd:null placeholder) whenever
          // a stop has no appointment at all — L4's delivery stop below is
          // the "not evaluable" case this produces.
          ...(s.windowEnd
            ? { appointment: { create: { windowStart: s.windowStart ?? null, windowEnd: s.windowEnd, type: "delivery" } } }
            : {}),
        })),
      },
    },
  });
}

async function completeAssignment(orgId: string, driverId: string, loadId: string, plannedStart: Date, completedAt: Date) {
  return prisma.assignment.create({
    data: { orgId, loadId, driverId, status: "completed", plannedStart, plannedEnd: completedAt, completedAt },
  });
}

/**
 * One org (timezone America/Detroit), one driver, 6 completed assignments:
 *  L1 late +45min,  recent, NOT night, lane A — also carries the detention
 *     scenario (an extra intermediate stop far from the lane coordinates,
 *     so it never contaminates another stop's dwell fence) plus a Customer
 *     and externalId, so /history exercises both.
 *  L2 late +135min, OLD,    NOT night, lane A.
 *  L3 on-time,      recent, night,     lane A.
 *  L4 not evaluable (no delivery appointment), OLD, NOT night, lane A.
 *  L5 on-time,      recent, night,     lane B — hosts AgentTrip A.
 *  L6 on-time,      OLD,    NOT night, lane B — hosts AgentTrip B.
 * -> onTimeLoads 3, lateLoads 2, onTimeRate 0.6, averageDelayMinutes 90,
 *    loadsLast30Days 3, nightLoads 2, lane A runs 4, lane B runs 2.
 *
 * "Night" is 22:30 America/Detroit; 2026-07 is EDT (UTC-4), so 22:30 local
 * on e.g. 2026-07-09 is 2026-07-10T02:30:00Z.
 */
async function seedFixture() {
  const org = await prisma.org.create({ data: { name: "Acme Detroit", timezone: "America/Detroit" } });
  const driver = await prisma.driver.create({ data: { email: "driver@x.com", passwordHash: "x", name: "Driver One", orgId: org.id } });
  const disp = await prisma.dispatcher.create({ data: { email: "disp@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });

  const l1 = await createLoad(
    org.id,
    [
      { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng },
      {
        sequence: 2, type: "intermediate", address: CHI.address, lat: CHI.lat, lng: CHI.lng,
        windowStart: new Date(NOW_MS - 5 * HOUR), windowEnd: new Date(NOW_MS - 5 * HOUR + 6 * HOUR),
      },
      { sequence: 3, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date("2026-07-05T18:00:00.000Z") },
    ],
    { externalId: "L-0001", customerId: customer.id },
  );
  await completeAssignment(org.id, driver.id, l1.id, new Date("2026-07-04T14:00:00.000Z"), new Date("2026-07-05T18:45:00.000Z")); // +45 late

  const l2 = await createLoad(org.id, [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date("2026-05-01T18:00:00.000Z") },
  ]);
  await completeAssignment(org.id, driver.id, l2.id, new Date("2026-04-30T14:00:00.000Z"), new Date("2026-05-01T20:15:00.000Z")); // +135 late

  const l3 = await createLoad(org.id, [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng, windowEnd: new Date("2026-07-10T18:00:00.000Z") },
  ]);
  await completeAssignment(org.id, driver.id, l3.id, new Date("2026-07-10T02:30:00.000Z"), new Date("2026-07-10T17:00:00.000Z")); // on time, night

  const l4 = await createLoad(org.id, [
    { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng },
    { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng }, // no appointment -> not evaluable
  ]);
  await completeAssignment(org.id, driver.id, l4.id, new Date("2026-03-31T14:00:00.000Z"), new Date("2026-04-01T12:00:00.000Z"));

  const l5 = await createLoad(org.id, [
    { sequence: 1, type: "pickup", address: TULSA.address, lat: TULSA.lat, lng: TULSA.lng },
    { sequence: 2, type: "delivery", address: AMARILLO.address, lat: AMARILLO.lat, lng: AMARILLO.lng, windowEnd: new Date("2026-07-12T13:00:00.000Z") },
  ]);
  await completeAssignment(org.id, driver.id, l5.id, new Date("2026-07-12T02:30:00.000Z"), new Date("2026-07-12T11:00:00.000Z")); // on time, night

  const l6 = await createLoad(org.id, [
    { sequence: 1, type: "pickup", address: TULSA.address, lat: TULSA.lat, lng: TULSA.lng },
    { sequence: 2, type: "delivery", address: AMARILLO.address, lat: AMARILLO.lat, lng: AMARILLO.lng, windowEnd: new Date("2026-05-15T13:00:00.000Z") },
  ]);
  await completeAssignment(org.id, driver.id, l6.id, new Date("2026-05-14T14:00:00.000Z"), new Date("2026-05-15T11:00:00.000Z")); // on time

  // Detention: the exact shape tests/detention-scan.test.ts's own reference
  // case uses — 6 pings spanning now-4h..now-1h at a geocoded stop with an
  // appointment -> observedMin 180, org default free 120 -> billableMin 60.
  // Only L1's intermediate CHI stop ever sees a ping, so this is the ONE
  // claim in the whole fixture.
  for (const t of [NOW_MS - 4 * HOUR, NOW_MS - 3.5 * HOUR, NOW_MS - 3 * HOUR, NOW_MS - 2.5 * HOUR, NOW_MS - 2 * HOUR, NOW_MS - 1 * HOUR]) {
    await prisma.driverLocation.create({ data: { driverId: driver.id, latitude: CHI.lat, longitude: CHI.lng, createdAt: new Date(t) } });
  }

  // Trip A (on L5): asks (message) -> replies at +12min -> asks again
  // (message_again), never answered. Trip B (on L6): asks (sms) -> replies
  // at +8min with situationKey "breakdown" -> a no-response escalation.
  // -> averageResponseMinutes 10, responseRate 2/3, noResponseIncidents 1,
  //    breakdownIncidents 1, accidentIncidents 0.
  const tripA = await prisma.agentTrip.create({
    data: { id: `trip-${l5.id}`, loadRef: "L5", loadId: l5.id, driverToken: `tok-${l5.id}`, brief: {}, status: "tracking" },
  });
  await prisma.agentEvent.create({
    data: { tripId: tripA.id, atMs: BigInt(0), kind: "action", evidence: { kind: "message", anomalyKey: "no_word", rung: 1, channel: "chat", text: "You still on schedule?" } },
  });
  await prisma.agentEvent.create({
    data: { tripId: tripA.id, atMs: BigInt(12 * 60_000), kind: "reply", evidence: { channel: "chat", rawText: "yep, on my way", situationKey: null, confidence: 0.9, answersKey: "no_word" } },
  });
  await prisma.agentEvent.create({
    data: { tripId: tripA.id, atMs: BigInt(40 * 60_000), kind: "action", evidence: { kind: "message_again", anomalyKey: "no_word", rung: 2, channel: "chat", text: "Still there?" } },
  });

  const tripB = await prisma.agentTrip.create({
    data: { id: `trip-${l6.id}`, loadRef: "L6", loadId: l6.id, driverToken: `tok-${l6.id}`, brief: {}, status: "tracking" },
  });
  await prisma.agentEvent.create({
    data: { tripId: tripB.id, atMs: BigInt(0), kind: "action", evidence: { kind: "sms", anomalyKey: "dark", rung: 1, channel: "sms", text: "Check in?" } },
  });
  await prisma.agentEvent.create({
    data: { tripId: tripB.id, atMs: BigInt(8 * 60_000), kind: "reply", evidence: { channel: "sms", rawText: "truck broke down on I-40", situationKey: "breakdown", confidence: 0.95, answersKey: "dark" } },
  });
  await prisma.agentEvent.create({
    data: { tripId: tripB.id, atMs: BigInt(9 * 60_000), kind: "escalation", evidence: { reason: "gone dark unresolved after 2 calls", deadlineAtRisk: true, draftAttached: false, anomalyKey: "dark", messageId: null } },
  });

  return { org, driver, auth, customer, loads: { l1, l2, l3, l4, l5, l6 } };
}

describe("driverMetrics", () => {
  it("exact numbers across 6 completed loads, 2 agent trips, and one detention claim", async () => {
    const { org, driver } = await seedFixture();
    const metrics = await driverMetrics(org.id, driver.id, NOW_MS);

    expect(metrics.driverId).toBe(driver.id);
    expect(metrics.asOf).toEqual(new Date(NOW_MS));
    expect(metrics.completedLoads).toBe(6);
    expect(metrics.onTimeLoads).toBe(3);
    expect(metrics.lateLoads).toBe(2);
    expect(metrics.onTimeRate).toBeCloseTo(0.6, 10);
    expect(metrics.averageDelayMinutes).toBe(90);
    expect(metrics.averageDetentionMinutes).toBe(60);
    expect(metrics.averageResponseMinutes).toBe(10);
    expect(metrics.responseRate).toBeCloseTo(2 / 3, 10);
    expect(metrics.noResponseIncidents).toBe(1);
    expect(metrics.breakdownIncidents).toBe(1);
    expect(metrics.accidentIncidents).toBe(0);
    expect(metrics.loadsLast30Days).toBe(3);
    expect(metrics.nightLoads).toBe(2);
    expect(metrics.evidence).toEqual({ assignments: 6, agentTrips: 2, agentEvents: 6 });

    expect(metrics.laneExperience).toHaveLength(2);
    expect(metrics.laneExperience[0]).toMatchObject({ runs: 4, originCity: "Kansas City", destCity: "Dallas" });
    expect(metrics.laneExperience[0]?.laneKey).toBe(laneKey(KC, DALLAS));
    expect(metrics.laneExperience[1]).toMatchObject({ runs: 2, originCity: "Tulsa", destCity: "Amarillo" });
  });

  it("includeDetention:false skips the scan — averageDetentionMinutes is null even though this fixture has a real 60-minute claim", async () => {
    const { org, driver } = await seedFixture();

    // Same fixture as the test above (the one genuine detention claim, 60
    // billable minutes) — driverMetrics() still reports it, unaffected...
    expect((await driverMetrics(org.id, driver.id, NOW_MS)).averageDetentionMinutes).toBe(60);

    // ...but the opt-out reports null, not 0 — the scan genuinely never ran,
    // it isn't that it ran and found nothing.
    const withoutDetention = await driverMetricsBatch(org.id, [driver.id], NOW_MS, { includeDetention: false });
    expect(withoutDetention.get(driver.id)?.averageDetentionMinutes).toBeNull();
    // Every other field is untouched by the option.
    expect(withoutDetention.get(driver.id)?.onTimeRate).toBeCloseTo(0.6, 10);
    expect(withoutDetention.get(driver.id)?.completedLoads).toBe(6);

    // The actual context path (candidateContext.ts) drives this through
    // candidateContextSourcesForDriver — proves the wiring, not just that
    // the option works when passed by hand above.
    const sources = await candidateContextSourcesForDriver(org.id, driver.id, NOW_MS);
    expect(sources.metrics.get(driver.id)?.averageDetentionMinutes).toBeNull();
  });

  it("counts a trip's response evidence even while its assignment is still active, not completed", async () => {
    // A trip is normally still live WHILE its assignment is in_progress —
    // the brief excludes a trip only when its "load has no assignment" at
    // all, never by that assignment's status (driverMetrics.ts's own header
    // comment on this query). completedLoads must stay 0 (never assigned to
    // "completed"), but the trip's own evidence must still be counted.
    const org = await prisma.org.create({ data: { name: "Active Co" } });
    const driver = await prisma.driver.create({ data: { email: "active@x.com", passwordHash: "x", name: "Active Driver", orgId: org.id } });
    const load = await createLoad(org.id, [
      { sequence: 1, type: "pickup", address: KC.address, lat: KC.lat, lng: KC.lng },
      { sequence: 2, type: "delivery", address: DALLAS.address, lat: DALLAS.lat, lng: DALLAS.lng },
    ]);
    await prisma.assignment.create({
      data: {
        orgId: org.id, loadId: load.id, driverId: driver.id, status: "in_progress",
        plannedStart: new Date("2026-07-01T12:00:00.000Z"), plannedEnd: new Date("2026-07-02T12:00:00.000Z"),
      },
    });
    const trip = await prisma.agentTrip.create({
      data: { id: `trip-${load.id}`, loadRef: "ACTIVE", loadId: load.id, driverToken: `tok-${load.id}`, brief: {}, status: "tracking" },
    });
    await prisma.agentEvent.create({
      data: { tripId: trip.id, atMs: BigInt(0), kind: "action", evidence: { kind: "message", anomalyKey: "x", rung: 1, channel: "chat", text: "?" } },
    });
    await prisma.agentEvent.create({
      data: { tripId: trip.id, atMs: BigInt(5 * 60_000), kind: "reply", evidence: { channel: "chat", rawText: "ok", situationKey: null, confidence: 0.9, answersKey: "x" } },
    });

    const metrics = await driverMetrics(org.id, driver.id, NOW_MS);

    expect(metrics.completedLoads).toBe(0);
    expect(metrics.averageResponseMinutes).toBe(5);
    expect(metrics.responseRate).toBe(1);
    expect(metrics.evidence).toEqual({ assignments: 0, agentTrips: 1, agentEvents: 2 });
  });

  it("a driver with no evidence at all gets null rates and zero counts", async () => {
    const org = await prisma.org.create({ data: { name: "Quiet Co" } });
    const driver = await prisma.driver.create({ data: { email: "quiet@x.com", passwordHash: "x", name: "Quiet Driver", orgId: org.id } });

    const metrics = await driverMetrics(org.id, driver.id, NOW_MS);

    expect(metrics).toMatchObject({
      completedLoads: 0,
      onTimeLoads: 0,
      lateLoads: 0,
      onTimeRate: null,
      averageDelayMinutes: null,
      averageDetentionMinutes: null,
      averageResponseMinutes: null,
      responseRate: null,
      noResponseIncidents: 0,
      breakdownIncidents: 0,
      accidentIncidents: 0,
      loadsLast30Days: 0,
      nightLoads: 0,
      laneExperience: [],
      evidence: { assignments: 0, agentTrips: 0, agentEvents: 0 },
    });
  });

  it("driverMetricsBatch for two drivers equals the two single calls", async () => {
    const { org, driver } = await seedFixture();
    const quiet = await prisma.driver.create({ data: { email: "quiet2@x.com", passwordHash: "x", name: "Quiet Two", orgId: org.id } });

    const batch = await driverMetricsBatch(org.id, [driver.id, quiet.id], NOW_MS);
    const single1 = await driverMetrics(org.id, driver.id, NOW_MS);
    const single2 = await driverMetrics(org.id, quiet.id, NOW_MS);

    expect(batch.size).toBe(2);
    expect(batch.get(driver.id)).toEqual(single1);
    expect(batch.get(quiet.id)).toEqual(single2);
  });
});

// Two `tripStats` (driverResponseMetrics.ts) branches are otherwise never
// exercised: seedFixture's own "second ask" always follows an intervening
// reply, and no fixture ever has a reply with nothing open. Pure-function
// tests against responseMetricsFor directly (no DB fixture needed) so each
// edge case is isolated to exactly the one branch it's proving.
describe("responseMetricsFor — state machine edge cases", () => {
  it("a second ASK before any reply does not open a second question", () => {
    // If the `if (openedAtMs === null)` guard were missing, the second ask
    // would both increment `opened` again (responseRate 1/2, not 1/1) AND
    // overwrite the open marker to its own (later) timestamp (the reply
    // would then close against 10min, not 0 -> 5 minutes, not 15).
    const trips = [{
      events: [
        { atMs: BigInt(0), kind: "action", evidence: { kind: "message", anomalyKey: "x", rung: 1, channel: "chat", text: "?" } },
        { atMs: BigInt(10 * 60_000), kind: "action", evidence: { kind: "message_again", anomalyKey: "x", rung: 2, channel: "chat", text: "still?" } },
        { atMs: BigInt(15 * 60_000), kind: "reply", evidence: { channel: "chat", rawText: "ok", situationKey: null, confidence: 0.9, answersKey: "x" } },
      ],
    }];

    const metrics = responseMetricsFor(trips);

    expect(metrics.responseRate).toBe(1); // opened stayed 1, not 2
    expect(metrics.averageResponseMinutes).toBe(15); // closed against the FIRST ask's atMs (0), not the second's (10min)
  });

  it("a stray REPLY with no open question is ignored for closing, but still counts its situationKey", () => {
    // No ask precedes this reply at all. It must not fabricate a closed
    // question or a response-minutes entry — but situationKey counting is
    // UNCONDITIONAL on pairing (driverResponseMetrics.ts's own comment on
    // tripStats), so it must still count here.
    const trips = [{
      events: [
        { atMs: BigInt(0), kind: "reply", evidence: { channel: "chat", rawText: "truck broke down", situationKey: "breakdown", confidence: 0.9, answersKey: null } },
      ],
    }];

    const metrics = responseMetricsFor(trips);

    expect(metrics.responseRate).toBeNull(); // opened stayed 0
    expect(metrics.averageResponseMinutes).toBeNull(); // closed stayed 0 — no response-minutes entry was fabricated
    expect(metrics.breakdownIncidents).toBe(1); // situationKey counted regardless
  });
});

describe("GET /drivers/:id/metrics", () => {
  it("mirrors the service's now-independent numbers for the caller's own driver", async () => {
    const { driver, auth } = await seedFixture();
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/metrics`).set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.driverId).toBe(driver.id);
    expect(res.body.completedLoads).toBe(6);
    expect(res.body.onTimeLoads).toBe(3);
    expect(res.body.lateLoads).toBe(2);
    expect(res.body.onTimeRate).toBeCloseTo(0.6, 10);
    expect(res.body.averageDelayMinutes).toBe(90);
    expect(res.body.averageResponseMinutes).toBe(10);
    expect(res.body.responseRate).toBeCloseTo(2 / 3, 10);
    expect(res.body.noResponseIncidents).toBe(1);
    expect(res.body.breakdownIncidents).toBe(1);
    expect(res.body.accidentIncidents).toBe(0);
    expect(res.body.nightLoads).toBe(2);
    expect(res.body.laneExperience[0]).toMatchObject({ runs: 4 });
    expect(typeof res.body.asOf).toBe("string");
    // loadsLast30Days AND averageDetentionMinutes are deliberately not
    // asserted here: the route calls driverMetrics with no `nowMs` override
    // (there is no such query param), so it runs against real wall-clock
    // time. loadsLast30Days is directly a `now`-relative window; less
    // obviously, so is averageDetentionMinutes — driverMetrics.ts's
    // DETENTION_LOOKBACK_DAYS (365) is also measured back from the real
    // `nowMs` this call defaults to, and the fixture's detention pings are
    // dated relative to the fixed NOW_MS below, not real time. Asserting
    // `toBe(60)` here would pass today but start failing on no code change
    // once the suite runs ~365 days after the fixture's ping dates — both are
    // exercised deterministically at the service level above instead, via an
    // explicit NOW_MS.
  });

  it("404s for a driver outside the caller's org, and for a nonexistent id", async () => {
    const { auth } = await seedFixture();
    const orgB = await prisma.org.create({ data: { name: "Other Co" } });
    const foreignDriver = await prisma.driver.create({ data: { email: "foreign@x.com", passwordHash: "x", name: "Foreign", orgId: orgB.id } });

    const cross = await request(app).get(`/api/dispatcher/drivers/${foreignDriver.id}/metrics`).set("authorization", auth);
    expect(cross.status).toBe(404);

    const missing = await request(app).get("/api/dispatcher/drivers/does-not-exist/metrics").set("authorization", auth);
    expect(missing.status).toBe(404);
  });
});

describe("GET /drivers/:id/history", () => {
  it("newest first, with lane/customer/late fields per row", async () => {
    const { driver, auth, customer, loads } = await seedFixture();
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/history`).set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    // completedAt descending: L5 (07-12) > L3 (07-10) > L1 (07-05) > L6 (05-15) > L2 (05-01) > L4 (04-01).
    expect(res.body.map((r: { loadId: string }) => r.loadId)).toEqual(
      [loads.l5, loads.l3, loads.l1, loads.l6, loads.l2, loads.l4].map((l) => l.id),
    );

    const row1 = res.body.find((r: { loadId: string }) => r.loadId === loads.l1.id);
    expect(row1).toMatchObject({
      loadRef: "L-0001",
      customerName: "ACME FOODS",
      customerId: customer.id,
      originCity: "Kansas City",
      destCity: "Dallas",
      late: true,
      lateMinutes: 45,
    });
    expect(row1.laneKey).toBe(laneKey(KC, DALLAS));

    const row2 = res.body.find((r: { loadId: string }) => r.loadId === loads.l2.id);
    expect(row2).toMatchObject({ loadRef: loads.l2.id, customerName: null, customerId: null, late: true, lateMinutes: 135 });

    const row4 = res.body.find((r: { loadId: string }) => r.loadId === loads.l4.id);
    expect(row4).toMatchObject({ late: null, lateMinutes: null, deliveryWindowEnd: null });

    const row5 = res.body.find((r: { loadId: string }) => r.loadId === loads.l5.id);
    expect(row5).toMatchObject({ originCity: "Tulsa", destCity: "Amarillo", late: false, lateMinutes: null });
  });

  it("clamps ?limit to [1, 200] instead of rejecting it, and defaults to 50", async () => {
    const { driver, auth } = await seedFixture();

    const one = await request(app).get(`/api/dispatcher/drivers/${driver.id}/history?limit=1`).set("authorization", auth);
    expect(one.status).toBe(200);
    expect(one.body).toHaveLength(1);

    const zero = await request(app).get(`/api/dispatcher/drivers/${driver.id}/history?limit=0`).set("authorization", auth);
    expect(zero.status).toBe(200);
    expect(zero.body).toHaveLength(1); // clamped up to the minimum, not rejected

    const big = await request(app).get(`/api/dispatcher/drivers/${driver.id}/history?limit=1000`).set("authorization", auth);
    expect(big.status).toBe(200);
    expect(big.body).toHaveLength(6); // clamped to 200; only 6 rows exist anyway

    const nonNumeric = await request(app).get(`/api/dispatcher/drivers/${driver.id}/history?limit=abc`).set("authorization", auth);
    expect(nonNumeric.status).toBe(200);
    expect(nonNumeric.body).toHaveLength(6); // falls back to the default (50)
  });

  it("404s for a driver outside the caller's org", async () => {
    const { auth } = await seedFixture();
    const orgB = await prisma.org.create({ data: { name: "Other Co 2" } });
    const foreignDriver = await prisma.driver.create({ data: { email: "foreign2@x.com", passwordHash: "x", name: "Foreign2", orgId: orgB.id } });

    const res = await request(app).get(`/api/dispatcher/drivers/${foreignDriver.id}/history`).set("authorization", auth);
    expect(res.status).toBe(404);
  });
});
