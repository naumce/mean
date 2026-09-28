import type { DemoStory, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { appendLogs, asJson, logEntries } from "./log.js";
import type { Patch } from "./types.js";

// Demo Mode: the one place a `Patch` (a heartbeat transition from observe, a
// human action from actions.ts) becomes a DemoStory write. Shared so no two
// callers can drift on how a patch is applied, and so every write carries the
// same compare-and-set guard.
//
// The guard: the write is conditioned on `updatedAt` still being the value
// the caller read. Two writers holding the same stale copy (two backend
// processes polling the same org) would otherwise both append their log line
// and the later one would silently drop the earlier one's. On a conflict the
// row is re-read and the patch applied once against the fresh copy — unless
// the fresh copy shows the other writer already made this very transition, in
// which case the patch is dropped and the fresh row returned as-is. The
// in-process mutex (orgLock.ts) makes conflicts rare; this makes them safe.

const MAX_ATTEMPTS = 3;

function dataFor(story: DemoStory, patch: Patch): Prisma.DemoStoryUpdateManyMutationInput | null {
  const nextStage = patch.stage ?? story.stage;
  const entries = patch.logTexts?.length ? appendLogs(story.log, nextStage, patch.logTexts) : null;
  const logGrew = entries != null && entries.length > logEntries(story.log).length;

  const data: Prisma.DemoStoryUpdateManyMutationInput = {
    ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
    ...(patch.recommendedDriverId !== undefined ? { recommendedDriverId: patch.recommendedDriverId } : {}),
    ...(patch.recommendationSource !== undefined ? { recommendationSource: patch.recommendationSource } : {}),
    ...(patch.holdStartedAt !== undefined ? { holdStartedAt: patch.holdStartedAt } : {}),
    ...(patch.breakdownTriggeredAt !== undefined ? { breakdownTriggeredAt: patch.breakdownTriggeredAt } : {}),
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.assignmentId !== undefined ? { assignmentId: patch.assignmentId } : {}),
    ...(patch.driverId !== undefined ? { driverId: patch.driverId } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(logGrew ? { log: asJson(entries) } : {}),
  };
  return Object.keys(data).length > 0 ? data : null;
}

export async function applyPatch(orgId: string, story: DemoStory, patch: Patch): Promise<DemoStory> {
  let current = story;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const data = dataFor(current, patch);
    if (!data) return current; // nothing new to write (every log line already present)

    const { count } = await prisma.demoStory.updateMany({ where: { orgId, updatedAt: current.updatedAt }, data });
    if (count === 1) return prisma.demoStory.findUniqueOrThrow({ where: { orgId } });

    const fresh = await prisma.demoStory.findUniqueOrThrow({ where: { orgId } });
    if (patch.stage !== undefined && fresh.stage !== current.stage) {
      console.warn(`demo story: another writer already moved org ${orgId} from "${current.stage}" to "${fresh.stage}" — dropping a duplicate "${patch.stage}" transition`);
      return fresh;
    }
    current = fresh;
  }
  console.warn(`demo story: gave up applying a patch for org ${orgId} after ${MAX_ATTEMPTS} conflicting writes`);
  return current;
}
