import { prisma } from "../src/db.js";
import { resetDemo } from "../src/lib/demoStory/index.js";
import { DEMO_TRACTOR_UNIT, DEMO_TRAILER_UNIT, DETROIT_DELIVERY } from "../src/lib/demoStory/fixtures.js";
import { stopRunner } from "../src/lib/simulation/runner.js";
import type { DemoStory, Prisma } from "@prisma/client";

// Demo Mode — shared seeding for the observeStory suites. Each test seeds a
// real story via resetDemo (so the load/driver/equipment are the genuine
// fixture, not a hand-rolled stand-in), jumps `story.stage` directly to the
// stage under test, and asserts ONE observeStory call's result. Orgs whose
// runner a test may have started are tracked so the suite's afterEach can
// stop them before resetDb runs.

export const MIN = 60_000;
export const DETROIT = { latitude: DETROIT_DELIVERY.lat, longitude: DETROIT_DELIVERY.lng };

const seededOrgIds: string[] = [];

/** Stops every runner a seeded org may have started; call from afterEach. */
export function stopSeededRunners(): void {
  for (const orgId of seededOrgIds) stopRunner(orgId);
  seededOrgIds.length = 0;
}

export async function seedStory(stage: string, patch: Prisma.DemoStoryUpdateInput = {}): Promise<{ orgId: string; story: DemoStory }> {
  const org = await prisma.org.create({ data: { name: `Observe Org ${Math.random().toString(36).slice(2)}` } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: `obs-${org.id}@x.com`, passwordHash: "x", name: "Obs Dispatcher", orgId: org.id } });
  await resetDemo(org.id, dispatcher.id);
  const story = await prisma.demoStory.update({ where: { orgId: org.id }, data: { stage, ...patch } });
  seededOrgIds.push(org.id);
  return { orgId: org.id, story };
}

export async function createAssignment(orgId: string, story: DemoStory, overrides: Partial<{ status: string; plannedStart: Date; plannedEnd: Date; startedAt: Date | null }> = {}) {
  const tractor = await prisma.tractor.findFirstOrThrow({ where: { orgId, unit: DEMO_TRACTOR_UNIT } });
  const trailer = await prisma.trailer.findFirstOrThrow({ where: { orgId, unit: DEMO_TRAILER_UNIT } });
  const plannedStart = overrides.plannedStart ?? new Date(Date.now() - 10 * MIN);
  const plannedEnd = overrides.plannedEnd ?? new Date(Date.now() + 50 * MIN);
  const status = overrides.status ?? "in_progress";
  const assignment = await prisma.assignment.create({
    data: {
      orgId, loadId: story.loadId!, driverId: story.driverId!, tractorId: tractor.id, trailerId: trailer.id,
      plannedStart, plannedEnd, status,
      startedAt: overrides.startedAt !== undefined ? overrides.startedAt : (status === "in_progress" ? plannedStart : null),
    },
  });
  await prisma.demoStory.update({ where: { orgId }, data: { assignmentId: assignment.id } });
  return assignment;
}

/** A plan whose fraction at `nowMs` (with the sim clock at zero) is exactly
 *  `fraction`, over `spanMin` minutes. */
export function planAt(nowMs: number, fraction: number, spanMin: number): { plannedStart: Date; plannedEnd: Date } {
  const plannedStart = new Date(nowMs - fraction * spanMin * MIN);
  return { plannedStart, plannedEnd: new Date(plannedStart.getTime() + spanMin * MIN) };
}

export async function createTrip(loadId: string, id = `trip-${Math.random().toString(36).slice(2)}`) {
  return prisma.agentTrip.create({ data: { id, loadRef: "DEMO-CHI-DET", loadId, driverToken: `${id}-token`, brief: {}, status: "tracking" } });
}

export async function addEvent(tripId: string, kind: string, evidence: Record<string, unknown>, atMs = Date.now()) {
  return prisma.agentEvent.create({ data: { tripId, atMs: BigInt(atMs), kind, evidence: evidence as Prisma.InputJsonValue } });
}

export const logTexts = (story: DemoStory | null | undefined): string[] => ((story?.log ?? []) as { text: string }[]).map((l) => l.text);

export const simMinutes = async (orgId: string): Promise<number> => (await prisma.simulationState.findUniqueOrThrow({ where: { orgId } })).simMinutesAdvanced;
