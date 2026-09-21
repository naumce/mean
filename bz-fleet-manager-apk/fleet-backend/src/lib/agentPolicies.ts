import { z } from "zod";

/** Spec §17.2. The Standard policy carries the thresholds the agent used on
 *  its first live run (2026-09-07). Every other policy starts from these. */
export const STANDARD_POLICY = {
  name: "Standard",
  stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60,
  offRouteMi: 3.1, offRouteMin: 10,
  rungGapMin: 5, maxCalls: 2,
  customerEmailOn: false, shadow: true, bossCallOn: true,
  quietFrom: null as string | null, quietTo: null as string | null,
} as const;

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const agentPolicySchema = z.object({
  name: z.string().min(1).max(40),
  stopMin: z.number().int().min(1).max(240),
  delayMin: z.number().int().min(1).max(600),
  darkMin: z.number().int().min(1).max(600),
  darkAtStopMin: z.number().int().min(1).max(600),
  offRouteMi: z.number().min(0.1).max(50),
  offRouteMin: z.number().int().min(1).max(120),
  rungGapMin: z.number().int().min(1).max(60),
  maxCalls: z.number().int().min(0).max(5),
  dispatcherEmail: z.string().email(),
  dispatcherPhone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  customerEmailOn: z.boolean(),
  shadow: z.boolean(),
  bossCallOn: z.boolean(),
  quietFrom: hhmm.nullable(),
  quietTo: hhmm.nullable(),
});
export type AgentPolicyInput = z.infer<typeof agentPolicySchema>;

/** The policy a load runs under: its own, else the org's Standard. A load
 *  that is switched on without a policy is a bug upstream, not a fallback
 *  here — this throws so the caller notices. */
export function policyFor<P extends { id: string; name: string }>(
  load: { agentPolicyId: string | null },
  policies: readonly P[],
): P {
  const own = load.agentPolicyId ? policies.find((p) => p.id === load.agentPolicyId) : undefined;
  const std = policies.find((p) => p.name === STANDARD_POLICY.name);
  const chosen = own ?? std;
  if (!chosen) throw new Error("org has no Standard agent policy — seed it");
  return chosen;
}
