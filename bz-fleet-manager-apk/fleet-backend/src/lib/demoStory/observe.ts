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

async function handleAiRecommendation(orgId: string, story: DemoStory, nowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  const run = story.runId ? await prisma.aiDecisionRecord.findUnique({ where: { id: story.runId } }) : null;
  const terminal = run != null && run.status !== "queued" && run.status !== "running";
  const timedOut = run != null && nowMs - run.proposedAt.getTime() > RUN_TIMEOUT_MS;

  if (run && terminal && run.status === "proposed" && run.driverId) {
    const driver = await prisma.driver.findUnique({ where: { id: run.driverId }, select: { name: true } });
    const confidence = run.confidence != null ? run.confidence.toFixed(2) : "unknown";
    return {
      stage: "awaiting_approval",
      recommendedDriverId: run.driverId,
      recommendationSource: "ai",
      logTexts: [`AI recommends ${driver?.name ?? "a driver"} (confidence ${confidence}).`],
    };
  }

  if (!harnessEnabled() || run == null || terminal || timedOut) {
    const result = await suggestForLoad(orgId, story.loadId, nowMs);
    const top = result?.candidates.find((c) => c.feasible) ?? null;
    return {
      stage: "awaiting_approval",
      recommendedDriverId: top?.driverId ?? null,
      recommendationSource: "engine",
      logTexts: [
        top
          ? `AI unavailable — using the deterministic recommendation: ${top.driverName ?? "a driver"}.`
          : "AI unavailable — the deterministic recommendation found no feasible driver.",
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
