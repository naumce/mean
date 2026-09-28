import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { scriptedAdapter } from "./helpers/scriptedAdapter.js";
import { memoryRunStore } from "./helpers/memoryRunStore.js";
import { runDispatchDecision, type RunInput } from "../src/lib/aiHarness/loop.js";
import { DEFAULT_HARNESS_CONFIG } from "../src/lib/aiHarness/config.js";
import type { ChatResponse } from "../src/lib/aiHarness/types.js";
import type { InvokeResult } from "../src/lib/dispatchTools/invoke.js";

// dispatch-v2 A/B experiment, Task 1 — the loop's own prompt-profile seam,
// exercised end to end with the scripted adapter (like
// tests/ai-harness-loop.test.ts's own suite): a dispatch-v2 run's protocol
// rejection/acceptance, the SAME script accepted immediately under
// dispatch-v1 (proving v1's own behaviour is untouched), and an unknown
// promptVersion failing before any model call. `validateProposalV2`/
// `checkDriverReferences` are not injectable (same reason `validateProposal`
// isn't, per ai-harness-loop.test.ts's own header comment), so this seeds a
// real Org+Driver pair.

beforeEach(resetDb);

const LOAD_ID = "load-1";

async function seedOrgWithTwoFeasibleDrivers() {
  const org = await prisma.org.create({ data: { name: "Loop V2 Co" } });
  const d1 = await prisma.driver.create({ data: { email: "d1@loopv2.com", passwordHash: "x", name: "Driver One", orgId: org.id } });
  const d2 = await prisma.driver.create({ data: { email: "d2@loopv2.com", passwordHash: "x", name: "Driver Two", orgId: org.id } });
  return { org, d1, d2 };
}

