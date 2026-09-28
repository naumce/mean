import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";
import { resetDemo } from "../src/lib/demoStory/index.js";
import {
  DEMO_CUSTOMER_EMAIL, DEMO_CUSTOMER_NAME, DEMO_DRIVER_EXTERNAL_ID, DEMO_HIST_PREFIX,
  DEMO_LOAD_REF, DEMO_POLICY_NAME, DEMO_TRACTOR_UNIT, DEMO_TRAILER_UNIT, demoDriverEmail,
} from "../src/lib/demoStory/fixtures.js";
import { isNightShiftReleasing, switchAgentOn } from "../src/lib/demoStory/agentGate.js";
import { startRunner, runnerState } from "../src/lib/simulation/runner.js";
import { cancelRun } from "../src/lib/aiHarness/runner.js";

// Demo Mode — resetDemo: fixture counts/values, idempotency, and total
// recovery from any prior state. Calls resetDemo directly
// (a plain async function) rather than through HTTP — the HTTP surface
// (404 gating, response shape, cross-org) is tests/dispatcher-demo-story.test.ts's job.

beforeEach(resetDb);

async function seedOrgWithDispatcher(name = "Demo Reset Org") {
  const org = await prisma.org.create({ data: { name } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: `reset-disp-${org.id}@x.com`, passwordHash: "x", name: "Reset Dispatcher", orgId: org.id },
  });
  return { org, dispatcher };
}

