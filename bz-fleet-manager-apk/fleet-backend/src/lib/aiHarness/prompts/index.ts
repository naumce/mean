import type { ToolDefinition } from "../types.js";
import { PROPOSE_DECISION_DEFINITION, validateProposal, type ProposalCheck } from "../decision.js";
import type { ProtocolContext } from "../protocol.js";
import { DISPATCH_PROMPT_V1 } from "./dispatch-v1.js";
import { DISPATCH_PROMPT_V2, PROPOSE_DECISION_V2_DEFINITION, validateProposalV2 } from "./dispatch-v2.js";

// aiHarness/prompts/index.ts (dispatch-v2 A/B experiment, Task 1): the one
// additive seam the harness loop resolves a run's prompt/terminal-schema/
// validator through, by its persisted `promptVersion`, instead of hard-coding
// dispatch-v1 everywhere. dispatch-v1's own profile below wraps its existing
// files byte-for-byte (`ctx.steps` is simply unused by its `validate`); adding
// a THIRD prompt version later means adding one more profile to
// `PROMPT_PROFILES`, never touching loop.ts/loopHandlers.ts again.

export type { ProtocolContext } from "../protocol.js";

export interface PromptProfile {
  version: string;
  system: string;
  user(args: { loadId: string; loadRef: string | null }): string;
  nudge: string;
  terminalDefinition: ToolDefinition;
  validate(raw: unknown, ctx: ProtocolContext): Promise<ProposalCheck>;
}

const dispatchV1Profile: PromptProfile = {
  version: DISPATCH_PROMPT_V1.version,
  system: DISPATCH_PROMPT_V1.system,
  user: DISPATCH_PROMPT_V1.user,
  nudge: DISPATCH_PROMPT_V1.nudge,
  terminalDefinition: PROPOSE_DECISION_DEFINITION,
  // ctx.steps is intentionally unused: v1's terminal contract never grew a
  // protocol beyond the org/feasibility check validateProposal already ran
  // before this seam existed.
  validate: (raw, ctx) => validateProposal(raw, { orgId: ctx.orgId, feasibleDriverIds: ctx.feasibleDriverIds }),
};

const dispatchV2Profile: PromptProfile = {
  version: DISPATCH_PROMPT_V2.version,
  system: DISPATCH_PROMPT_V2.system,
  user: DISPATCH_PROMPT_V2.user,
  nudge: DISPATCH_PROMPT_V2.nudge,
  terminalDefinition: PROPOSE_DECISION_V2_DEFINITION,
  validate: validateProposalV2,
};

export const PROMPT_PROFILES: Record<string, PromptProfile> = {
  "dispatch-v1": dispatchV1Profile,
  "dispatch-v2": dispatchV2Profile,
};

export const PROMPT_VERSIONS: string[] = Object.keys(PROMPT_PROFILES);

/** `null` for an unknown version — the loop treats that as a terminal
 *  `internal_error` before ever calling the model (loop.ts); routes validate
 *  a requested `promptVersion` against `PROMPT_VERSIONS` up front instead of
 *  relying on this returning null. */
export function resolvePromptProfile(version: string): PromptProfile | null {
  return PROMPT_PROFILES[version] ?? null;
}
