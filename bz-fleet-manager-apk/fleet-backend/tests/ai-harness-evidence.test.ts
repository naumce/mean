import { collectEvidence } from "../src/lib/aiHarness/evidence.js";
import type { StoredStep } from "../src/lib/aiHarness/runStore.js";
import type { Proposal } from "../src/lib/aiHarness/decision.js";
import type { Baseline } from "../src/lib/aiHarness/baseline.js";

// Qwen Harness v0.1, Task 5 — evidence.ts: collectEvidence is pure over a
// StoredStep[] transcript, so it is tested here against a hand-built synthetic
// step list rather than a live run — no adapter, no database, no loop.

function step(seq: number, kind: StoredStep["kind"], name: string | null, payload: unknown): StoredStep {
  return { seq, kind, name, payload, atMs: 1_000 + seq, durationMs: null };
}

describe("collectEvidence", () => {
  it("reconstructs tools called, candidates inspected, feasibility from both sources, metrics/history, facts, and supporting steps", () => {
    const baseline: Baseline = {
      capturedAt: new Date().toISOString(),
      requiredEquip: "Reefer",
      note: null,
      candidates: [
        { driverId: "d1", driverName: "Dana", feasible: true, score: 0.8, deadheadMi: 5, marginCents: 100, etaMs: 1000, blockedReason: null, context: null },
        { driverId: "d2", driverName: "Bo", feasible: false, score: null, deadheadMi: 0, marginCents: 0, etaMs: 0, blockedReason: "HOS", context: null },
      ],
      feasibleDriverIds: ["d1"],
      topFeasibleDriverId: "d1",
    };

    const steps: StoredStep[] = [
      step(1, "system", null, { content: "sys" }),
      step(2, "user", null, { content: "user" }),
      step(3, "assistant", null, { content: "", toolCalls: [{ name: "findFeasibleDrivers", arguments: { loadId: "load-1" } }], stats: {}, doneReason: null }),
      step(4, "tool_call", "findFeasibleDrivers", { name: "findFeasibleDrivers", arguments: { loadId: "load-1" } }),
      step(5, "tool_result", "findFeasibleDrivers", {
        name: "findFeasibleDrivers", ok: true, truncated: false, originalSize: 10, returnedSize: 10, preview: "{}",
        feasibility: [
          { driverId: "d1", feasible: true, score: 0.8, blockedReason: null },
          { driverId: "d3", feasible: true, score: 0.6, blockedReason: null },
        ],
      }),
      step(6, "assistant", null, { content: "", toolCalls: [{ name: "getDriverMetrics", arguments: { driverId: "d1" } }], stats: {}, doneReason: null }),
      step(7, "tool_call", "getDriverMetrics", { name: "getDriverMetrics", arguments: { driverId: "d1" } }),
      step(8, "tool_result", "getDriverMetrics", { name: "getDriverMetrics", ok: true, truncated: false, originalSize: 5, returnedSize: 5, preview: '{"onTimeRate":0.9,"driverId":"d1"}' }),
      step(9, "assistant", null, { content: "", toolCalls: [{ name: "getDriverHistory", arguments: { driverId: "d1", limit: 10 } }], stats: {}, doneReason: null }),
      step(10, "tool_call", "getDriverHistory", { name: "getDriverHistory", arguments: { driverId: "d1", limit: 10 } }),
      step(11, "tool_result", "getDriverHistory", { name: "getDriverHistory", ok: true, truncated: false, originalSize: 5, returnedSize: 5, preview: "[]" }),
      // A second, repeated getDriverMetrics call: rejected. Deliberately
      // omits this attempt's own tool_call step (unlike a real run's, which
      // does persist one — I4) to prove collectEvidence's tool-name counting
      // depends only on whichever tool_call steps a step list actually
      // contains, not on any assumption about how many an attempt "should"
      // have produced.
      step(12, "assistant", null, { content: "", toolCalls: [{ name: "getDriverMetrics", arguments: { driverId: "d1" } }], stats: {}, doneReason: null }),
      step(13, "tool_result", "getDriverMetrics", { name: "getDriverMetrics", ok: false, error: "identical call already made; reuse the earlier result (step 8)" }),
      step(14, "assistant", null, {
        content: "",
        toolCalls: [{ name: "propose_decision", arguments: { driverId: "d1", reason: "d1 has a strong on-time rate and is feasible.", confidence: 0.8, alternatives: [] } }],
        stats: {},
        doneReason: null,
      }),
      step(15, "final", "propose_decision", {
        proposal: { driverId: "d1", reason: "d1 has a strong on-time rate and is feasible.", confidence: 0.8, alternatives: [{ driverId: "d3", reason: "Also feasible but farther away." }] },
      }),
    ];

    const proposal: Proposal = {
      driverId: "d1",
      reason: "d1 has a strong on-time rate and is feasible.",
      confidence: 0.8,
      alternatives: [{ driverId: "d3", reason: "Also feasible but farther away." }],
    };

    const contentsBySeq = new Map<number, string>([
      [5, JSON.stringify({ candidates: [{ driverId: "d1", feasible: true }, { driverId: "d3", feasible: true }] })],
      [8, JSON.stringify({ onTimeRate: 0.9, driverId: "d1" })],
      [11, JSON.stringify([])],
      [13, JSON.stringify({ ok: false, error: "identical call already made; reuse the earlier result (step 8)" })],
    ]);

    const evidence = collectEvidence(steps, proposal, baseline, contentsBySeq);

    expect(evidence.toolsCalled).toEqual([
      { name: "findFeasibleDrivers", count: 1 },
      { name: "getDriverMetrics", count: 1 }, // the rejected repeat never created its own tool_call step
      { name: "getDriverHistory", count: 1 },
    ]);

    expect(evidence.candidatesInspected).toEqual(["d1", "d2", "d3"]);

    expect(evidence.feasibilitySeen).toEqual([
      { driverId: "d1", feasible: true, score: 0.8, blockedReason: null, source: "baseline" },
      { driverId: "d2", feasible: false, score: null, blockedReason: "HOS", source: "baseline" },
      { driverId: "d1", feasible: true, score: 0.8, blockedReason: null, source: "tool" },
      { driverId: "d3", feasible: true, score: 0.6, blockedReason: null, source: "tool" },
    ]);

    expect(evidence.metricsInspected).toEqual(["d1"]);
    expect(evidence.historyInspected).toEqual(["d1"]);

    expect(evidence.factsCited).toEqual([
      { text: "d1 has a strong on-time rate and is feasible.", forDriverId: "d1" },
      { text: "Also feasible but farther away.", forDriverId: "d3" },
    ]);

    // Steps 5 and 8's FULL content mention "d1"; step 11's content ("[]")
    // does not, and step 13's error text does not mention "d1" either, even
    // though it is about the same tool -- neither is included.
    expect(evidence.supportingSteps).toEqual([5, 8]);
  });

  it("finds no supporting steps and no cited-alternative facts when the proposal recommends no driver", () => {
    const proposal: Proposal = { driverId: null, reason: "No feasible driver is appropriate for this load right now.", confidence: 0.4, alternatives: [] };
    const steps: StoredStep[] = [step(1, "tool_result", "findFeasibleDrivers", { name: "findFeasibleDrivers", ok: true })];
    const contentsBySeq = new Map<number, string>([[1, JSON.stringify({ candidates: [] })]]);

    const evidence = collectEvidence(steps, proposal, null, contentsBySeq);

    expect(evidence.supportingSteps).toEqual([]);
    expect(evidence.feasibilitySeen).toEqual([]);
    expect(evidence.candidatesInspected).toEqual([]);
    expect(evidence.factsCited).toEqual([{ text: proposal.reason, forDriverId: null }]);
  });

  it("returns an empty evidence shape for a step list with no tool activity at all", () => {
    const proposal: Proposal = { driverId: "d1", reason: "Only investigated by reading the load and user request.", confidence: 0.3, alternatives: [] };
    const steps: StoredStep[] = [step(1, "system", null, { content: "sys" }), step(2, "user", null, { content: "user" })];

    const evidence = collectEvidence(steps, proposal, null, new Map());

    expect(evidence).toEqual({
      toolsCalled: [],
      candidatesInspected: [],
      feasibilitySeen: [],
      metricsInspected: [],
      historyInspected: [],
      factsCited: [{ text: proposal.reason, forDriverId: "d1" }],
      supportingSteps: [],
      proposalAttempts: 0,
    });
  });

  // Round 2: propose_decision is the model's OUTPUT, not a registry tool it
  // called to gather evidence (adjustment #1) — its own tool_call steps (I4
  // persists one per attempt) must never surface as an inspected tool/driver,
  // and are counted separately.
  it("excludes propose_decision's own tool_call steps from toolsCalled/candidatesInspected, counting them as proposalAttempts instead", () => {
    const proposal: Proposal = { driverId: "d1", reason: "d1 is the only feasible candidate for this load.", confidence: 0.7, alternatives: [] };
    const rejectedArgs = { driverId: "d2", reason: "Not actually feasible for this load at all.", confidence: 0.5, alternatives: [] };
    const acceptedArgs = { driverId: "d1", reason: "d1 is the only feasible candidate for this load.", confidence: 0.7, alternatives: [] };
    const steps: StoredStep[] = [
      step(1, "assistant", null, { content: "", toolCalls: [{ name: "propose_decision", arguments: rejectedArgs }], stats: {}, doneReason: null }),
      step(2, "tool_call", "propose_decision", { name: "propose_decision", arguments: rejectedArgs }),
      step(3, "tool_result", "propose_decision", { name: "propose_decision", ok: false, errors: ["driver d2 was not among the feasible candidates for this load"] }),
      step(4, "assistant", null, { content: "", toolCalls: [{ name: "propose_decision", arguments: acceptedArgs }], stats: {}, doneReason: null }),
      step(5, "tool_call", "propose_decision", { name: "propose_decision", arguments: acceptedArgs }),
      step(6, "final", "propose_decision", { proposal }),
    ];

    const evidence = collectEvidence(steps, proposal, null, new Map());

    // Neither attempt's own driverId (d2's rejected pick or d1's accepted
    // one) leaks into candidatesInspected via the tool_call's `arguments`.
    expect(evidence.toolsCalled).toEqual([]);
    expect(evidence.candidatesInspected).toEqual([]);
    expect(evidence.proposalAttempts).toBe(2);
  });

  it("mixes propose_decision attempts with real registry tool calls without cross-contamination", () => {
    const proposal: Proposal = { driverId: "d1", reason: "d1's on-time rate justifies the pick.", confidence: 0.7, alternatives: [] };
    const steps: StoredStep[] = [
      step(1, "tool_call", "getDriverMetrics", { name: "getDriverMetrics", arguments: { driverId: "d1" } }),
      step(2, "tool_result", "getDriverMetrics", { name: "getDriverMetrics", ok: true, truncated: false, originalSize: 5, returnedSize: 5, preview: "{}" }),
      step(3, "tool_call", "propose_decision", { name: "propose_decision", arguments: { driverId: "d99", reason: "Trying a driver outside the feasible set.", confidence: 0.4, alternatives: [] } }),
      step(4, "tool_result", "propose_decision", { name: "propose_decision", ok: false, errors: ["driver d99 does not exist in this organization"] }),
      step(5, "tool_call", "propose_decision", { name: "propose_decision", arguments: { driverId: "d1", reason: "d1's on-time rate justifies the pick.", confidence: 0.7, alternatives: [] } }),
      step(6, "final", "propose_decision", { proposal }),
    ];

    const evidence = collectEvidence(steps, proposal, null, new Map());

    expect(evidence.toolsCalled).toEqual([{ name: "getDriverMetrics", count: 1 }]);
    expect(evidence.candidatesInspected).toEqual(["d1"]); // only from getDriverMetrics' own arguments, never d99
    expect(evidence.proposalAttempts).toBe(2);
  });
});
