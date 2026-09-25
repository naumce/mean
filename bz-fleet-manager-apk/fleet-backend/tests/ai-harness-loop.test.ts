import { Prisma } from "@prisma/client";
import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { scriptedAdapter } from "./helpers/scriptedAdapter.js";
import { memoryRunStore } from "./helpers/memoryRunStore.js";
import { runDispatchDecision, type RunInput } from "../src/lib/aiHarness/loop.js";
import { prismaRunStore, type StoredStep } from "../src/lib/aiHarness/runStore.js";
import { DEFAULT_HARNESS_CONFIG } from "../src/lib/aiHarness/config.js";
import { ModelError, type ChatResponse } from "../src/lib/aiHarness/types.js";
import type { InvokeResult } from "../src/lib/dispatchTools/invoke.js";
import type { Baseline } from "../src/lib/aiHarness/baseline.js";

// Qwen Harness v0.1, Task 5 — loop.ts core: the happy path, the
// propose_decision terminal contract (accept/reject/correct), thinking
// on/off, model errors, cancellation, onStep/onStatus ordering, and one
// end-to-end pass through the real `prismaRunStore`. Loop-protection caps
// (repeated/invalid/byte/turn/tool-call limits) and per-call timeout/run
// deadline live in ai-harness-loop-protection.test.ts; collectEvidence's own
// unit tests live in ai-harness-evidence.test.ts.
//
// Most tests use the in-memory `memoryRunStore` and never touch the
// database. `validateProposal` (Task 4) is NOT injectable, though, and always
// runs a real `prisma.driver.findMany` once a proposal reaches it — any test
// that wants an ACCEPTED (or feasibility-checked) proposal still seeds a real
// Org+Driver via `seedOrgWithDrivers()`. `resetDb` runs for every test in this
// file regardless, matching every other suite's convention.

beforeEach(resetDb);

async function seedOrgWithDrivers() {
  const org = await prisma.org.create({ data: { name: "Loop Co" } });
  const feasible = await prisma.driver.create({
    data: { email: "feasible@loop.com", passwordHash: "x", name: "Feasible Driver", orgId: org.id },
  });
  const other = await prisma.driver.create({
    data: { email: "other@loop.com", passwordHash: "x", name: "Other Driver", orgId: org.id },
  });
  return { org, feasible, other };
}

function baselineWith(rows: { driverId: string; feasible: boolean }[]): Baseline {
  return {
    capturedAt: new Date().toISOString(),
    requiredEquip: "Reefer",
    note: null,
    candidates: rows.map((r) => ({
      driverId: r.driverId,
      driverName: null,
      feasible: r.feasible,
      score: r.feasible ? 0.5 : null,
      deadheadMi: 0,
      marginCents: 0,
      etaMs: 0,
      blockedReason: r.feasible ? null : "blocked",
      context: null,
    })),
    feasibleDriverIds: rows.filter((r) => r.feasible).map((r) => r.driverId),
    topFeasibleDriverId: rows.find((r) => r.feasible)?.driverId ?? null,
  };
}

function assistantTurn(
  content: string,
  toolCalls: { name: string; arguments: Record<string, unknown> }[] = [],
  thinking?: string,
): ChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    doneReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    stats: { promptTokens: 10, completionTokens: 5, totalDurationMs: 50 },
  };
}

function makeInput(overrides: Partial<RunInput> & Pick<RunInput, "adapter">): RunInput {
  return {
    orgId: "org-1",
    decisionId: "decision-1",
    loadId: "load-1",
    loadRef: "L-100",
    config: DEFAULT_HARNESS_CONFIG,
    store: memoryRunStore(),
    captureBaseline: async () => null,
    ...overrides,
  };
}

function stepShape(s: StoredStep) {
  return { kind: s.kind, name: s.name, payload: s.payload };
}