describe("resetDemo — fixtures", () => {
  it("creates the customer, policy, experiment, driver, equipment and demo load with the exact brief values", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();

    const story = await resetDemo(org.id, dispatcher.id);

    expect(story.stage).toBe("uncovered");
    expect(story.loadId).toBeTruthy();
    expect(story.driverId).toBeTruthy();
    expect(story).toMatchObject({ breakdownAtFraction: 0.05, breakdownTriggeredAt: null, holdStartedAt: null, error: null });

    const customer = await prisma.customer.findUniqueOrThrow({ where: { orgId_name: { orgId: org.id, name: DEMO_CUSTOMER_NAME } } });
    expect(customer).toMatchObject({ primaryEmail: DEMO_CUSTOMER_EMAIL, requiresDelayNotification: true, priority: "high" });
    expect(story.customerId).toBe(customer.id);

    const policy = await prisma.agentPolicy.findUniqueOrThrow({ where: { orgId_name: { orgId: org.id, name: DEMO_POLICY_NAME } } });
    expect(policy).toMatchObject({
      stopMin: 1, delayMin: 120, darkMin: 10, darkAtStopMin: 10, offRouteMi: 25, offRouteMin: 10,
      rungGapMin: 1, maxCalls: 0, shadow: true, customerEmailOn: false, bossCallOn: false,
      dispatcherEmail: dispatcher.email,
    });
    expect(story.policyId).toBe(policy.id);

    const experiment = await prisma.aiExperiment.findFirstOrThrow({ where: { orgId: org.id, name: "Demo" } });
    expect(experiment.promptVersion).toBe("dispatch-v2");
    expect(story.experimentId).toBe(experiment.id);

    const driver = await prisma.driver.findUniqueOrThrow({ where: { email: demoDriverEmail(org.id) }, include: { hos: true, availability: true, preference: true } });
    expect(driver).toMatchObject({
      name: "John Carter", externalId: DEMO_DRIVER_EXTERNAL_ID, phone: "+15550100001", cdlClass: "A",
      homeBase: "Chicago, IL", lastLat: 41.88, lastLng: -87.98, status: "available",
    });
    expect(driver.equipmentTypes).toEqual(["DryVan", "Reefer"]);
    expect(driver.languages).toEqual(["en"]);
    expect(driver.hos).toMatchObject({ driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 3600, minutesSinceBreak: 0 });
    expect(driver.availability).toMatchObject({ acceptingLoads: true, availabilityStatus: "AVAILABLE", locationSharingEnabled: true, source: "manual" });
    expect(driver.preference).toMatchObject({ preferredEquipment: ["DryVan", "Reefer"], avoidLanes: [], avoidRegions: [] });
    expect(story.driverId).toBe(driver.id);

    const tractor = await prisma.tractor.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRACTOR_UNIT } });
    expect(tractor.status).toBe("active");
    const trailer = await prisma.trailer.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRAILER_UNIT } });
    expect(trailer).toMatchObject({ status: "active", type: "DryVan" });

    const load = await prisma.load.findUniqueOrThrow({
      where: { id: story.loadId! },
      include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } },
    });
    expect(load).toMatchObject({
      externalId: DEMO_LOAD_REF, orderRef: DEMO_LOAD_REF, requiredEquip: "DryVan", status: "open", customerName: "Demo Customer",
      customerEmail: DEMO_CUSTOMER_EMAIL, customerId: customer.id, agentEnabled: false, agentPill: "off", revenueCents: 185_000,
    });
    expect(load.stops).toHaveLength(2);
    const [pickup, delivery] = load.stops;
    expect(pickup).toMatchObject({ type: "pickup", address: "2100 S Western Ave, Chicago, IL 60608", lat: 41.8532, lng: -87.6857, geocodeStatus: "ok", dwellMin: 45 });
    expect(pickup!.appointment).toBeTruthy();
    expect(delivery).toMatchObject({ type: "delivery", address: "1 Woodward Ave, Detroit, MI 48226", lat: 42.329, lng: -83.045, geocodeStatus: "ok" });
    expect(delivery!.appointment).toBeTruthy();

    const simState = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(simState).toMatchObject({ running: false, speed: 1, simMinutesAdvanced: 0 });

    expect(story.log).toEqual([
      expect.objectContaining({ stage: "uncovered", text: `Load ${DEMO_LOAD_REF} (Chicago → Detroit) is uncovered.` }),
    ]);
  });

  it("leaves the delivery window generous at reset — approval is what tightens it", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const before = Date.now();
    const story = await resetDemo(org.id, dispatcher.id);

    const delivery = await prisma.loadStop.findFirstOrThrow({ where: { loadId: story.loadId!, type: "delivery" }, include: { appointment: true } });
    const pickup = await prisma.loadStop.findFirstOrThrow({ where: { loadId: story.loadId!, type: "pickup" }, include: { appointment: true } });

    // A full day out: wide enough that the assignment endpoint's own
    // feasibility guard books the run whenever the presenter gets to it.
    expect(Math.abs(delivery.appointment!.windowEnd.getTime() - (before + 24 * 60 * 60_000))).toBeLessThan(60_000);
    expect(delivery.appointment!.windowStart).toBeNull();
    expect(delivery.appointment!.windowEnd.getTime()).toBeGreaterThan(pickup.appointment!.windowEnd.getTime());
  });

  it("creates ten historical loads, nine on time and one 25 minutes late", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    await resetDemo(org.id, dispatcher.id);

    const historical = await prisma.load.findMany({
      where: { orgId: org.id, externalId: { startsWith: DEMO_HIST_PREFIX } },
      include: { assignment: true, stops: { include: { appointment: true } } },
    });
    expect(historical).toHaveLength(10);
    for (const load of historical) {
      expect(load.status).toBe("delivered");
      expect(load.assignment?.status).toBe("completed");
    }

    let onTime = 0;
    let lateBy25 = 0;
    for (const load of historical) {
      const delivery = load.stops.find((s) => s.type === "delivery")!;
      const completedAt = load.assignment!.completedAt!.getTime();
      const windowEnd = delivery.appointment!.windowEnd.getTime();
      if (completedAt <= windowEnd) onTime++;
      else if (Math.abs(completedAt - windowEnd - 25 * 60_000) < 1000) lateBy25++;
    }
    expect(onTime).toBe(9);
    expect(lateBy25).toBe(1);
  });
});

describe("resetDemo — idempotency", () => {
  it("keeps the same load and driver row id across resets; recreates historical loads under new ids", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();

    const first = await resetDemo(org.id, dispatcher.id);
    const firstHistorical = await prisma.load.findMany({ where: { orgId: org.id, externalId: { startsWith: DEMO_HIST_PREFIX } }, select: { id: true } });

    const second = await resetDemo(org.id, dispatcher.id);
    const secondHistorical = await prisma.load.findMany({ where: { orgId: org.id, externalId: { startsWith: DEMO_HIST_PREFIX } }, select: { id: true } });

    expect(second.loadId).toBe(first.loadId);
    expect(second.driverId).toBe(first.driverId);
    expect(secondHistorical).toHaveLength(10);
    const firstIds = new Set(firstHistorical.map((l) => l.id));
    for (const l of secondHistorical) expect(firstIds.has(l.id)).toBe(false);

    // The log restarts fresh, not accumulating across resets.
    expect((second.log as unknown[]).length).toBe(1);

    const loadCountForOrg = await prisma.load.count({ where: { orgId: org.id } });
    // 10 historical + 1 demo load — the first reset's own 10 historical rows
    // must actually be gone, not merely superseded.
    expect(loadCountForOrg).toBe(11);
  });
});

