import { prisma } from "../../db.js";
import { applyAgentSwitch } from "../agentSwitch.js";
import { SYSTEM_ACTOR } from "../actor.js";

// Demo Mode: the story's own hands on Night Shift's switch, and the fence in
// front of it.
//
// Locks: the load writer refuses a system actor while ANY dispatcher holds
// the load — the presenter's own open editor tab included — so every switch
// the story makes clears the load's locks first, the way reset does. The
// switch is the presenter's own action here; nobody's edit is lost.
//
// The pending `stop`: the `stop` a reset queues is applied at the worker's
// next poll, and until then the worker's previous in-memory trip is still
// alive — that command (together with the load reading as switched off at
// that poll) is what ends it. A switch-on landing before that poll would
// keep the old trip alive under a new brief and block the new run. So a
// pending `stop` younger than STOP_RELEASE_WINDOW_MS (two worker polls)
// refuses approval; an older one belongs to a worker that is down or was
// restarted and has no trip left to protect, and is deleted so it cannot end
// the new run once the worker is back.

export const STOP_RELEASE_WINDOW_MS = 120_000;

const STORY_ACTOR = SYSTEM_ACTOR("demo-story");

/** Refused because the policy about to go live is not the shadow-only
 *  configuration the whole feature's safety depends on (findings I(c)/M2):
 *  a Demo Mode agent must never be able to send a real customer email,
 *  place a real call, or run under anything but shadow evaluation. The
 *  route maps this to a plain 500 (asyncRoute's terminal handler), never a
 *  crash. */
export class PolicyNotShadow extends Error {}

/** `switchAgentOn`'s own guard, checked against the CURRENT row every time
 *  (not the fixture's own upsert, which could drift or be hand-edited) —
 *  the one binding constraint of the feature is worth re-reading, not just
 *  trusting whoever set `policyId` earlier. */
async function assertPolicyIsShadow(orgId: string, policyId: string | null): Promise<void> {
  if (!policyId) throw new PolicyNotShadow("Demo Mode has no agent policy set for this load — reset the demo first.");
  const policy = await prisma.agentPolicy.findFirst({ where: { id: policyId, orgId } });
  if (!policy) throw new PolicyNotShadow(`Agent policy ${policyId} was not found for this org.`);
  const isShadowSafe = policy.shadow === true && policy.customerEmailOn === false && policy.bossCallOn === false && policy.maxCalls === 0;
  if (!isShadowSafe) {
    throw new PolicyNotShadow("Demo Mode's agent policy is not shadow-only (shadow off, a real customer email/boss call enabled, or maxCalls above 0) — refusing to switch Night Shift on.");
  }
}

export async function clearLoadLocks(loadId: string): Promise<void> {
  await prisma.loadLock.deleteMany({ where: { loadId } });
}

/** The load's unapplied `stop` commands, split by age against
 *  STOP_RELEASE_WINDOW_MS. */
export async function pendingStops(loadId: string, nowMs: number): Promise<{ fresh: string[]; stale: string[] }> {
  const rows = await prisma.agentCommand.findMany({ where: { loadId, kind: "stop", appliedAt: null }, select: { id: true, createdAt: true } });
  const fresh = rows.filter((r) => nowMs - r.createdAt.getTime() < STOP_RELEASE_WINDOW_MS).map((r) => r.id);
  const stale = rows.filter((r) => nowMs - r.createdAt.getTime() >= STOP_RELEASE_WINDOW_MS).map((r) => r.id);
  return { fresh, stale };
}

/** True while the worker may still be releasing the previous run. */
export async function isNightShiftReleasing(loadId: string, nowMs: number): Promise<boolean> {
  return (await pendingStops(loadId, nowMs)).fresh.length > 0;
}

export async function switchAgentOn(orgId: string, loadId: string, policyId: string | null): Promise<void> {
  await assertPolicyIsShadow(orgId, policyId);
  await clearLoadLocks(loadId);
  await prisma.$transaction((tx) =>
    applyAgentSwitch(tx, {
      loadId, orgId, actor: STORY_ACTOR, source: "loadboard", enabled: true,
      ...(policyId ? { policyId } : {}),
    }),
  );
}

/** Switches the demo load's agent off through the real service (which also
 *  queues the worker's own `stop`), so an unattended trip never outlives the
 *  load and raises a gone-dark on the timeline the presenter links to. */
export async function switchAgentOff(orgId: string, loadId: string): Promise<void> {
  const load = await prisma.load.findUnique({ where: { id: loadId }, select: { agentEnabled: true } });
  if (!load?.agentEnabled) return;
  await clearLoadLocks(loadId);
  await prisma.$transaction((tx) =>
    applyAgentSwitch(tx, { loadId, orgId, actor: STORY_ACTOR, source: "loadboard", enabled: false }),
  );
}
