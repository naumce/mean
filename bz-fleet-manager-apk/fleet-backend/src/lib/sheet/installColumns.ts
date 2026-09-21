// The reusable half of "make sure this binding's sheet has the two Night
// Shift columns" (spec §6.1/§17): both `POST /sheet/install` and a policy
// create/rename (dispatcherNightShift.ts) need to run this, so it lives here
// rather than inside the route file either of them would otherwise have to
// import from.
import { prisma } from "../../db.js";
import { connectorFor } from "./connectorFor.js";
import { STANDARD_POLICY } from "../agentPolicies.js";
import type { TabRef } from "./connector.js";

export const AGENT_COLUMN_NAMES = { switch: "Night Shift", status: "Night Shift status" } as const;

/** The org's policy names for the switch column's dropdown, Standard first —
 *  the one name every org always has, so it reads as the default choice
 *  rather than lost alphabetically among the org's own policies. */
function orderedPolicyNames(names: string[]): string[] {
  const standard = names.filter((n) => n === STANDARD_POLICY.name);
  const rest = names.filter((n) => n !== STANDARD_POLICY.name).sort((a, b) => a.localeCompare(b));
  return [...standard, ...rest];
}

export interface AgentColumnIndexes {
  switch: number;
  status: number;
}

// Accepted as-is (fix round 1, finding "install non-atomic"): the Google
// write and the Postgres index-persist below are not one transaction. A
// crash between them is a narrow, self-correcting window, not a lasting
// inconsistency — `ensureAgentColumns` is idempotent (it finds the columns
// by name before adding them) and `/sheet/install` can simply be retried.
export async function installAgentColumns(bindingId: string): Promise<AgentColumnIndexes> {
  const binding = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: bindingId } });
  const ref: TabRef = { spreadsheetId: binding.spreadsheetId, tabId: binding.tabId };
  const policies = await prisma.agentPolicy.findMany({ where: { orgId: binding.orgId }, select: { name: true } });
  const policyNames = orderedPolicyNames(policies.map((p) => p.name));

  const cols = await connectorFor(binding).ensureAgentColumns(ref, binding.headerRow, AGENT_COLUMN_NAMES, policyNames);
  await prisma.sheetBinding.update({
    where: { id: bindingId },
    data: { agentSwitchCol: cols.switch, agentStatusCol: cols.status },
  });
  return cols;
}
