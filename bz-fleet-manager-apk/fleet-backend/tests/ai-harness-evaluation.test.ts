import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { evaluateExperiment } from "../src/lib/aiHarness/evaluation.js";
import type { Baseline } from "../src/lib/aiHarness/baseline.js";
import type { Proposal } from "../src/lib/aiHarness/decision.js";

// Qwen Harness v0.1, Task 6 — evaluation.ts: a pure mapping over an
// experiment's own AiDecisionRecord rows. Every row here is inserted
// directly (never through the real runner/loop) — evaluateExperiment reads
// only the columns loop.ts itself writes at the end of a run, so a
// hand-built row exercises exactly the same read path a real one would.

beforeEach(resetDb);

const NOW = Date.now();

function baselineFixture(topDriverId: string, secondDriverId: string): Baseline {
  return {
    capturedAt: new Date(NOW).toISOString(),
    requiredEquip: "Reefer",
    note: null,
    candidates: [
      { driverId: topDriverId, driverName: "Top Driver", feasible: true, score: 0.9, deadheadMi: 10, marginCents: 5000, etaMs: 1000, blockedReason: null, context: null },
      { driverId: secondDriverId, driverName: "Second Driver", feasible: true, score: 0.6, deadheadMi: 40, marginCents: 3000, etaMs: 2000, blockedReason: null, context: null },
    ],
    feasibleDriverIds: [topDriverId, secondDriverId],
    topFeasibleDriverId: topDriverId,
  };
}

function proposalFor(driverId: string, confidence: number): Proposal {
  return { driverId, reason: "This driver is the best fit for this load right now.", confidence, alternatives: [] };
}

async function seedExperimentWithThreeRuns() {
  const org = await prisma.org.create({ data: { name: "Evaluation Co" } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: "eval-disp@x.com", passwordHash: "x", name: "Eval Dispatcher", orgId: org.id } });
  const topDriver = await prisma.driver.create({ data: { email: "top@eval.example", passwordHash: "x", name: "Top Driver", orgId: org.id } });
  const secondDriver = await prisma.driver.create({ data: { email: "second@eval.example", passwordHash: "x", name: "Second Driver", orgId: org.id } });

  const scenarioLoad = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 50000, status: "open",
      extras: { scenario: { code: "RUSH", title: "Rush Reefer", hint: "Tight pickup window" } },
    },
  });
  const plainLoadA = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 50000, status: "open" } });
  const plainLoadB = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 50000, status: "open" } });

  const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "Evaluation Experiment", model: "qwen3:8b" } });

  const baseline = baselineFixture(topDriver.id, secondDriver.id);

  // Row 1: proposed, matches the deterministic top (rank 1), human accepted.
  const matching = await prisma.aiDecisionRecord.create({
    data: {
      experimentId: experiment.id, orgId: org.id, loadId: scenarioLoad.id, kind: "dispatch_candidate",
      status: "proposed", terminationReason: "proposed",
      context: { loadRef: "L-MATCH", requestedAt: new Date(NOW).toISOString() },
      toolCalls: [], toolResults: [],
      baseline: baseline as unknown as object,
      proposedDecision: proposalFor(topDriver.id, 0.9) as unknown as object,
      reason: "Top driver is closest and feasible.",
      confidence: 0.9,
      driverId: topDriver.id,
      humanDecision: { verdict: "accept", driverId: topDriver.id, note: null, byDispatcherId: dispatcher.id },
      decidedAt: new Date(NOW + 1000),
      stats: { modelCalls: 4, toolCalls: 3, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0, promptTokens: 120, completionTokens: 60, durationMs: 2000 },
      startedAt: new Date(NOW),
      completedAt: new Date(NOW + 2000),
    },
  });

  // Row 2: proposed, does NOT match the top (picks the rank-2 candidate),
  // human rejected.
  const mismatched = await prisma.aiDecisionRecord.create({
    data: {
      experimentId: experiment.id, orgId: org.id, loadId: plainLoadA.id, kind: "dispatch_candidate",
      status: "proposed", terminationReason: "proposed",
      context: { loadRef: "L-MISMATCH", requestedAt: new Date(NOW).toISOString() },
      toolCalls: [], toolResults: [],
      baseline: baseline as unknown as object,
      proposedDecision: proposalFor(secondDriver.id, 0.4) as unknown as object,
      reason: "Second driver was the only one who answered.",
      confidence: 0.4,
      driverId: secondDriver.id,
      humanDecision: { verdict: "reject", driverId: null, note: "Not comfortable with this pick.", byDispatcherId: dispatcher.id },
      decidedAt: new Date(NOW + 5000),
      stats: { modelCalls: 6, toolCalls: 5, uniqueTools: 3, repeatedCalls: 1, invalidCalls: 1, promptTokens: 200, completionTokens: 100, durationMs: 4000 },
      startedAt: new Date(NOW + 3000),
      completedAt: new Date(NOW + 7000),
    },
  });

  // Row 3: incomplete (no_decision) — no baseline, no proposal, no human
  // verdict. Exercises every "missing" null branch at once.
  const incomplete = await prisma.aiDecisionRecord.create({
    data: {
      experimentId: experiment.id, orgId: org.id, loadId: plainLoadB.id, kind: "dispatch_candidate",
      status: "incomplete", terminationReason: "no_decision",
      context: { loadRef: "L-INCOMPLETE", requestedAt: new Date(NOW).toISOString() },
      toolCalls: [], toolResults: [],
      stats: { modelCalls: 2, toolCalls: 1, uniqueTools: 1, repeatedCalls: 0, invalidCalls: 1, promptTokens: 50, completionTokens: 20, durationMs: 1000 },
      startedAt: new Date(NOW + 9000),
      completedAt: new Date(NOW + 10000),
    },
  });

  return { org, experiment, topDriver, secondDriver, matching, mismatched, incomplete };
}