function assistantTurn(content: string, toolCalls: { name: string; arguments: Record<string, unknown> }[] = []): ChatResponse {
  return {
    message: { role: "assistant", content, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
    doneReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    stats: { promptTokens: 10, completionTokens: 5, totalDurationMs: 20 },
  };
}

/** `findFeasibleDrivers` -> both drivers feasible; `getDispatchCandidateDetails`
 *  -> a minimal successful row for whichever driverId was asked about. Every
 *  other tool 404s (unexpected in this script) — the same
 *  stub-only-what-the-script-uses convention ai-harness-loop.test.ts's own
 *  `invoke` overrides use. */
function makeInvoke(feasibleIds: string[]) {
  return async (_orgId: string, name: string, params: unknown): Promise<InvokeResult> => {
    if (name === "findFeasibleDrivers") {
      return {
        ok: true,
        value: {
          loadId: LOAD_ID,
          requiredEquip: "Reefer",
          note: null,
          counts: { feasible: feasibleIds.length, blocked: 0, shownFeasible: feasibleIds.length, shownBlocked: 0 },
          feasible: feasibleIds.map((id) => ({
            driverId: id, driverName: null, score: 0.5, deadheadMi: 5,
            availabilityStatus: null, laneRuns: null, onTimeRate: null, responseRate: null, hosKnown: null,
          })),
          blocked: [],
        },
      };
    }
    if (name === "getDispatchCandidateDetails") {
      const driverId = (params as { driverId?: unknown }).driverId;
      return {
        ok: true,
        value: {
          loadId: LOAD_ID,
          driverId,
          candidate: {
            driverId, driverName: null, feasible: true, score: 0.5, deadheadMi: 5,
            marginCents: 0, etaMs: 0, blockedReason: null, context: null,
          },
        },
      };
    }
    return { ok: false, error: `unexpected tool ${name}`, code: "unknown_tool" };
  };
}

function makeInput(overrides: Partial<RunInput> & Pick<RunInput, "adapter" | "invoke">): RunInput {
  return {
    orgId: "org-1",
    decisionId: "decision-1",
    loadId: LOAD_ID,
    loadRef: "L-100",
    config: DEFAULT_HARNESS_CONFIG,
    store: memoryRunStore(),
    captureBaseline: async () => null,
    ...overrides,
  };
}

describe("runDispatchDecision: dispatch-v2 protocol enforcement", () => {
  it("rejects a propose_decision after investigating only one of two feasible candidates, then accepts once both are compared", async () => {
    const { org, d1, d2 } = await seedOrgWithTwoFeasibleDrivers();
    const store = memoryRunStore();
    const script = [
      assistantTurn("Checking feasibility.", [{ name: "findFeasibleDrivers", arguments: { loadId: LOAD_ID } }]),
      assistantTurn("Investigating the first candidate.", [{ name: "getDispatchCandidateDetails", arguments: { loadId: LOAD_ID, driverId: d1.id } }]),
      assistantTurn("Proposing after one investigation.", [
        {
          name: "propose_decision",
          arguments: {
            driverId: d1.id,
            reason: "Driver one has strong evidence gathered from the candidate details tool.",
            confidence: 0.6,
            alternatives: [],
            comparison: [{ driverId: d1.id, strengths: ["Feasible and close to the pickup"], weaknesses: [], unknowns: [] }],
          },
        },
      ]),
      assistantTurn("Investigating the second candidate.", [{ name: "getDispatchCandidateDetails", arguments: { loadId: LOAD_ID, driverId: d2.id } }]),
      assistantTurn("Proposing after comparing both candidates.", [
        {
          name: "propose_decision",
          arguments: {
            driverId: d1.id,
            reason: "Comparing both feasible candidates, driver one remains the stronger evidence-backed pick.",
            confidence: 0.6,
            alternatives: [],
            comparison: [
              { driverId: d1.id, strengths: ["Feasible and close to the pickup"], weaknesses: [], unknowns: [] },
              { driverId: d2.id, strengths: ["Also feasible"], weaknesses: ["Farther from the pickup"], unknowns: [] },
            ],
          },
        },
      ]),
    ];

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-v2-protocol",
        store,
        adapter: scriptedAdapter(script),
        invoke: makeInvoke([d1.id, d2.id]),
        promptVersion: "dispatch-v2",
      }),
    );

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposal?.driverId).toBe(d1.id);
    expect(outcome.stats.invalidCalls).toBe(1);
    expect(outcome.stats.candidatesInvestigated).toBe(2);

    const steps = store.stepsFor("d-v2-protocol");
    const rejected = steps.find((s) => s.kind === "tool_result" && s.name === "propose_decision");
    expect(rejected).toBeDefined();
    expect(rejected?.payload).toMatchObject({ ok: false });
    const rejectedErrors = (rejected!.payload as { errors: string[] }).errors;
    expect(rejectedErrors.some((e) => e.includes("Investigate at least one"))).toBe(true);

    const finalStep = steps.find((s) => s.kind === "final");
    expect(finalStep).toBeDefined();
    const persistedProposal = (finalStep!.payload as { proposal: { comparison: unknown[] } }).proposal;
    expect(persistedProposal.comparison).toHaveLength(2);

    const latest = store.latest("d-v2-protocol");
    expect((latest.proposedDecision as { comparison: unknown[] } | null)?.comparison).toHaveLength(2);
    expect(latest.promptVersion).toBe("dispatch-v2");
  });

  it("the exact same script accepts the first propose_decision attempt under dispatch-v1 (v1 behaviour unchanged)", async () => {
    const { org, d1, d2 } = await seedOrgWithTwoFeasibleDrivers();
    const store = memoryRunStore();
    // Reused verbatim from the v2 test above (same shape, same arguments,
    // including the `comparison` field v1's own schema simply ignores) — only
    // the promptVersion below differs.
    const script = [
      assistantTurn("Checking feasibility.", [{ name: "findFeasibleDrivers", arguments: { loadId: LOAD_ID } }]),
      assistantTurn("Investigating the first candidate.", [{ name: "getDispatchCandidateDetails", arguments: { loadId: LOAD_ID, driverId: d1.id } }]),
      assistantTurn("Proposing after one investigation.", [
        {
          name: "propose_decision",
          arguments: {
            driverId: d1.id,
            reason: "Driver one has strong evidence gathered from the candidate details tool.",
            confidence: 0.6,
            alternatives: [],
            comparison: [{ driverId: d1.id, strengths: ["Feasible and close to the pickup"], weaknesses: [], unknowns: [] }],
          },
        },
      ]),
    ];

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-v1-unchanged",
        store,
        adapter: scriptedAdapter(script),
        invoke: makeInvoke([d1.id, d2.id]),
        promptVersion: "dispatch-v1",
      }),
    );

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposal?.driverId).toBe(d1.id);
    expect(outcome.stats.invalidCalls).toBe(0);

    const steps = store.stepsFor("d-v1-unchanged");
    // Accepted on the very first attempt — no rejected tool_result at all.
    expect(steps.find((s) => s.kind === "tool_result" && s.name === "propose_decision")).toBeUndefined();
    expect(steps.some((s) => s.kind === "final")).toBe(true);
    expect(store.latest("d-v1-unchanged").promptVersion).toBe("dispatch-v1");
  });

  it("accepts driverId: null with an empty comparison when findFeasibleDrivers returns no feasible driver", async () => {
    const org = await prisma.org.create({ data: { name: "Loop V2 Zero Feasible Co" } });
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      assistantTurn("Checking feasibility.", [{ name: "findFeasibleDrivers", arguments: { loadId: LOAD_ID } }]),
      assistantTurn("No feasible driver found.", [
        {
          name: "propose_decision",
          arguments: {
            driverId: null,
            reason: "No feasible driver exists for this load per findFeasibleDrivers's own result.",
            confidence: 0.9,
            alternatives: [],
            comparison: [],
          },
        },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-v2-zero-feasible-null",
        store,
        adapter,
        invoke: makeInvoke([]),
        promptVersion: "dispatch-v2",
      }),
    );

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposal?.driverId).toBeNull();
    expect(outcome.stats.invalidCalls).toBe(0);
  });

  it("rejects a proposed driver when findFeasibleDrivers returns no feasible driver, naming that no feasible candidate exists", async () => {
    const { org, d1 } = await seedOrgWithTwoFeasibleDrivers();
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      assistantTurn("Checking feasibility.", [{ name: "findFeasibleDrivers", arguments: { loadId: LOAD_ID } }]),
      assistantTurn("Recommending anyway.", [
        {
          name: "propose_decision",
          arguments: {
            driverId: d1.id,
            reason: "Recommending this driver despite no feasible result from findFeasibleDrivers.",
            confidence: 0.5,
            alternatives: [],
            comparison: [{ driverId: d1.id, strengths: ["Nearby"], weaknesses: [], unknowns: [] }],
          },
        },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-v2-zero-feasible-rejected",
        store,
        adapter,
        invoke: makeInvoke([]), // findFeasibleDrivers reports zero feasible, even though d1 exists in the org
        promptVersion: "dispatch-v2",
        config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 2 },
      }),
    );

    expect(outcome.terminationReason).toBe("max_turns"); // never validly proposed within its (capped) turn budget
    const rejected = store.stepsFor("d-v2-zero-feasible-rejected").find((s) => s.kind === "tool_result" && s.name === "propose_decision");
    expect(rejected).toBeDefined();
    const errors = (rejected!.payload as { errors: string[] }).errors;
    expect(errors.some((e) => e.includes("no feasible candidate exists"))).toBe(true);
  });

  it("an unknown promptVersion ends the run as internal_error before any adapter call", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([assistantTurn("Should never be reached.")]);

    const outcome = await runDispatchDecision(
      makeInput({
        decisionId: "d-unknown-version",
        store,
        adapter,
        invoke: makeInvoke([]),
        promptVersion: "dispatch-v9-does-not-exist",
      }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.terminationReason).toBe("internal_error");
    expect(adapter.requests.length).toBe(0);

    const steps = store.stepsFor("d-unknown-version");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "error", payload: { kind: "internal" } });
    expect((steps[0].payload as { message: string }).message).toContain("dispatch-v9-does-not-exist");
    expect(store.latest("d-unknown-version").terminationReason).toBe("internal_error");
  });
});
