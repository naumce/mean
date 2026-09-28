import { z } from "zod";
import { prisma } from "../../../db.js";
import { PROPOSE_DECISION_NAME, driverReferenceErrors, issueSentence, type Proposal, type ProposalCheck } from "../decision.js";
import { checkProtocolV2, type ProtocolContext } from "../protocol.js";
import type { ToolDefinition } from "../types.js";

// aiHarness/prompts/dispatch-v2.ts (dispatch-v2 A/B experiment, Task 1): the
// second prompt version — same terminal tool name and the same driverId/
// reason/confidence/alternatives fields as dispatch-v1, plus a required
// `comparison` field and a protocol validator (protocol.ts) that inspects the
// run's own persisted tool evidence rather than the model's prose. dispatch-
// v1's own files stay untouched; this is purely an additive profile.

export interface ComparisonEntry {
  driverId: string;
  strengths: string[];
  weaknesses: string[];
  unknowns: string[];
}

export interface ProposalV2 extends Proposal {
  comparison: ComparisonEntry[];
}

const MAX_COMPARISON_STRINGS = 8;

export const PROPOSE_DECISION_V2_DEFINITION: ToolDefinition = {
  name: PROPOSE_DECISION_NAME,
  description:
    "Record your final recommendation for this load: the feasible driver to assign, or null if none is " +
    "appropriate. Call this exactly once, after you have investigated and compared your finalists with the other tools.",
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
        description: "How strong your evidence is, from 0 to 1 — not how certain you sound.",
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
      comparison: {
        type: "array",
        minItems: 0,
        maxItems: 6,
        description:
          "A structured comparison of every feasible candidate you investigated: their strengths, weaknesses, " +
          "and unknowns as the specific evidence you retrieved, never by driver name. Leave this empty only when " +
          "no feasible driver exists for this load (driverId null).",
        items: {
          type: "object",
          properties: {
            driverId: { type: "string", description: "A feasible, investigated driver's id." },
            strengths: {
              type: "array",
              maxItems: MAX_COMPARISON_STRINGS,
              items: { type: "string", minLength: 3, maxLength: 300 },
              description: "Evidence favoring this driver.",
            },
            weaknesses: {
              type: "array",
              maxItems: MAX_COMPARISON_STRINGS,
              items: { type: "string", minLength: 3, maxLength: 300 },
              description: "Evidence against this driver.",
            },
            unknowns: {
              type: "array",
              maxItems: MAX_COMPARISON_STRINGS,
              items: { type: "string", minLength: 3, maxLength: 300 },
              description: "Relevant facts you could not find with the tools.",
            },
          },
          required: ["driverId", "strengths", "weaknesses", "unknowns"],
        },
      },
    },
    required: ["driverId", "reason", "confidence", "alternatives", "comparison"],
  },
};

const alternativeSchemaV2 = z.object({
  driverId: z.string().min(1),
  reason: z.string().min(5).max(500),
});

const comparisonStringArray = z.array(z.string().min(3).max(300)).max(MAX_COMPARISON_STRINGS);

const comparisonEntrySchema = z.object({
  driverId: z.string().min(1),
  strengths: comparisonStringArray,
  weaknesses: comparisonStringArray,
  unknowns: comparisonStringArray,
});

/** v1's own four fields, re-stated rather than imported from decision.ts's
 *  `proposalSchema` (kept `z.ZodType<Proposal>`-typed there, not a
 *  `ZodObject`, so it cannot be `.extend()`-ed) — plus `comparison`, 0..6
 *  entries. Zero entries is a SCHEMA-valid shape (a load with no feasible
 *  driver at all has nothing to compare); `checkProtocolV2` is what still
 *  requires `>= min(2, feasibleCount)` whenever any driver is feasible.
 *  `.superRefine` covers the two rules that are genuinely cross-field rather
 *  than per-item: a comparison must not repeat a driverId, and each entry
 *  must carry at least one item somewhere across its three (individually
 *  still optional) evidence arrays — `{strengths:[],weaknesses:[],unknowns:[]}`
 *  is schema-shaped but says nothing at all. */
export const proposalV2Schema: z.ZodType<ProposalV2> = z
  .object({
    driverId: z.string().min(1).nullable(),
    reason: z.string().min(20).max(2000),
    confidence: z.number().min(0).max(1),
    alternatives: z.array(alternativeSchemaV2).max(3),
    comparison: z.array(comparisonEntrySchema).max(6),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.comparison.forEach((entry, index) => {
      if (seen.has(entry.driverId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparison", index, "driverId"],
          message: `comparison entry ${entry.driverId} is listed more than once`,
        });
      }
      seen.add(entry.driverId);

      if (entry.strengths.length + entry.weaknesses.length + entry.unknowns.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparison", index],
          message: `comparison entry ${entry.driverId} needs at least one item across strengths, weaknesses, or unknowns`,
        });
      }
    });
  });

/** One zod issue -> a short, model-readable sentence: dispatch-v2's own
 *  `comparison` paths first, decision.ts's `issueSentence` (v1's own fields)
 *  as the fallback for everything else this schema shares with v1. */
function issueSentenceV2(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.custom) return issue.message;

  const path = issue.path.map(String).join(".");
  if (path === "comparison") return "comparison must include at most 6 entries";
  if (/^comparison\.\d+\.driverId$/.test(path)) return "each comparison entry needs a driverId";
  if (/^comparison\.\d+\.(strengths|weaknesses|unknowns)$/.test(path)) {
    return "each comparison entry's strengths, weaknesses, and unknowns must have at most 8 items each";
  }
  if (/^comparison\.\d+\.(strengths|weaknesses|unknowns)\.\d+$/.test(path)) {
    return "each comparison strength, weakness, or unknown must be between 3 and 300 characters";
  }
  return issueSentence(issue);
}