describe("evaluateExperiment", () => {
  it("returns null for a missing experiment or one belonging to another org", async () => {
    const org = await prisma.org.create({ data: { name: "Lonely Org" } });
    expect(await evaluateExperiment(org.id, "no-such-experiment")).toBeNull();

    const { org: otherOrg, experiment } = await seedExperimentWithThreeRuns();
    expect(otherOrg.id).not.toBe(org.id);
    expect(await evaluateExperiment(org.id, experiment.id)).toBeNull();
  });

  it("maps three finished runs to exact rows and a rolled-up summary", async () => {
    const { org, experiment, topDriver, secondDriver, matching, mismatched, incomplete } = await seedExperimentWithThreeRuns();

    const evaluation = await evaluateExperiment(org.id, experiment.id);
    expect(evaluation).not.toBeNull();
    if (!evaluation) return;

    expect(evaluation.experimentId).toBe(experiment.id);
    expect(evaluation.rows).toHaveLength(3);
    // Newest first, same convention as every other run listing in this
    // feature — the three rows were created in this order, so proposedAt
    // descending reverses it.
    expect(evaluation.rows.map((r) => r.runId)).toEqual([incomplete.id, mismatched.id, matching.id]);

    const matchRow = evaluation.rows.find((r) => r.runId === matching.id)!;
    expect(matchRow).toMatchObject({
      loadId: matching.loadId,
      loadRef: "L-MATCH",
      scenario: { code: "RUSH", title: "Rush Reefer", hint: "Tight pickup window" },
      status: "proposed",
      terminationReason: "proposed",
      deterministicTop: { driverId: topDriver.id, name: "Top Driver" },
      deterministicRankOfPick: 1,
      pick: { driverId: topDriver.id, name: "Top Driver" },
      confidence: 0.9,
      humanVerdict: "accept",
      humanDriverId: topDriver.id,
      matchesDeterministicTop: true,
      turns: 4,
      toolCalls: 3,
      uniqueTools: 2,
      repeatedCalls: 0,
      invalidCalls: 0,
      latencyMs: 2000,
      promptTokens: 120,
      completionTokens: 60,
    });
    expect(matchRow.startedAt).toBe(new Date(NOW).toISOString());

    const mismatchRow = evaluation.rows.find((r) => r.runId === mismatched.id)!;
    expect(mismatchRow).toMatchObject({
      loadRef: "L-MISMATCH",
      scenario: null,
      status: "proposed",
      deterministicTop: { driverId: topDriver.id, name: "Top Driver" },
      deterministicRankOfPick: 2,
      pick: { driverId: secondDriver.id, name: "Second Driver" },
      humanVerdict: "reject",
      humanDriverId: null,
      matchesDeterministicTop: false,
      turns: 6,
      toolCalls: 5,
      repeatedCalls: 1,
      invalidCalls: 1,
      latencyMs: 4000,
    });

    const incompleteRow = evaluation.rows.find((r) => r.runId === incomplete.id)!;
    expect(incompleteRow).toMatchObject({
      loadRef: "L-INCOMPLETE",
      scenario: null,
      status: "incomplete",
      terminationReason: "no_decision",
      deterministicTop: null,
      deterministicRankOfPick: null,
      pick: null,
      confidence: null,
      humanVerdict: null,
      humanDriverId: null,
      matchesDeterministicTop: null,
      turns: 2,
      toolCalls: 1,
      latencyMs: 1000,
    });

    expect(evaluation.summary).toEqual({
      runs: 3,
      byTermination: { proposed: 2, no_decision: 1 },
      proposed: 2,
      matchedDeterministicTop: 1,
      accepted: 1,
      rejected: 1,
      // Means are over the two PROPOSED runs only (4 and 6 turns; 3 and 5
      // tool calls; 2000ms and 4000ms) — the incomplete run's own numbers
      // must not dilute them.
      meanTurns: 5,
      meanToolCalls: 4,
      meanLatencyMs: 3000,
      // Neither seeded stats blob carries candidatesInvestigated (both
      // predate the field) — null, never a guessed 0.
      meanCandidatesInvestigated: null,
      // Over the same two proposed runs' own confidence (0.9, 0.4).
      meanConfidence: 0.65,
      confidenceBands: { "≥0.90": 1, "0.70–0.89": 0, "0.50–0.69": 0, "<0.50": 1 },
      // Both proposed runs pick a DIFFERENT driver once each — a tie, broken
      // by row order (newest first: mismatched before matching).
      repeatedPick: { driverId: secondDriver.id, name: "Second Driver", share: 0.5 },
    });
  });

  // I3: `contextPressure` is read straight off `stats` (`?? false` when the
  // row predates the field), never recomputed here — evaluation.ts only
  // reports what the loop already decided.
  it("passes through stats.contextPressure, defaulting missing/undefined to false", async () => {
    const org = await prisma.org.create({ data: { name: "Ctx Pressure Co" } });
    const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "Ctx Pressure Experiment", model: "qwen3:8b" } });
    const driver = await prisma.driver.create({ data: { email: "ctx@eval.example", passwordHash: "x", name: "Ctx Driver", orgId: org.id } });
    const loadPressure = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 0, status: "open" } });
    const loadFine = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 0, status: "open" } });

    const withPressure = await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: loadPressure.id, kind: "dispatch_candidate",
        status: "proposed", terminationReason: "proposed",
        context: {}, toolCalls: [], toolResults: [],
        proposedDecision: proposalFor(driver.id, 0.9) as unknown as object,
        stats: { modelCalls: 5, toolCalls: 4, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0, promptTokens: 12000, completionTokens: 500, maxPromptTokens: 12000, contextPressure: true, durationMs: 1000 },
        startedAt: new Date(NOW), completedAt: new Date(NOW + 1000),
      },
    });
    // Predates the field entirely (no maxPromptTokens/contextPressure key at
    // all) — the honest "old row" shape, not just contextPressure: undefined.
    const predatesField = await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: loadFine.id, kind: "dispatch_candidate",
        status: "proposed", terminationReason: "proposed",
        context: {}, toolCalls: [], toolResults: [],
        proposedDecision: proposalFor(driver.id, 0.9) as unknown as object,
        stats: { modelCalls: 2, toolCalls: 1, uniqueTools: 1, repeatedCalls: 0, invalidCalls: 0, promptTokens: 100, completionTokens: 50, durationMs: 500 },
        startedAt: new Date(NOW), completedAt: new Date(NOW + 500),
      },
    });

    const evaluation = await evaluateExperiment(org.id, experiment.id);
    expect(evaluation?.rows.find((r) => r.runId === withPressure.id)?.contextPressure).toBe(true);
    expect(evaluation?.rows.find((r) => r.runId === predatesField.id)?.contextPressure).toBe(false);
  });

  it("summary means are null when there are no proposed runs", async () => {
    const org = await prisma.org.create({ data: { name: "No Proposals Co" } });
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 0, status: "open" } });
    const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "No Proposals Experiment", model: "qwen3:8b" } });
    await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: load.id, kind: "dispatch_candidate",
        status: "cancelled", terminationReason: "cancelled",
        context: { loadRef: "L-CANCELLED", requestedAt: new Date(NOW).toISOString() },
        toolCalls: [], toolResults: [],
        startedAt: new Date(NOW), completedAt: new Date(NOW + 500),
      },
    });

    const evaluation = await evaluateExperiment(org.id, experiment.id);
    expect(evaluation?.summary).toEqual({
      runs: 1,
      byTermination: { cancelled: 1 },
      proposed: 0,
      matchedDeterministicTop: 0,
      accepted: 0,
      rejected: 0,
      meanTurns: null,
      meanToolCalls: null,
      meanLatencyMs: null,
      meanCandidatesInvestigated: null,
      meanConfidence: null,
      confidenceBands: { "≥0.90": 0, "0.70–0.89": 0, "0.50–0.69": 0, "<0.50": 0 },
      repeatedPick: null,
    });
  });

  it("promptVersion/candidatesInvestigated on rows, and the new summary fields over real numbers", async () => {
    const org = await prisma.org.create({ data: { name: "New Fields Co" } });
    const experiment = await prisma.aiExperiment.create({ data: { orgId: org.id, name: "New Fields Experiment", model: "qwen3:8b", promptVersion: "dispatch-v2" } });
    const driverA = await prisma.driver.create({ data: { email: "a@newfields.example", passwordHash: "x", name: "Driver A", orgId: org.id } });
    const driverB = await prisma.driver.create({ data: { email: "b@newfields.example", passwordHash: "x", name: "Driver B", orgId: org.id } });
    const loadA = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 0, status: "open" } });
    const loadB = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 0, status: "open" } });
    const loadC = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "Reefer", revenueCents: 0, status: "open" } });

    // Three proposed runs, all picking driverA: two land in the ">=0.90" band
    // (one with candidatesInvestigated), one lands in "<0.50".
    await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: loadA.id, kind: "dispatch_candidate",
        status: "proposed", terminationReason: "proposed", context: {}, toolCalls: [], toolResults: [],
        promptVersion: "dispatch-v2",
        proposedDecision: proposalFor(driverA.id, 0.95) as unknown as object, confidence: 0.95, driverId: driverA.id,
        stats: { modelCalls: 3, toolCalls: 2, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0, promptTokens: 10, completionTokens: 10, durationMs: 100, candidatesInvestigated: 2 },
        startedAt: new Date(NOW), completedAt: new Date(NOW + 100),
      },
    });
    await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: loadB.id, kind: "dispatch_candidate",
        status: "proposed", terminationReason: "proposed", context: {}, toolCalls: [], toolResults: [],
        promptVersion: "dispatch-v2",
        proposedDecision: proposalFor(driverA.id, 0.92) as unknown as object, confidence: 0.92, driverId: driverA.id,
        stats: { modelCalls: 5, toolCalls: 4, uniqueTools: 2, repeatedCalls: 0, invalidCalls: 0, promptTokens: 10, completionTokens: 10, durationMs: 100, candidatesInvestigated: 1 },
        startedAt: new Date(NOW), completedAt: new Date(NOW + 100),
      },
    });
    await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: loadC.id, kind: "dispatch_candidate",
        status: "proposed", terminationReason: "proposed", context: {}, toolCalls: [], toolResults: [],
        promptVersion: "dispatch-v1", // this experiment's OWN promptVersion may have changed since; the RUN kept its own
        proposedDecision: proposalFor(driverB.id, 0.2) as unknown as object, confidence: 0.2, driverId: driverB.id,
        stats: { modelCalls: 2, toolCalls: 1, uniqueTools: 1, repeatedCalls: 0, invalidCalls: 0, promptTokens: 10, completionTokens: 10, durationMs: 100 },
        startedAt: new Date(NOW), completedAt: new Date(NOW + 100),
      },
    });

    const evaluation = await evaluateExperiment(org.id, experiment.id);
    expect(evaluation).not.toBeNull();
    if (!evaluation) return;

    const rowV2WithCount = evaluation.rows.find((r) => r.confidence === 0.95)!;
    expect(rowV2WithCount).toMatchObject({ promptVersion: "dispatch-v2", candidatesInvestigated: 2 });
    const rowV1NoCount = evaluation.rows.find((r) => r.confidence === 0.2)!;
    expect(rowV1NoCount).toMatchObject({ promptVersion: "dispatch-v1", candidatesInvestigated: null });

    expect(evaluation.summary.meanCandidatesInvestigated).toBe(1.5); // mean of [2, 1] — the third row has none
    expect(evaluation.summary.meanConfidence).toBeCloseTo((0.95 + 0.92 + 0.2) / 3, 10);
    expect(evaluation.summary.confidenceBands).toEqual({ "≥0.90": 2, "0.70–0.89": 0, "0.50–0.69": 0, "<0.50": 1 });
    expect(evaluation.summary.repeatedPick).toEqual({ driverId: driverA.id, name: "Driver A", share: 2 / 3 });
  });
});
