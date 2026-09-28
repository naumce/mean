import type { DemoStory } from "@prisma/client";
import { prisma } from "../../db.js";
import type { Actor } from "../loadWriter.js";
import { upsertCustomer, upsertDriver, upsertEquipment, upsertExperiment, upsertPolicy, DEMO_LOAD_REF } from "./fixtures.js";
import { upsertDemoLoad } from "./fixturesDemoLoad.js";
import { rebuildHistoricalLoads } from "./fixturesHistory.js";
import { withOrgLock } from "./orgLock.js";
import { purgeDemoStory } from "./resetPurge.js";
import { firstLogEntry } from "./log.js";

// Demo Mode: `resetDemo` is the ONLY writer of DemoStory.stage back to
// "uncovered" — everything else (observeStory, actions.ts) only ever moves it
// forward. Must succeed from ANY prior state: a running sim, a live Night
// Shift trip, a queued/running AI run, an in-progress assignment, a load
// lock. Takes the org's turn (orgLock.ts) like every other story write, so a
// poll can never land between the purge and the fresh row.

/** Where in the plan (plannedStart..plannedEnd) the scripted breakdown fires:
 *  shortly after departure, so the truck is still hours of road from
 *  delivery when Night Shift checks its wall-clock ETA against the tightened
 *  window (actions.ts) — the further along the frozen truck sat, the less
 *  often that ETA would miss it. */
const BREAKDOWN_AT_FRACTION = 0.05;

async function actorFor(dispatcherId: string): Promise<Actor> {
  const dispatcher = await prisma.dispatcher.findUnique({ where: { id: dispatcherId }, select: { name: true } });
  return { dispatcherId, name: dispatcher?.name ?? "dispatcher" };
}

async function resetUnlocked(orgId: string, dispatcherId: string): Promise<DemoStory> {
  const actor = await actorFor(dispatcherId);
  await purgeDemoStory(orgId, actor);

  const customer = await upsertCustomer(orgId);
  const policy = await upsertPolicy(orgId);
  const experiment = await upsertExperiment(orgId);
  const driver = await upsertDriver(orgId);
  const equipment = await upsertEquipment(orgId);

  await rebuildHistoricalLoads(orgId, driver.id, equipment.tractorId, equipment.trailerId);
  const load = await upsertDemoLoad(orgId, customer.id);

  await prisma.simulationState.upsert({
    where: { orgId },
    update: { running: false, speed: 1, simMinutesAdvanced: 0, lastTickAt: null },
    create: { orgId },
  });

  const openingLine = firstLogEntry("uncovered", `Load ${DEMO_LOAD_REF} (Chicago → Detroit) is uncovered.`);
  return prisma.demoStory.upsert({
    where: { orgId },
    update: {
      stage: "uncovered",
      loadId: load.id, driverId: driver.id, assignmentId: null, runId: null,
      experimentId: experiment.id, policyId: policy.id, customerId: customer.id,
      recommendedDriverId: null, recommendationSource: null,
      breakdownAtFraction: BREAKDOWN_AT_FRACTION, breakdownTriggeredAt: null, holdStartedAt: null, error: null,
      log: openingLine,
      startedAt: new Date(),
    },
    create: {
      orgId, stage: "uncovered",
      loadId: load.id, driverId: driver.id,
      experimentId: experiment.id, policyId: policy.id, customerId: customer.id,
      breakdownAtFraction: BREAKDOWN_AT_FRACTION,
      log: openingLine,
      startedAt: new Date(),
    },
  });
}

export function resetDemo(orgId: string, dispatcherId: string): Promise<DemoStory> {
  return withOrgLock(orgId, () => resetUnlocked(orgId, dispatcherId));
}