/** Every driver id `proposal` references anywhere — v1's own driverId/
 *  alternatives (decision.ts's `referencedDriverIds`, not exported since it
 *  only takes the exact `Proposal` shape) plus dispatch-v2's own `comparison`
 *  entries and the run's feasible set (so `checkProtocolV2`'s messages can
 *  name any of THOSE too) — in one set, so `validateProposalV2` below needs
 *  exactly one `Driver` query for both the existence/feasibility check and
 *  name resolution, never two. */
function allReferencedIds(proposal: ProposalV2, ctx: ProtocolContext): string[] {
  return [
    ...new Set([
      ...(proposal.driverId ? [proposal.driverId] : []),
      ...proposal.alternatives.map((a) => a.driverId),
      ...proposal.comparison.map((e) => e.driverId),
      ...ctx.feasibleDriverIds,
    ]),
  ];
}

/** dispatch-v2's `PromptProfile.validate`: schema shape, one `Driver` query
 *  covering every id this proposal or its own run could reference, then v1's
 *  own driverId/alternatives org+feasibility check (`driverReferenceErrors`,
 *  run against that query's result rather than one of its own) and
 *  `checkProtocolV2`'s evidence-derived rules (given the same query's names)
 *  — every problem from every stage is returned together, the same "correct
 *  everything at once" convention `validateProposal` already uses for v1. */
export async function validateProposalV2(raw: unknown, ctx: ProtocolContext): Promise<ProposalCheck> {
  const parsed = proposalV2Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(issueSentenceV2) };
  }
  const proposal = parsed.data;

  const ids = allReferencedIds(proposal, ctx);
  const rows = ids.length > 0
    ? await prisma.driver.findMany({ where: { id: { in: ids }, orgId: ctx.orgId }, select: { id: true, name: true } })
    : [];
  const existingIds = new Set(rows.map((d) => d.id));
  const driverNames = new Map(rows.map((d) => [d.id, d.name]));

  const referenceErrors = driverReferenceErrors(proposal, { feasibleDriverIds: ctx.feasibleDriverIds }, existingIds);
  const errors = [...referenceErrors, ...checkProtocolV2(proposal, ctx, driverNames)];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, proposal };
}

export const DISPATCH_PROMPT_V2 = {
  version: "dispatch-v2",
  system: `You are a dispatch analyst for a trucking operation. Your task is to investigate one load and recommend the most appropriate feasible driver for it, or explain why none is appropriate.

You have a set of read-only tools for looking up loads, drivers, customers, and dispatch candidates. These tools are your only source of facts about this load, these drivers, and this organization — you have no other knowledge of them.

Follow this process:

1. Call findFeasibleDrivers to discover which drivers are feasible for this load and why the others are not. Only a driver in its feasible results may be recommended or compared.

2. Investigate at least two feasible candidates whenever two or more exist. If only one driver is feasible, investigate that one.

3. For each finalist, gather the available evidence before you compare: current and projected availability (getDriverAvailability, getDispatchCandidateDetails); current and projected location (getDriverAvailability, getDriverLocationHistory, getDispatchCandidateDetails); deadhead distance and pickup feasibility (getDispatchCandidateDetails); the hours-of-service result (getDispatchCandidateDetails); equipment and qualification compatibility (getDriver, getDispatchCandidateDetails); driver metrics (getDriverMetrics); lane experience (getDriverHistory, getDriverMetrics, getDispatchCandidateDetails); response history (getDriverMetrics, getDispatchCandidateDetails); and relevant preferences (getDispatchCandidateDetails). getDispatchCandidateDetails returns most of this for one driver in a single call; use the other tools only for what it leaves unknown. Use getCustomer or getLoad for anything you need about the load or customer side. When a piece of evidence is not available from any tool, record it as an unknown for that driver — never invent it, and never treat it as required before you can propose.

4. Before selecting, compare your finalists in the comparison field of propose_decision: for each one, list its strengths, its weaknesses, and its unknowns as the specific evidence you retrieved — never by naming or describing the driver instead of the evidence.

5. Grade your confidence by how strong your evidence is: 0.90–1.00 exceptionally strong evidence, very little relevant uncertainty; 0.70–0.89 strong recommendation with some uncertainty; 0.50–0.69 reasonable preference but meaningful uncertainty; below 0.50 weak evidence or insufficient differentiation. Confidence measures evidence strength, not how certain you sound. Do not default to 0.95 or 1.0.

6. Keep these rules in mind throughout:
- Proximity alone does not determine the most appropriate driver.
- Historical reliability alone does not determine the most appropriate driver.
- Preferences are not hard feasibility constraints.
- The feasibility results returned by the tools are authoritative.
- Never invent a missing fact.
- Investigate before deciding.
- Compare the evidence you gathered, not the drivers' names.
- Do not infer quality from demographic or profile characteristics such as a driver's name, language, or home base.

7. Finish by calling propose_decision exactly once, including your comparison. Use driverId null, with your reason, if no feasible driver is genuinely appropriate for this load.

Do not call propose_decision more than once, and do not stop without calling it.`,
  user: (args: { loadId: string; loadRef: string | null }) =>
    `Investigate load ${args.loadRef ?? args.loadId} (id ${args.loadId}) and recommend the most appropriate feasible driver. Follow the investigation and comparison process before proposing.`,
  nudge:
    "You have not proposed a decision. Make sure you have investigated at least two feasible candidates and compared them in the comparison field before finishing. Call propose_decision with your recommendation, or with driverId null if none is appropriate.",
} as const;
