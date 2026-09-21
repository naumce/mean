// The switch (spec §17.2), extracted out of the HTTP route (Task 3's POST
// /loads/:id/agent) so the sheet's own switch read (Task 9, sync.ts) can flip
// it through the exact same code path with `source: "sheet"` instead of a
// second, drifting copy of this logic. Everything here runs inside the
// caller's transaction — same discipline as applyLoadChange itself.
import type { Prisma } from "@prisma/client";
import { applyLoadChange, type Actor, type ChangeSource, type LoadPatch } from "./loadWriter.js";

type Tx = Prisma.TransactionClient;

/** A `policyId` that does not belong to `orgId`. Mirrors the 404-not-403
 *  shape every other org-scoped lookup in this codebase uses — the caller
 *  (the HTTP route) maps this to the same "Policy not found" 404 the route
 *  always returned; the sheet sync path never constructs one at all (it only
 *  ever passes a `policyId` it already matched against the org's own policy
 *  list by name). */
export class PolicyNotFound extends Error {}

export interface ApplyAgentSwitchArgs {
  loadId: string;
  orgId: string;
  actor: Actor;
  source: ChangeSource;
  enabled: boolean;
  /** Only present when the caller means to set/replace the load's policy.
   *  Omitted (not `undefined`-valued-but-present): re-enabling an
   *  already-on load without naming a policy leaves `agentPolicyId`
   *  untouched, same as the switch route always did. */
  policyId?: string;
  baseVersion?: number;
}

export interface ApplyAgentSwitchResult {
  version: number;
  changed: string[];
}

export async function applyAgentSwitch(tx: Tx, args: ApplyAgentSwitchArgs): Promise<ApplyAgentSwitchResult> {
  // A policyId is validated against the caller's own org before it ever
  // reaches the writer — the writer itself does no FK validation of its own
  // for a plain scalar (it "carries no derivation", per Task 3's brief).
  if (args.policyId !== undefined) {
    const policy = await tx.agentPolicy.findFirst({ where: { id: args.policyId, orgId: args.orgId } });
    if (!policy) throw new PolicyNotFound(`policy ${args.policyId} is not in org ${args.orgId}`);
  }

  const patch: LoadPatch = {
    agentEnabled: args.enabled,
    // "watching" when the switch turns the agent on — the worker refines it
    // from there (spec §17.2); "off" when it turns it off. Set unconditionally
    // on every call, not only on an actual flip: re-enabling an already-on
    // load resets the story to "watching" the same way a fresh switch-on does.
    agentPill: args.enabled ? "watching" : "off",
    ...(args.policyId !== undefined ? { agentPolicyId: args.policyId } : {}),
  };

  const applied = await applyLoadChange(tx, {
    loadId: args.loadId, orgId: args.orgId, actor: args.actor, source: args.source,
    patch, baseVersion: args.baseVersion,
  });

  // Disabling also tells the worker to stop, the same command the drawer's
  // own Stop button writes (POST /loads/:id/agent/commands) — the switch is
  // the fast path, not a second mechanism.
  if (!args.enabled) {
    await tx.agentCommand.create({ data: { loadId: args.loadId, kind: "stop", actorName: args.actor.name } });
  }

  return { version: applied.version, changed: applied.changed };
}