describe("runDispatchDecision: happy path", () => {
  it("two tool calls then a valid proposal: ordered steps, stats, evidence, and a tool-seeded feasible set", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    const feasibleResult = {
      loadId: "load-1",
      requiredEquip: "Reefer",
      tractorId: null,
      trailerId: null,
      candidates: [
        { driverId: feasible.id, driverName: "Feasible Driver", feasible: true, score: 0.9, deadheadMi: 5, loadedMi: 300, etaMs: 100000, marginCents: 4000, marginPct: 0.3, warnings: [] },
      ],
    };
    const invoke = async (_orgId: string, name: string): Promise<InvokeResult> => {
      if (name === "findFeasibleDrivers") return { ok: true, value: feasibleResult };
      if (name === "getDriverMetrics") return { ok: true, value: { onTimeRate: 0.97, laneRuns: 12 } };
      return { ok: false, error: `unexpected tool ${name}`, code: "unknown_tool" };
    };
    const adapter = scriptedAdapter([
      assistantTurn("Checking feasibility.", [{ name: "findFeasibleDrivers", arguments: { loadId: "load-1" } }]),
      // Deliberately DIFFERENT token counts than the other two turns'
      // (10/5, via assistantTurn's default) so the final stats can only
      // match by actually SUMMING every call, not by echoing any one of them.
      {
        message: { role: "assistant", content: "Checking metrics.", toolCalls: [{ name: "getDriverMetrics", arguments: { driverId: feasible.id } }] },
        doneReason: "tool_calls",
        stats: { promptTokens: 30, completionTokens: 15, totalDurationMs: 80 },
      },
      assistantTurn("Recommending.", [
        {
          name: "propose_decision",
          arguments: {
            driverId: feasible.id,
            reason: "Feasible per findFeasibleDrivers and has a strong on-time rate.",
            confidence: 0.85,
            alternatives: [],
          },
        },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ orgId: org.id, decisionId: "d-happy", store, adapter, invoke, captureBaseline: async () => null }),
    );

    expect(outcome.status).toBe("proposed");
    expect(outcome.terminationReason).toBe("proposed");
    expect(outcome.proposal?.driverId).toBe(feasible.id);
    expect(outcome.stats).toMatchObject({ modelCalls: 3, toolCalls: 2, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0 });
    // Token-sum rule: the sum of every call's own promptTokens/completionTokens
    // (10 + 30 + 10 = 50, 5 + 15 + 5 = 25), not the last call's or any single one's.
    expect(outcome.stats.promptTokens).toBe(50);
    expect(outcome.stats.completionTokens).toBe(25);

    const steps = store.stepsFor("d-happy");
    expect(steps.map((s) => s.kind)).toEqual([
      "system", "user",
      "assistant", "tool_call", "tool_result",
      "assistant", "tool_call", "tool_result",
      "assistant", "final",
    ]);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const findResultStep = steps.find((s) => s.kind === "tool_result" && s.name === "findFeasibleDrivers");
    expect(findResultStep?.payload).toMatchObject({ ok: true, name: "findFeasibleDrivers", truncated: false });
    expect((findResultStep!.payload as { feasibility: unknown }).feasibility).toEqual([
      { driverId: feasible.id, feasible: true, score: 0.9, blockedReason: null },
    ]);

    const latest = store.latest("d-happy");
    expect(latest.status).toBe("proposed");
    expect(latest.evidence?.feasibilitySeen).toEqual(
      expect.arrayContaining([expect.objectContaining({ driverId: feasible.id, source: "tool" })]),
    );
    expect(latest.evidence?.toolsCalled).toEqual(
      expect.arrayContaining([
        { name: "findFeasibleDrivers", count: 1 },
        { name: "getDriverMetrics", count: 1 },
      ]),
    );
    expect(latest.toolCalls).toEqual([
      { seq: 4, name: "findFeasibleDrivers" },
      { seq: 7, name: "getDriverMetrics" },
    ]);
    expect(latest.toolResults).toEqual([
      { seq: 5, name: "findFeasibleDrivers", ok: true, truncated: false },
      { seq: 8, name: "getDriverMetrics", ok: true, truncated: false },
    ]);
  });
});

