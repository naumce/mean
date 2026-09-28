import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDefinition } from "./types.js";

// aiHarness/decision.ts (Qwen Harness v0.1, Task 4): the one terminal tool a
// dispatch run ends on. `PROPOSE_DECISION_DEFINITION.parameters` is a
// hand-written JSON Schema (this harness's tool definitions are not derived
// from zod — manifest.ts's zod-v4 JSON-schema trick is a dispatchTools/-only
// convention); `proposalSchema` is the same shape re-expressed in zod v3
// (`import { z } from "zod"`, like every other file in this codebase besides
// manifest.ts) so `validateProposal` can actually parse a model's call.

export const PROPOSE_DECISION_NAME = "propose_decision";

export const PROPOSE_DECISION_DEFINITION: ToolDefinition = {
  name: PROPOSE_DECISION_NAME,
  description:
    "Record your final recommendation for this load: the feasible driver to assign, or null if none is " +
    "appropriate. Call this exactly once, after you have gathered enough evidence with the other tools.",
  parameters: {
    type: "object",
    properties: {
      driverId: {
        type: ["string", "null"],
        description: "The recommended driver's id, or null if no feasible driver is appropriate.",
      },
      reason: {
        type: "string",
        minLength: 20,
        maxLength: 2000,
        description: "Why this driver (or null) is the right call, naming the evidence you actually retrieved.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How confident you are in this recommendation, from 0 to 1.",
      },
      alternatives: {
        type: "array",
        maxItems: 3,
        description: "Up to 3 other feasible drivers you considered, each with its own reason.",
        items: {
          type: "object",
          properties: {
            driverId: { type: "string", description: "An alternative driver's id." },
            reason: {
              type: "string",
              minLength: 5,
              maxLength: 500,
              description: "Why this driver was considered.",
            },
          },
          required: ["driverId", "reason"],
        },
      },
    },
    required: ["driverId", "reason", "confidence", "alternatives"],
  },
};

export interface Proposal {
  driverId: string | null;
  reason: string;
  confidence: number;
  alternatives: { driverId: string; reason: string }[];
}

const alternativeSchema = z.object({
  driverId: z.string().min(1),
  reason: z.string().min(5).max(500),
});

export const proposalSchema: z.ZodType<Proposal> = z.object({
  driverId: z.string().min(1).nullable(),
  reason: z.string().min(20).max(2000),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(alternativeSchema).max(3),
});

export type ProposalCheck = { ok: true; proposal: Proposal } | { ok: false; errors: string[] };

/** Fixed, plain-English text for the fields a model actually fills in — zod's
 *  own message (e.g. "Number must be less than or equal to 1") is accurate
 *  but not written for a model to act on. Anything outside these fields (there
 *  is nothing else in this schema) would fall back to `issueSentence`'s own
 *  `path: message` shape below. */
const FIELD_MESSAGES: Record<string, string> = {
  driverId: "driverId must be a string or null",
  reason: "reason must be a string between 20 and 2000 characters",
  confidence: "confidence must be a number between 0 and 1",
  alternatives: "alternatives must be an array of at most 3 entries",
};

/** One zod issue -> a short, model-readable sentence. Exported so
 *  prompts/dispatch-v2.ts's own issue mapper can fall back to this for the
 *  fields dispatch-v2's terminal schema shares with v1 (driverId/reason/
 *  confidence/alternatives), rather than repeating these messages. */
export function issueSentence(issue: z.ZodIssue): string {
  const path = issue.path.map(String).join(".");
  if (path === "") return "the proposal must be a JSON object";
  if (path in FIELD_MESSAGES) return FIELD_MESSAGES[path];
  if (/^alternatives\.\d+\.driverId$/.test(path)) return "each alternative needs a driverId";
  if (/^alternatives\.\d+\.reason$/.test(path)) {
    return "each alternative's reason must be between 5 and 500 characters";
  }
  return `${path}: ${issue.message}`;
}

/** Every distinct driver id a proposal references — the main `driverId`
 *  (when not null) plus each alternative's — in first-seen order, so the one
 *  `findMany` below queries each id once regardless of how many fields
 *  repeat it. */
