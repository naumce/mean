import { prisma } from "../../src/db.js";
import type { ChatResponse } from "../../src/lib/aiHarness/types.js";

// tests/helpers/aiHarnessFixture.ts (Qwen Harness v0.1, Task 6): the org +
// tractor/trailer + feasible/blocked driver + Reefer load fixture shared by
// this task's three test files (runner, routes, evaluation), following the
// exact seeding shape tests/ai-harness-baseline.test.ts (Task 4) and
// tests/ai-harness-loop.test.ts (Task 5) already established, plus a couple
// of scripted-adapter response builders and a poll helper for waiting on the
// in-process runner's background work. Not a *.test.ts file, so vitest's
// test glob never collects it — the same convention scriptedAdapter.ts and
// memoryRunStore.ts already use.

export const CHICAGO = { lat: 41.8781, lng: -87.6298, address: "123 Dock Rd, Chicago, IL 60601" };
export const NASHVILLE = { lat: 36.1627, lng: -86.7816, address: "456 Warehouse Ave, Nashville, TN 37201" };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

export async function seedAiHarnessFixture(orgName: string) {
  const org = await prisma.org.create({ data: { name: orgName } });
  await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "Reefer", status: "active" } });

  const feasible = await prisma.driver.create({
    data: {
      email: `feasible@${org.id}.example`, passwordHash: "x", name: "Feasible Driver", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng, hos: { create: FRESH_HOS },
    },
  });
  await prisma.driverAvailability.create({
    data: { driverId: feasible.id, source: "manual", acceptingLoads: true, availabilityStatus: "AVAILABLE" },
  });

  const blocked = await prisma.driver.create({
    data: {
      email: `blocked@${org.id}.example`, passwordHash: "x", name: "Blocked Driver", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng, hos: { create: { ...FRESH_HOS, driveRemainingMin: 30 } },
    },
  });

  return { org, feasible, blocked };
}

/** A load whose first/last stop is the same fixed Chicago -> Nashville lane
 *  every seeded driver above was positioned/HOS'd against — `externalId`
 *  lets each test tell its own loads apart in assertions. `status` defaults
 *  to "open" (a real, uncovered load); a test that needs a load to exist and
 *  be runnable WITHOUT showing up in getUncoveredLoads (fix round 1's
 *  batch-cap test) overrides it to anything else — isUncovered requires
 *  status === "open" as its first condition, so any other value excludes it
 *  regardless of assignment. */
export async function createReeferLoad(orgId: string, externalId: string, overrides: { status?: string } = {}) {
  return prisma.load.create({
    data: {
      orgId, externalId, requiredEquip: "Reefer", revenueCents: 60000, status: overrides.status ?? "open",
      stops: {
        create: [
          {
            sequence: 1, type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } },
          },
          {
            sequence: 2, type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } },
          },
        ],
      },
    },
  });
}

/** A single-turn "Recommending <driverId>" response — the same minimal
 *  one-call-then-propose shape tests/ai-harness-loop.test.ts's own simplest
 *  case uses, relying on the seeded driver already being in the baseline's
 *  captured feasibleDriverIds rather than round-tripping findFeasibleDrivers
 *  first (that tool call is exercised exhaustively by Task 5's own suite). */
export function assistantProposeTurn(driverId: string, opts: { confidence?: number; reason?: string } = {}): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: "Recommending.",
      toolCalls: [
        {
          name: "propose_decision",
          arguments: {
            driverId,
            reason: opts.reason ?? "The only feasible driver for this load right now.",
            confidence: opts.confidence ?? 0.75,
            alternatives: [],
          },
        },
      ],
    },
    doneReason: "tool_calls",
    stats: { promptTokens: 10, completionTokens: 5, totalDurationMs: 20 },
  };
}

/** No tool call at all, twice in a row — nudge, then no_decision (loop.ts's
 *  own rule: a turn with zero tool calls gets nudged once, a second one
 *  ends the run incomplete). */
export function noToolCallTurn(): ChatResponse {
  return {
    message: { role: "assistant", content: "Still thinking." },
    doneReason: "stop",
    stats: { promptTokens: 6, completionTokens: 3, totalDurationMs: 10 },
  };
}

/** Polls `AiDecisionRecord.status` until it is one of `statuses` — the
 *  runner drains in the background (enqueueRun returns before a run has
 *  necessarily even started), so a test that needs to observe the OUTCOME of
 *  a real run has no promise of its own to await. Real setTimeout polling
 *  (this suite runs under real timers), short interval, generous timeout. */
export async function waitForRunStatus(runId: string, statuses: readonly string[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.aiDecisionRecord.findUnique({ where: { id: runId }, select: { status: true } });
    if (row && statuses.includes(row.status)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for run ${runId} to reach one of [${statuses.join(", ")}] (last status: ${row?.status ?? "not found"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