describe("runDispatchDecision: the propose_decision terminal contract", () => {
  it("rejects an invalid proposal and accepts the model's corrected one", async () => {
    const { org, feasible, other } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      assistantTurn("First attempt.", [
        { name: "propose_decision", arguments: { driverId: other.id, reason: "Not actually feasible for this load at all.", confidence: 0.5, alternatives: [] } },
      ]),
      assistantTurn("Correcting.", [
        { name: "propose_decision", arguments: { driverId: feasible.id, reason: "This driver is the only feasible candidate for this load.", confidence: 0.7, alternatives: [] } },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-corrected",
        store,
        adapter,
        captureBaseline: async () => baselineWith([{ driverId: feasible.id, feasible: true }]),
      }),
    );

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposal?.driverId).toBe(feasible.id);

    const steps = store.stepsFor("d-corrected");
    expect(steps.map((s) => s.kind)).toEqual(["system", "user", "assistant", "tool_result", "assistant", "final"]);
    const rejected = steps.find((s) => s.kind === "tool_result");
    expect(rejected?.name).toBe("propose_decision");
    expect(rejected?.payload).toMatchObject({ name: "propose_decision", ok: false });
    expect((rejected!.payload as { errors: string[] }).errors[0]).toMatch(/not among the feasible candidates/);

    expect(store.latest("d-corrected").stats).toMatchObject({ invalidCalls: 1, modelCalls: 2 });
  });

  it("adds findFeasibleDrivers' own feasible rows to the run's feasible set (baseline stays empty)", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    const invoke = async (): Promise<InvokeResult> => ({
      ok: true,
      value: { candidates: [{ driverId: feasible.id, feasible: true, score: 0.7 }] },
    });
    const adapter = scriptedAdapter([
      assistantTurn("Checking.", [{ name: "findFeasibleDrivers", arguments: { loadId: "load-1" } }]),
      assistantTurn("Recommending.", [
        { name: "propose_decision", arguments: { driverId: feasible.id, reason: "Only findFeasibleDrivers marked this driver feasible.", confidence: 0.6, alternatives: [] } },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ orgId: org.id, decisionId: "d-toolfeasible", store, adapter, invoke, captureBaseline: async () => null }),
    );

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposal?.driverId).toBe(feasible.id);
  });

  it("does NOT widen the feasible set from a findFeasibleDrivers call about a DIFFERENT load", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    // The tool call names a load OTHER than this run's own input.loadId
    // ("load-1") — a driver feasible there must never legitimise a proposal
    // for THIS run's load.
    const invoke = async (): Promise<InvokeResult> => ({
      ok: true,
      value: { candidates: [{ driverId: feasible.id, feasible: true, score: 0.7 }] },
    });
    const adapter = scriptedAdapter([
      assistantTurn("Checking a different load by mistake.", [{ name: "findFeasibleDrivers", arguments: { loadId: "load-2" } }]),
      assistantTurn("Recommending anyway.", [
        { name: "propose_decision", arguments: { driverId: feasible.id, reason: "Feasible per the findFeasibleDrivers call I just made.", confidence: 0.6, alternatives: [] } },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-wrongload",
        store,
        adapter,
        invoke,
        captureBaseline: async () => null,
        config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 2 },
      }),
    );

    expect(outcome.terminationReason).toBe("max_turns"); // never validly proposed within its (capped) turn budget
    const rejected = store.stepsFor("d-wrongload").find((s) => s.kind === "tool_result" && s.name === "propose_decision");
    expect((rejected!.payload as { errors: string[] }).errors[0]).toMatch(/not among the feasible candidates/);
  });
});

describe("runDispatchDecision: tool invocation failures", () => {
  it("rejects an unknown tool name via invokeTool's own check, without touching the database", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([assistantTurn("Trying an unknown tool.", [{ name: "frobnicateDriver", arguments: {} }])]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-unknown", store, adapter, config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 1 } }),
    );

    expect(outcome.terminationReason).toBe("max_turns");
    const badCall = store.stepsFor("d-unknown").find((s) => s.kind === "tool_result" && s.name === "frobnicateDriver");
    expect(badCall?.payload).toMatchObject({ ok: false, error: expect.stringContaining('Unknown tool "frobnicateDriver"') });
    expect(store.latest("d-unknown").stats).toMatchObject({ invalidCalls: 1 });
  });

  it("rejects invalid tool params via invokeTool's own zod check", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([assistantTurn("Missing the id.", [{ name: "getDriverMetrics", arguments: {} }])]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-badparams", store, adapter, config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 1 } }),
    );

    expect(outcome.terminationReason).toBe("max_turns");
    const badCall = store.stepsFor("d-badparams").find((s) => s.kind === "tool_result" && s.name === "getDriverMetrics");
    expect(badCall?.payload).toMatchObject({ ok: false, error: expect.stringContaining("driverId") });
  });
});

