import type { DemoStory } from "@prisma/client";
import { prisma } from "../../db.js";
import { harnessEnabled } from "../aiHarness/config.js";
import { suggestForLoad } from "../suggestForLoad.js";
import type { Patch, Stage } from "./types.js";
import {
  handleAwaitingCustomerUpdate, handleAwaitingDriverReply, handleBreakdownDetected, handleCustomerUpdated, handleInTransit,
} from "./observeBreakdown.js";
import { handleDelivering, handleResolved } from "./observeDelivery.js";
import { withOrgLock } from "./orgLock.js";
import { applyPatch } from "./patch.js";

// Demo Mode: the story's heartbeat. `observeStory` runs on every GET (safe
// every 3s) and is the ONLY place a stage moves forward on its own — every
// other transition is a human action (actions.ts). It reads bounded,
// load/driver-scoped rows only, and NEVER throws: any failure lands the story
// on stage "error" with `error` set, never propagates to the route.
//
// Each case below is checked ONLY while `story.stage` already equals it —
// one call advances the story by at most one stage (the "then ... and logs"
// wording on a couple of stages is the one exception: those cascade a second,
// immediate side effect of the SAME transition, not a second poll).
//
// One org's polls and actions run one at a time (orgLock.ts): two tabs
// polling the same story must never both read the same row and both decide
// the same transition.

const RUN_TIMEOUT_MS = 3 * 60_000;

export async function currentSimNowMs(orgId: string, wallNowMs: number): Promise<number> {
  const state = await prisma.simulationState.findUnique({ where: { orgId }, select: { simMinutesAdvanced: true } });
  return wallNowMs + (state?.simMinutesAdvanced ?? 0) * 60_000;
}

function hasPhone(phone: string | null | undefined): boolean {
  return phone != null && phone.trim() !== "";
}

/** reachable-fix-brief.md (2026-09-28): Night Shift cannot contact a driver
 *  with no phone on file (`night-shift/src/live/platformLoads.ts`
 *  `buildBrief`) — recommending one stalls the demo forever on "In transit".
 *  The dispatch fallback (`suggestForLoad`) is filtered here to the first
 *  FEASIBLE candidate whose driver also has a phone, via one `driver.
 *  findMany` lookup rather than a lookup per candidate. Candidates are kept
 *  in `suggestForLoad`'s own order — first feasible-and-reachable wins,
 *  same "top of the list" rule the unfiltered fallback always used. */
async function reachableCandidate(
  orgId: string,
  loadId: string,
  nowMs: number,
): Promise<{ driverId: string; driverName: string | null } | null> {
  const result = await suggestForLoad(orgId, loadId, nowMs);
  const feasible = result?.candidates.filter((c) => c.feasible) ?? [];
  if (feasible.length === 0) return null;

  const phoneRows = await prisma.driver.findMany({
    where: { id: { in: feasible.map((c) => c.driverId) } },
    select: { id: true, phone: true },
  });
  const phoneById = new Map(phoneRows.map((d) => [d.id, d.phone]));

  const reachable = feasible.find((c) => hasPhone(phoneById.get(c.driverId)));
  return reachable ? { driverId: reachable.driverId, driverName: reachable.driverName } : null;
}

async function handleAiRecommendation(orgId: string, story: DemoStory, nowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  const run = story.runId ? await prisma.aiDecisionRecord.findUnique({ where: { id: story.runId } }) : null;
  const terminal = run != null && run.status !== "queued" && run.status !== "running";
  const timedOut = run != null && nowMs - run.proposedAt.getTime() > RUN_TIMEOUT_MS;

  if (run && terminal && run.status === "proposed" && run.driverId) {
    const driver = await prisma.driver.findUnique({ where: { id: run.driverId }, select: { name: true, phone: true } });
    const confidence = run.confidence != null ? run.confidence.toFixed(2) : "unknown";
    const driverName = driver?.name ?? "a driver";

    if (hasPhone(driver?.phone)) {
      return {
        stage: "awaiting_approval",
        recommendedDriverId: run.driverId,
        recommendationSource: "ai",
        logTexts: [`AI recommends ${driverName} (confidence ${confidence}).`],
      };
    }

    // The AI's pick has no phone on file — Night Shift could never reach
    // them. Fall back to a reachable dispatch recommendation, but keep
    // `runId` untouched so the AI Lab link still shows the run that fired.
    const fallback = await reachableCandidate(orgId, story.loadId, nowMs);
    return {
      stage: "awaiting_approval",
      recommendedDriverId: fallback?.driverId ?? null,
      recommendationSource: "engine",
      logTexts: [
        fallback
          ? `AI recommends ${driverName} (confidence ${confidence}), but Night Shift has no phone on file for them — using the dispatch recommendation instead: ${fallback.driverName ?? "a driver"}.`
          : `AI recommends ${driverName} (confidence ${confidence}), but Night Shift has no phone on file for them — no reachable driver is available.`,
      ],
    };
  }

  if (!harnessEnabled() || run == null || terminal || timedOut) {
    const fallback = await reachableCandidate(orgId, story.loadId, nowMs);
    return {
      stage: "awaiting_approval",
      recommendedDriverId: fallback?.driverId ?? null,
      recommendationSource: "engine",
      logTexts: [
        fallback
          ? `AI unavailable — using the dispatch recommendation: ${fallback.driverName ?? "a driver"}.`
          : "AI unavailable — no reachable driver is available.",
      ],
    };
  }

  return null; // still queued/running, under the timeout — keep waiting
}

async function transitionFor(orgId: string, story: DemoStory, simNowMs: number, wallNowMs: number): Promise<Patch | null> {
  switch (story.stage as Stage) {
    case "ai_recommendation": return handleAiRecommendation(orgId, story, wallNowMs);
    case "in_transit": return handleInTransit(orgId, story, simNowMs, wallNowMs);
    case "breakdown_detected": return handleBreakdownDetected(orgId, story, wallNowMs);
    case "awaiting_driver_reply": return handleAwaitingDriverReply(orgId, story, wallNowMs);
    case "awaiting_customer_update": return handleAwaitingCustomerUpdate(orgId, story, wallNowMs);
    case "customer_updated": return handleCustomerUpdated(orgId, story, simNowMs, wallNowMs);
    case "resolved": return handleResolved(orgId, story, simNowMs, wallNowMs);
    case "delivering": return handleDelivering(orgId, story, simNowMs, wallNowMs);
    default: return null; // uncovered/awaiting_approval/delivered/error: action-driven or terminal, not this heartbeat's job
  }
}

async function observeUnlocked(orgId: string, nowMs: number): Promise<DemoStory | null> {
  const story = await prisma.demoStory.findUnique({ where: { orgId } });
  if (!story) return null;

  try {
    const simNowMs = await currentSimNowMs(orgId, nowMs);
    const patch = await transitionFor(orgId, story, simNowMs, nowMs);
    if (!patch) return story;
    return await applyPatch(orgId, story, patch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`demo story observe failed for org ${orgId}`, err);
    return prisma.demoStory.update({ where: { orgId }, data: { stage: "error", error: message } });
  }
}

/**
 * The story's heartbeat. Returns `null` when no story has ever been started
 * for this org (nothing to observe until the first Reset) — that is not an
 * error, so it is not what lands a story on stage "error". `nowMs` is the
 * wall clock for this poll; it is taken once the org's turn comes, not when
 * the call queued behind another one.
 */
export function observeStory(orgId: string, nowMs?: number): Promise<DemoStory | null> {
  return withOrgLock(orgId, () => observeUnlocked(orgId, nowMs ?? Date.now()));
}