describe("resetDemo — recovers from any prior state", () => {
  it("cleans up a running sim, a live Night Shift trip, a queued AI run, an in-progress assignment and a load lock", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const loadId = first.loadId!;
    const driverId = first.driverId!;

    // A running sim.
    startRunner(org.id, 5);
    await prisma.simulationState.update({ where: { orgId: org.id }, data: { running: true, speed: 5, simMinutesAdvanced: 42 } });

    // An in-progress assignment on the demo load.
    const tractor = await prisma.tractor.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRACTOR_UNIT } });
    const trailer = await prisma.trailer.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRAILER_UNIT } });
    const assignment = await prisma.assignment.create({
      data: {
        orgId: org.id, loadId, driverId, tractorId: tractor.id, trailerId: trailer.id,
        plannedStart: new Date(Date.now() - 30 * 60_000), plannedEnd: new Date(Date.now() + 90 * 60_000),
        status: "in_progress", startedAt: new Date(),
      },
    });
    await prisma.load.update({ where: { id: loadId }, data: { status: "in_progress", agentEnabled: true, agentPill: "watching" } });

    // A live Night Shift trip with events.
    const trip = await prisma.agentTrip.create({
      data: { id: "demo-reset-trip-1", loadRef: DEMO_LOAD_REF, loadId, driverToken: "demo-reset-token-1", brief: {}, status: "tracking" },
    });
    await prisma.agentEvent.create({ data: { tripId: trip.id, atMs: BigInt(Date.now()), kind: "anomaly", evidence: { kind: "unplanned_stop" } } });

    // A queued AI run.
    const run = await prisma.aiDecisionRecord.create({
      data: { experimentId: first.experimentId!, orgId: org.id, loadId, kind: "dispatch_candidate", status: "queued", context: {}, toolCalls: [], toolResults: [] },
    });
    await prisma.demoStory.update({ where: { orgId: org.id }, data: { runId: run.id, stage: "in_transit" } });

    // A load lock held by ANOTHER dispatcher (which refuses every writer,
    // system sources included), a stale unapplied command from the previous
    // run, and a sim perturbation on the driver.
    const other = await prisma.dispatcher.create({ data: { email: `reset-other-${org.id}@x.com`, passwordHash: "x", name: "Other Dispatcher", orgId: org.id } });
    await prisma.loadLock.create({ data: { loadId, orgId: org.id, dispatcherId: other.id, dispatcherName: other.name, expiresAt: new Date(Date.now() + 60_000) } });
    const staleCommand = await prisma.agentCommand.create({ data: { loadId, kind: "send_customer_email", actorName: "previous run" } });
    await prisma.simDriverState.create({ data: { driverId, mode: "stopped" } });
    await prisma.driverLocation.create({ data: { driverId, latitude: 42, longitude: -85 } });

    const second = await resetDemo(org.id, dispatcher.id);

    expect(second.loadId).toBe(loadId); // same row, not a new one
    expect(second.stage).toBe("uncovered");
    expect(runnerState(org.id).running).toBe(false);

    const freshLoad = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    expect(freshLoad).toMatchObject({ status: "open", agentEnabled: false, agentPill: "off" });

    expect(await prisma.assignment.findUnique({ where: { id: assignment.id } })).toBeNull();
    expect(await prisma.agentTrip.findUnique({ where: { id: trip.id } })).toBeNull();
    expect(await prisma.agentEvent.count({ where: { tripId: trip.id } })).toBe(0);
    expect(await prisma.loadLock.findUnique({ where: { loadId } })).toBeNull();
    // The stale command is gone; the switch-off (which the lock could not
    // block, having been cleared first) queued exactly one fresh `stop`.
    expect(await prisma.agentCommand.findUnique({ where: { id: staleCommand.id } })).toBeNull();
    const pending = await prisma.agentCommand.findMany({ where: { loadId, appliedAt: null } });
    expect(pending.map((c) => c.kind)).toEqual(["stop"]);
    expect(await prisma.simDriverState.findUnique({ where: { driverId } })).toBeNull();
    expect(await prisma.driverLocation.count({ where: { driverId } })).toBe(0);

    // cancelRun runs first (so an actively-executing harness loop is told to
    // stop before its own row disappears from under it), then the brief's
    // own purge list deletes the AiDecisionRecord outright — "cancelled" is
    // an intermediate state on the way to gone, not the end state reset
    // leaves behind.
    expect(await prisma.aiDecisionRecord.findUnique({ where: { id: run.id } })).toBeNull();

    const simState = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(simState).toMatchObject({ running: false, speed: 1, simMinutesAdvanced: 0 });
  });

  it("succeeds even when nothing has ever been reset for this org before", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    await expect(resetDemo(org.id, dispatcher.id)).resolves.toMatchObject({ stage: "uncovered" });
  });

  it("a stale runId this process never owned (orphaned by a restart) does not fail reset — cancelRun's own DB reclaim runs cleanly before the row is deleted", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const run = await prisma.aiDecisionRecord.create({
      data: { experimentId: first.experimentId!, orgId: org.id, loadId: first.loadId, kind: "dispatch_candidate", status: "running", context: {}, toolCalls: [], toolResults: [] },
    });
    await prisma.demoStory.update({ where: { orgId: org.id }, data: { runId: run.id } });

    await expect(resetDemo(org.id, dispatcher.id)).resolves.toMatchObject({ stage: "uncovered" });

    expect(await prisma.aiDecisionRecord.findUnique({ where: { id: run.id } })).toBeNull();
    // A runId that no longer resolves to anything (this run's own row is
    // already gone) is exactly what a THIRD reset must also tolerate.
    expect(await cancelRun(org.id, run.id)).toBe(false);
  });

  it("purges a Rate row a previous commit left behind — the load keeps its row id, but a stale Rate must not survive to block the next commit", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const loadId = first.loadId!;

    // Shaped like the commit transaction's own tx.rate.create
    // (dispatcherAssignments.ts, POST /assignments) — Rate.loadId is the
    // row's own @id, with no cascade from Assignment, so it outlives an
    // Assignment purge unless reset deletes it in its own right.
    await prisma.rate.create({
      data: {
        loadId,
        linehaulCents: 185_000,
        fscCents: 0,
        totalMi: 300,
        loadedMi: 280,
        deadheadMi: 20,
        ratePerLoadedMiCents: 660,
        estCostCents: 50_000,
        marginCents: 30_000,
      },
    });

    const second = await resetDemo(org.id, dispatcher.id);

    expect(second.loadId).toBe(loadId); // the demo load keeps its row id across resets, by design
    expect(await prisma.rate.findUnique({ where: { loadId } })).toBeNull();
  });

  it("purges the previous run's Assignment/Rate on the rebuilt load even with the DemoStory row itself deleted (finding F3/M3)", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const loadId = first.loadId!;
    const driverId = first.driverId!;

    const tractor = await prisma.tractor.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRACTOR_UNIT } });
    const trailer = await prisma.trailer.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRAILER_UNIT } });
    const assignment = await prisma.assignment.create({
      data: {
        orgId: org.id, loadId, driverId, tractorId: tractor.id, trailerId: trailer.id,
        plannedStart: new Date(), plannedEnd: new Date(Date.now() + 60 * 60_000), status: "assigned",
      },
    });
    await prisma.rate.create({
      data: {
        loadId, linehaulCents: 185_000, fscCents: 0, totalMi: 300, loadedMi: 280, deadheadMi: 20,
        ratePerLoadedMiCents: 660, estCostCents: 50_000, marginCents: 30_000,
      },
    });

    // The DemoStory row itself is gone — the purge must still find the same
    // load/driver by their fixture identities (orgId_externalId, the
    // deterministic driver email), not by a row that no longer exists.
    await prisma.demoStory.delete({ where: { orgId: org.id } });

    const second = await resetDemo(org.id, dispatcher.id);

    expect(second.loadId).toBe(loadId); // the demo load keeps its row id even through this path
    expect(await prisma.assignment.findUnique({ where: { id: assignment.id } })).toBeNull();
    expect(await prisma.rate.findUnique({ where: { loadId } })).toBeNull();
  });
});