describe("runDispatchDecision: no decision", () => {
  it("nudges once on a tool-call-free turn, then ends as no_decision on a second", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      assistantTurn("Thinking out loud with no action."),
      assistantTurn("Still nothing concrete."),
    ]);

    const outcome = await runDispatchDecision(makeInput({ decisionId: "d-nudge", store, adapter }));

    expect(outcome.status).toBe("incomplete");
    expect(outcome.terminationReason).toBe("no_decision");
    const steps = store.stepsFor("d-nudge");
    expect(steps.map((s) => s.kind)).toEqual(["system", "user", "assistant", "nudge", "assistant"]);
    expect(steps[3].payload).toMatchObject({ content: expect.stringContaining("propose_decision") });
    expect(adapter.requests[1].messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("propose_decision") });
  });
});

describe("runDispatchDecision: model errors and cancellation", () => {
  it("a ModelError from the adapter ends the run as model_error/failed with an error step", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([new ModelError("Ollama returned HTTP 500.", "http")]);

    const outcome = await runDispatchDecision(makeInput({ decisionId: "d-error", store, adapter }));

    expect(outcome.status).toBe("failed");
    expect(outcome.terminationReason).toBe("model_error");
    const steps = store.stepsFor("d-error");
    expect(steps.at(-1)).toMatchObject({ kind: "error", payload: { kind: "http", message: "Ollama returned HTTP 500." } });
    // The call that errored still counts: modelCalls increments before the
    // call is attempted, precisely so a failed call is not invisible in stats.
    expect(outcome.stats.modelCalls).toBe(1);
  });

  it("an already-aborted signal ends the run as cancelled before any model call", async () => {
    const store = memoryRunStore();
    const controller = new AbortController();
    controller.abort();
    const adapter = scriptedAdapter([assistantTurn("Should never be reached.")]);

    const outcome = await runDispatchDecision(makeInput({ decisionId: "d-cancel", store, adapter, signal: controller.signal }));

    expect(outcome.status).toBe("cancelled");
    expect(outcome.terminationReason).toBe("cancelled");
    expect(adapter.requests.length).toBe(0);
    expect(store.stepsFor("d-cancel").map((s) => s.kind)).toEqual(["system", "user", "error"]);
  });
});