function referencedDriverIds(proposal: Proposal): string[] {
  const ids = proposal.driverId != null ? [proposal.driverId] : [];
  return [...new Set([...ids, ...proposal.alternatives.map((a) => a.driverId)])];
}

/** Cross-field checks `proposalSchema` cannot express on its own: an
 *  alternative must not repeat the main recommendation, and must not repeat
 *  another alternative. Pure — no DB, so these run before the one `findMany`
 *  in `validateProposal`. */
function selfConsistencyErrors(proposal: Proposal): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const alt of proposal.alternatives) {
    if (proposal.driverId != null && alt.driverId === proposal.driverId) {
      errors.push(`alternative driver ${alt.driverId} cannot be the same as the recommended driver`);
    } else if (seen.has(alt.driverId)) {
      errors.push(`alternative driver ${alt.driverId} is listed more than once`);
    }
    seen.add(alt.driverId);
  }
  return errors;
}

/**
 * Cross-field self-consistency plus the org-existence/feasibility check for
 * `proposal.driverId`/`proposal.alternatives`, given a pre-fetched set of
 * which of `referencedDriverIds(proposal)` actually exist — pure and DB-free
 * so a caller that already has its own reason to query `Driver` (v2's
 * `validate`, which also needs driver NAMES for the same id set) can run this
 * exact check off that ONE query instead of this module issuing a second one.
 * Exported (unlike `selfConsistencyErrors`/`referencedDriverIds` above) so
 * prompts/dispatch-v2.ts can run it against a `ProposalV2`, which carries
 * these same two fields; `Pick` rather than the full `Proposal` type is all
 * this needs from either shape.
 */
export function driverReferenceErrors(
  proposal: Pick<Proposal, "driverId" | "alternatives">,
  ctx: { feasibleDriverIds: ReadonlySet<string> },
  existingIds: ReadonlySet<string>,
): string[] {
  const errors = selfConsistencyErrors(proposal as Proposal);

  for (const id of referencedDriverIds(proposal as Proposal)) {
    if (!existingIds.has(id)) {
      errors.push(`driver ${id} does not exist in this organization`);
    } else if (!ctx.feasibleDriverIds.has(id)) {
      errors.push(
        `driver ${id} was not among the feasible candidates for this load — call findFeasibleDrivers and choose from its feasible rows`,
      );
    }
  }

  return errors;
}

/**
 * `driverReferenceErrors` with its own `findMany` — v1's `validateProposal`
 * below is the only caller that has no other reason to query `Driver` itself,
 * so it keeps this one-call convenience wrapper; a caller that already needs
 * a `Driver` query for something else (prompts/dispatch-v2.ts's `validate`)
 * calls `driverReferenceErrors` directly against its own query's result
 * instead of paying for a second one here.
 */
export async function checkDriverReferences(
  proposal: Pick<Proposal, "driverId" | "alternatives">,
  ctx: { orgId: string; feasibleDriverIds: ReadonlySet<string> },
): Promise<string[]> {
  const ids = referencedDriverIds(proposal as Proposal);
  if (ids.length === 0) return selfConsistencyErrors(proposal as Proposal);

  const rows = await prisma.driver.findMany({
    where: { id: { in: ids }, orgId: ctx.orgId },
    select: { id: true },
  });
  return driverReferenceErrors(proposal, ctx, new Set(rows.map((d) => d.id)));
}

/**
 * `raw` as a validated `Proposal`: schema shape first, then every referenced
 * driver id checked against the org (one `findMany`) and against
 * `ctx.feasibleDriverIds`. Every problem found is returned — a model correcting
 * three mistakes needs all three named, not one at a time across three calls.
 */
export async function validateProposal(
  raw: unknown,
  ctx: { orgId: string; feasibleDriverIds: ReadonlySet<string> },
): Promise<ProposalCheck> {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(issueSentence) };
  }
  const proposal = parsed.data;

  const errors = await checkDriverReferences(proposal, ctx);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, proposal };
}
