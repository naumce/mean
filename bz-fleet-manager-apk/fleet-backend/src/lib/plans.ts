// Spec §4a / §7.1. Which product an org bought. Every Org is guaranteed a
// Plan row from the instant it exists by the `org_default_plan` DB trigger
// (migration 20260920103547_night_shift_sheet, tier defaults to 'tower');
// dispatcherAuth.ts's signup overwrites that default tier with an explicit
// `tx.plan.update` for the "nightshift" product. `ensurePlan` below is not
// on that path — it exists for scripts/back-fills that need the same
// create-if-missing behavior outside of an Org insert.
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export type PlanTier = "sheet" | "tower";
export const PLAN_TIERS: readonly PlanTier[] = ["sheet", "tower"];

/** Creates the org's plan if it has none. Never changes an existing tier:
 *  upgrading is a deliberate write elsewhere, not a side effect of running
 *  this. Signup does not call this — the `org_default_plan` DB trigger
 *  already created the row by the time signup's transaction would run it. */
export async function ensurePlan(tx: Prisma.TransactionClient, orgId: string, tier: PlanTier): Promise<void> {
  const existing = await tx.plan.findUnique({ where: { orgId } });
  if (!existing) await tx.plan.create({ data: { orgId, tier } });
}

export async function planOf(orgId: string): Promise<{ tier: PlanTier; loadNightCents: number | null; messagingMarkup: number; dailyCommsCapCents: number }> {
  const plan = await prisma.plan.findUnique({ where: { orgId } });
  if (!plan) throw new Error(`org ${orgId} has no plan — seed it`);
  return { tier: plan.tier as PlanTier, loadNightCents: plan.loadNightCents, messagingMarkup: plan.messagingMarkup, dailyCommsCapCents: plan.dailyCommsCapCents };
}