describe("runDispatchDecision: unexpected throws (fix round 1)", () => {
  it("a captureBaseline throw is recorded as its own error step and the run continues with baseline: null", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      assistantTurn("Recommending.", [
        { name: "propose_decision", arguments: { driverId: feasible.id, reason: "The only feasible candidate I could find via my own tools.", confidence: 0.5, alternatives: [] } },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-baseline-throw",
        store,
        adapter,
        // A feasible baseline row for the proposed driver, seeded directly
        // via the run's own feasible set is NOT possible here (baseline
        // threw) -- so this proposal is expected to be REJECTED (no feasible
        // driver known), proving the run genuinely continued afterward
        // rather than aborting.
        captureBaseline: async () => {
          throw new Error("suggestForLoad exploded");
        },
        // One turn is enough: the proposal is rejected (no feasible driver
        // was ever seeded), and the run should reach max_turns on its own
        // rather than the baseline failure aborting it early.
        config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 1 },
      }),
    );

    // The run is NOT aborted by a baseline failure -- it runs out of its
    // turn budget instead, since nothing ever seeds a feasible driver for it
    // to propose.
    expect(outcome.terminationReason).toBe("max_turns");
    expect(outcome.status).toBe("incomplete");

    const steps = store.stepsFor("d-baseline-throw");
    const baselineError = steps.find((s) => s.kind === "error" && (s.payload as { kind: string }).kind === "baseline");
    expect(baselineError?.payload).toEqual({ kind: "baseline", message: "suggestForLoad exploded" });
    // It ran to completion afterward -- system/user/assistant steps exist
    // beyond just the one error step.
    expect(steps.some((s) => s.kind === "assistant")).toBe(true);
    expect(store.latest("d-baseline-throw").baseline).toBeNull();
  });

  it("an unexpected throw from anywhere else ends the run as internal_error/failed with a best-effort error step", async () => {
    const store = memoryRunStore();
    // A misbehaving tool stub that THROWS instead of returning `{ ok: false
    // }` -- exactly the "any other unexpected place" the ruling describes
    // (validateProposal's own DB call or the store failing would look the
    // same from runDispatchDecision's point of view).
    const invoke = async (): Promise<InvokeResult> => {
      throw new Error("tool registry blew up");
    };
    const adapter = scriptedAdapter([assistantTurn("Calling a tool.", [{ name: "getDriverMetrics", arguments: { driverId: "d1" } }])]);

    const outcome = await runDispatchDecision(makeInput({ decisionId: "d-internal-error", store, adapter, invoke }));

    expect(outcome.terminationReason).toBe("internal_error");
    expect(outcome.status).toBe("failed");
    const errorStep = store.stepsFor("d-internal-error").at(-1);
    expect(errorStep).toMatchObject({ kind: "error", payload: { kind: "internal", message: "tool registry blew up" } });
    expect(store.latest("d-internal-error").terminationReason).toBe("internal_error");
    expect(store.latest("d-internal-error").error).toBe("tool registry blew up");
  });
});

describe("runDispatchDecision: thinking on vs. off", () => {
  it("produces the identical decision path and identical non-thinking steps either way", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const captureBaseline = async () => baselineWith([{ driverId: feasible.id, feasible: true }]);
    const proposalArgs = { driverId: feasible.id, reason: "This is the only feasible candidate available.", confidence: 0.6, alternatives: [] };

    const withThinking = memoryRunStore();
    await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-think",
        store: withThinking,
        captureBaseline,
        adapter: scriptedAdapter([
          assistantTurn("Recommending.", [{ name: "propose_decision", arguments: proposalArgs }], "Let me consider the options."),
        ]),
      }),
    );

    const withoutThinking = memoryRunStore();
    await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-nothink",
        store: withoutThinking,
        captureBaseline,
        adapter: scriptedAdapter([assistantTurn("Recommending.", [{ name: "propose_decision", arguments: proposalArgs }])]),
      }),
    );

    const thinkingSteps = withThinking.stepsFor("d-think");
    const noThinkSteps = withoutThinking.stepsFor("d-nothink");

    expect(thinkingSteps.map((s) => s.kind)).toEqual(["system", "user", "thinking", "assistant", "final"]);
    expect(noThinkSteps.map((s) => s.kind)).toEqual(["system", "user", "assistant", "final"]);
    expect(thinkingSteps.filter((s) => s.kind !== "thinking").map(stepShape)).toEqual(noThinkSteps.map(stepShape));

    expect(withThinking.latest("d-think").status).toBe(withoutThinking.latest("d-nothink").status);
    expect(withThinking.latest("d-think").terminationReason).toBe(withoutThinking.latest("d-nothink").terminationReason);
  });
});

describe("runDispatchDecision: assistant stats", () => {
  it("records the model's own per-call stats, and a measured durationMs, on the assistant step", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      {
        message: {
          role: "assistant",
          content: "Recommending.",
          toolCalls: [{ name: "propose_decision", arguments: { driverId: feasible.id, reason: "This is the only feasible candidate available.", confidence: 0.6, alternatives: [] } }],
        },
        doneReason: "stop",
        stats: { promptTokens: 123, completionTokens: 45, totalDurationMs: 678 },
      },
    ]);

    await runDispatchDecision(
      makeInput({ orgId: org.id, decisionId: "d-stats", store, adapter, captureBaseline: async () => baselineWith([{ driverId: feasible.id, feasible: true }]) }),
    );

    const assistantStep = store.stepsFor("d-stats").find((s) => s.kind === "assistant");
    expect(assistantStep?.payload).toMatchObject({ stats: { promptTokens: 123, completionTokens: 45, totalDurationMs: 678 } });
    expect(typeof assistantStep?.durationMs).toBe("number");
  });
});