describe("resetDemo — a second Reset inside the release window (finding F1/I1)", () => {
  it("keeps the pending stop and still reports night_shift_releasing, purging every other command row (finding F1/M8)", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const loadId = first.loadId!;
    const driverId = first.driverId!;

    // Put the load in a state with the agent on — an in-progress assignment
    // plus the real switch, the same two things `recordApproval` does
    // before a run starts.
    const tractor = await prisma.tractor.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRACTOR_UNIT } });
    const trailer = await prisma.trailer.findFirstOrThrow({ where: { orgId: org.id, unit: DEMO_TRAILER_UNIT } });
    await prisma.assignment.create({
      data: {
        orgId: org.id, loadId, driverId, tractorId: tractor.id, trailerId: trailer.id,
        plannedStart: new Date(), plannedEnd: new Date(Date.now() + 60 * 60_000), status: "in_progress", startedAt: new Date(),
      },
    });
    await switchAgentOn(org.id, loadId, first.policyId);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).agentEnabled).toBe(true);

    // Reset #1, from live: switches the agent off, leaving exactly one
    // pending `stop` (the release fence).
    await resetDemo(org.id, dispatcher.id);
    const afterFirst = await prisma.agentCommand.findMany({ where: { loadId, appliedAt: null } });
    expect(afterFirst.map((c) => c.kind)).toEqual(["stop"]);
    expect(await isNightShiftReleasing(loadId, Date.now())).toBe(true);

    // Reset #2, seconds later: the pending `stop` must survive, and the
    // release gate must still report true.
    const second = await resetDemo(org.id, dispatcher.id);
    expect(second.stage).toBe("uncovered");

    const pending = await prisma.agentCommand.findMany({ where: { loadId, appliedAt: null } });
    expect(pending.map((c) => c.kind)).toEqual(["stop"]);
    expect(await isNightShiftReleasing(loadId, Date.now())).toBe(true);

    // No non-stop command rows survive the second reset either.
    const nonStop = await prisma.agentCommand.count({ where: { loadId, NOT: { kind: "stop" } } });
    expect(nonStop).toBe(0);
  });

  it("bumps the demo Load's version on every reset that rewrites it in place (finding F12/M12)", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const afterFirst = await prisma.load.findUniqueOrThrow({ where: { id: first.loadId! }, select: { version: true } });

    const second = await resetDemo(org.id, dispatcher.id);
    const afterSecond = await prisma.load.findUniqueOrThrow({ where: { id: second.loadId! }, select: { version: true } });

    expect(afterSecond.version).toBeGreaterThan(afterFirst.version);
  });
});

describe("resetDemo — mid-flight FK race on the timeline purge (finding F4/M4)", () => {
  let armed = false;
  let attempts = 0;

  beforeAll(() => {
    prisma.$use(async (params, next) => {
      if (armed && params.model === "AgentTrip" && params.action === "deleteMany") {
        attempts += 1;
        if (attempts === 1) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Foreign key constraint failed on the field: `AgentEvent_tripId_fkey (index)` (simulated worker race)",
            { code: "P2003", clientVersion: "5.22.0" },
          );
        }
        armed = false; // disarm once it has been allowed through once
      }
      return next(params);
    });
  });

  it("retries once on a P2003 from a concurrent AgentEvent insert, and succeeds", async () => {
    const { org, dispatcher } = await seedOrgWithDispatcher();
    const first = await resetDemo(org.id, dispatcher.id);
    const loadId = first.loadId!;

    const trip = await prisma.agentTrip.create({
      data: { id: "fk-race-trip", loadRef: DEMO_LOAD_REF, loadId, driverToken: "fk-race-token", brief: {}, status: "tracking" },
    });
    await prisma.agentEvent.create({ data: { tripId: trip.id, atMs: BigInt(Date.now()), kind: "anomaly", evidence: { kind: "unplanned_stop" } } });

    attempts = 0;
    armed = true;
    const second = await resetDemo(org.id, dispatcher.id);

    expect(second.stage).toBe("uncovered");
    expect(attempts).toBe(2); // the delete was attempted twice — once rejected, once through
    expect(await prisma.agentTrip.findUnique({ where: { id: trip.id } })).toBeNull();
    expect(await prisma.agentEvent.count({ where: { tripId: trip.id } })).toBe(0);
  });
});