describe("runDispatchDecision: onStep/onStatus ordering", () => {
  it("calls onStatus(running) first, onStep after each persisted step in seq order, and the terminal onStatus last", async () => {
    const { org, feasible } = await seedOrgWithDrivers();
    const store = memoryRunStore();
    const events: string[] = [];
    const adapter = scriptedAdapter([
      assistantTurn("Recommending.", [{ name: "propose_decision", arguments: { driverId: feasible.id, reason: "This is the only feasible candidate available.", confidence: 0.6, alternatives: [] } }]),
    ]);

    await runDispatchDecision(
      makeInput({
        orgId: org.id,
        decisionId: "d-events",
        store,
        adapter,
        captureBaseline: async () => baselineWith([{ driverId: feasible.id, feasible: true }]),
        onStep: (seq, kind) => events.push(`step:${seq}:${kind}`),
        onStatus: (status) => events.push(`status:${status}`),
      }),
    );

    expect(events).toEqual([
      "status:running",
      "step:1:system",
      "step:2:user",
      "step:3:assistant",
      "step:4:final",
      "status:proposed",
    ]);
  });
});

describe("runDispatchDecision: prismaRunStore end-to-end", () => {
  it("persists real AiRunStep rows with correct seqs and Json columns on AiDecisionRecord", async () => {
    const CHICAGO = { lat: 41.8781, lng: -87.6298, address: "123 Dock Rd, Chicago, IL 60601" };
    const NASHVILLE = { lat: 36.1627, lng: -86.7816, address: "456 Warehouse Ave, Nashville, TN 37201" };
    const FAR = new Date("2027-01-01T00:00:00.000Z");
    const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

    const org = await prisma.org.create({ data: { name: "Prisma Store Co" } });
    await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
    await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "Reefer", status: "active" } });
    const feasible = await prisma.driver.create({
      data: {
        email: "feasible@store.com", passwordHash: "x", name: "Feasible Driver", orgId: org.id,
        lastLat: CHICAGO.lat, lastLng: CHICAGO.lng, hos: { create: FRESH_HOS },
      },
    });
    await prisma.driverAvailability.create({
      data: { driverId: feasible.id, source: "manual", acceptingLoads: true, availabilityStatus: "AVAILABLE" },
    });
    const load = await prisma.load.create({
      data: {
        orgId: org.id, externalId: "L-STORE", requiredEquip: "Reefer", revenueCents: 60000, status: "open",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng, appointment: { create: { windowEnd: FAR, type: "pickup" } } },
            { sequence: 2, type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng, appointment: { create: { windowEnd: FAR, type: "delivery" } } },
          ],
        },
      },
    });

    const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "Store Experiment", model: "qwen3:8b" } });
    const decision = await prisma.aiDecisionRecord.create({
      data: { experimentId: experiment.id, orgId: org.id, loadId: load.id, kind: "dispatch_candidate", context: {}, toolCalls: [], toolResults: [] },
    });

    const adapter = scriptedAdapter([
      assistantTurn("Recommending.", [
        { name: "propose_decision", arguments: { driverId: feasible.id, reason: "The only feasible driver for this load right now.", confidence: 0.75, alternatives: [] } },
      ]),
    ]);

    const outcome = await runDispatchDecision({
      orgId: org.id,
      decisionId: decision.id,
      loadId: load.id,
      loadRef: load.externalId,
      config: DEFAULT_HARNESS_CONFIG,
      adapter,
      store: prismaRunStore,
    });

    expect(outcome.status).toBe("proposed");

    const rows = await prisma.aiRunStep.findMany({ where: { decisionId: decision.id }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [1, "system"],
      [2, "user"],
      [3, "assistant"],
      [4, "final"],
    ]);
    expect(rows.every((r) => typeof r.atMs === "bigint")).toBe(true);

    // listSteps round-trips the same rows, in the same order, as plain
    // numbers (not BigInt) for atMs.
    const listed = await prismaRunStore.listSteps(decision.id);
    expect(listed.map((s) => [s.seq, s.kind])).toEqual([
      [1, "system"],
      [2, "user"],
      [3, "assistant"],
      [4, "final"],
    ]);
    expect(listed.every((s) => typeof s.atMs === "number")).toBe(true);

    const updated = await prisma.aiDecisionRecord.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.status).toBe("proposed");
    expect(updated.terminationReason).toBe("proposed");
    expect(updated.driverId).toBe(feasible.id);
    expect(updated.baseline).not.toBeNull();
    expect(updated.evidence).not.toBeNull();
    expect(updated.toolCalls).toEqual([]);
    expect(updated.toolResults).toEqual([]);
    expect((updated.stats as { modelCalls: number }).modelCalls).toBe(1);
  });

  it("persists a null baseline as real SQL NULL (Prisma.DbNull), read back as null", async () => {
    const org = await prisma.org.create({ data: { name: "Null Baseline Co" } });
    const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "Null Baseline Experiment", model: "qwen3:8b" } });
    // No Load row at all -- the real captureBaseline returns null for it,
    // exactly like a load that does not exist or belongs to another org.
    const decision = await prisma.aiDecisionRecord.create({
      data: { experimentId: experiment.id, orgId: org.id, loadId: "no-such-load", kind: "dispatch_candidate", context: {}, toolCalls: [], toolResults: [] },
    });
    const adapter = scriptedAdapter([
      assistantTurn("No feasible driver found.", [
        { name: "propose_decision", arguments: { driverId: null, reason: "The load referenced by this run does not exist, so nothing is feasible.", confidence: 0.2, alternatives: [] } },
      ]),
    ]);

    const outcome = await runDispatchDecision({
      orgId: org.id, decisionId: decision.id, loadId: "no-such-load", loadRef: null,
      config: DEFAULT_HARNESS_CONFIG, adapter, store: prismaRunStore,
    });

    expect(outcome.status).toBe("proposed");
    const updated = await prisma.aiDecisionRecord.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.baseline).toBeNull();
  });

  it("retries once when the store's own create() hits a P2002 race, then succeeds with the recomputed seq", async () => {
    const org = await prisma.org.create({ data: { name: "P2002 Retry Co" } });
    const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "P2002 Retry Experiment", model: "qwen3:8b" } });
    const decision = await prisma.aiDecisionRecord.create({
      data: { experimentId: experiment.id, orgId: org.id, kind: "dispatch_candidate", context: {}, toolCalls: [], toolResults: [] },
    });

    // Simulates the real race appendStep guards against: another writer
    // already took the seq this call computed. Reassigned directly (not
    // vi.spyOn) so the "call through to the real create()" step on the retry
    // is an explicit, correctly-`this`-bound call this test controls, rather
    // than relying on a mock library's own call-through semantics against
    // Prisma's client internals.
    const originalCreate = prisma.aiRunStep.create.bind(prisma.aiRunStep);
    let callCount = 0;
    // Prisma's `create<T>` is a generic method whose return type varies with
    // the caller's own `select`/`include` — too specific for a replacement
    // function to satisfy structurally, hence `any` here rather than a
    // narrower cast: this is test-only monkey-patching of one Prisma model
    // method, restored in `finally` below, never a runtime production path.
    const aiRunStepModel = prisma.aiRunStep as unknown as { create: (...args: unknown[]) => unknown };
    aiRunStepModel.create = (...args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`decisionId`,`seq`)", {
          code: "P2002",
          clientVersion: "5.22.0",
        });
      }
      return originalCreate(...(args as Parameters<typeof originalCreate>));
    };

    try {
      const seq = await prismaRunStore.appendStep(decision.id, { kind: "system", payload: { content: "x" }, atMs: Date.now() });
      expect(seq).toBe(1); // the retry recomputed count() (still 0, nothing had committed) and succeeded
      expect(callCount).toBe(2);
      const rows = await prisma.aiRunStep.findMany({ where: { decisionId: decision.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBe(1);
    } finally {
      aiRunStepModel.create = originalCreate as unknown as (...args: unknown[]) => unknown;
    }
  });
});
