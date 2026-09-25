import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import * as realtime from "../src/realtime.js";
import { cancelRun, enqueueRun, MAX_QUEUED_PER_ORG, runnerState, setAdapterFactory } from "../src/lib/aiHarness/runner.js";
import { scriptedAdapter } from "./helpers/scriptedAdapter.js";
import { assistantProposeTurn, createReeferLoad, seedAiHarnessFixture, waitForRunStatus } from "./helpers/aiHarnessFixture.js";
import type { ChatResponse, ModelAdapter } from "../src/lib/aiHarness/types.js";

// Qwen Harness v0.1, Task 6 — runner.ts: the in-process queue on top of
// Task 5's runDispatchDecision. These tests never reach a real Ollama server
// (setAdapterFactory always injects a scripted or deferred double) but DO
// exercise the real Prisma-backed store and the real realtime module, so
// harnessEnabled() must see OLLAMA_URL set for the whole file.

const ORIGINAL_OLLAMA_URL = process.env.OLLAMA_URL;
beforeEach(() => {
  process.env.OLLAMA_URL = "http://127.0.0.1:11434";
});
afterAll(() => {
  if (ORIGINAL_OLLAMA_URL === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = ORIGINAL_OLLAMA_URL;
});

beforeEach(resetDb);

const TERMINAL_STATUSES = ["proposed", "incomplete", "failed", "cancelled"] as const;

async function seedExperiment(orgId: string, name: string) {
  return prisma.aiExperiment.create({ data: { orgId, name, model: "qwen3:8b" } });
}

/** An adapter whose one `chat()` call stays pending until `release` is
 *  called — the only way to deterministically hold a run "running" while a
 *  test enqueues a second one behind it and inspects the queue. */
function deferredAdapter(): { adapter: ModelAdapter; release: (response: ChatResponse) => void } {
  let releaseFn!: (response: ChatResponse) => void;
  const pending = new Promise<ChatResponse>((resolve) => {
    releaseFn = resolve;
  });
  return { adapter: { name: "deferred", async chat() { return pending; } }, release: releaseFn };
}

describe("enqueueRun / drain: ordering", () => {
  it("runs one at a time per org, in FIFO order", async () => {
    const { org, feasible } = await seedAiHarnessFixture("Runner FIFO Co");
    const experiment = await seedExperiment(org.id, "FIFO Experiment");
    const loadA = await createReeferLoad(org.id, "L-FIFO-A");
    const loadB = await createReeferLoad(org.id, "L-FIFO-B");

    const deferred = deferredAdapter();
    let factoryCalls = 0;
    setAdapterFactory(() => {
      factoryCalls += 1;
      return factoryCalls === 1 ? deferred.adapter : scriptedAdapter([assistantProposeTurn(feasible.id)]);
    });

    const resultA = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: loadA.id, requestedById: null });
    if ("error" in resultA) throw new Error(`unexpected enqueue error: ${resultA.error}`);
    await waitForRunStatus(resultA.runId, ["running"]);

    const resultB = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: loadB.id, requestedById: null });
    if ("error" in resultB) throw new Error(`unexpected enqueue error: ${resultB.error}`);

    // B is queued behind A, not started — this is the actual queue-ordering
    // assertion, not just an outcome check.
    expect(runnerState(org.id)).toEqual({ running: resultA.runId, queued: [resultB.runId] });

    deferred.release(assistantProposeTurn(feasible.id));
    await waitForRunStatus(resultA.runId, TERMINAL_STATUSES);
    await waitForRunStatus(resultB.runId, TERMINAL_STATUSES);

    const [rowA, rowB] = await Promise.all([
      prisma.aiDecisionRecord.findUnique({ where: { id: resultA.runId } }),
      prisma.aiDecisionRecord.findUnique({ where: { id: resultB.runId } }),
    ]);
    expect(rowA?.status).toBe("proposed");
    expect(rowB?.status).toBe("proposed");
    // The actual FIFO/one-at-a-time proof: B could not have started before
    // A's own run finished.
    expect(rowA!.completedAt!.getTime()).toBeLessThanOrEqual(rowB!.startedAt!.getTime());
    expect(runnerState(org.id)).toEqual({ running: null, queued: [] });
  });

  it("returns QUEUE_FULL once MAX_QUEUED_PER_ORG runs are QUEUED — a running run does not count", async () => {
    const { org } = await seedAiHarnessFixture("Runner Cap Co");
    const experiment = await seedExperiment(org.id, "Cap Experiment");

    // Never released: run #1 stays "running" for the rest of this test. Per
    // fix round 1's ruling, the cap counts state.queue.length only — the
    // running run is not part of it — so MAX_QUEUED_PER_ORG MORE enqueues
    // behind it must all succeed, and only the one after that is refused.
    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);

    const loads = await Promise.all(
      Array.from({ length: MAX_QUEUED_PER_ORG + 2 }, (_, i) => createReeferLoad(org.id, `L-CAP-${i}`)),
    );

    const first = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: loads[0]!.id, requestedById: null });
    if ("error" in first) throw new Error(`unexpected enqueue error: ${first.error}`);
    await waitForRunStatus(first.runId, ["running"]);

    const rest = [];
    for (const load of loads.slice(1)) {
      rest.push(await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: load.id, requestedById: null }));
    }

    // rest[MAX_QUEUED_PER_ORG - 1] is the "9 queued + 1 running" moment
    // (queue was 9, becomes 10) — still accepted. rest[MAX_QUEUED_PER_ORG] is
    // "10 queued + 1 running" — refused regardless of the running run.
    expect(rest.slice(0, MAX_QUEUED_PER_ORG).every((r) => "runId" in r)).toBe(true);
    expect(rest[MAX_QUEUED_PER_ORG]).toEqual({ error: "QUEUE_FULL" });
    expect(runnerState(org.id).queued).toHaveLength(MAX_QUEUED_PER_ORG);
    expect(runnerState(org.id).running).toBe(first.runId);
  });

  it("HARNESS_DISABLED when OLLAMA_URL is unset", async () => {
    const { org } = await seedAiHarnessFixture("Runner Disabled Co");
    const experiment = await seedExperiment(org.id, "Disabled Experiment");
    const load = await createReeferLoad(org.id, "L-DISABLED");

    delete process.env.OLLAMA_URL;
    const result = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: load.id, requestedById: null });
    expect(result).toEqual({ error: "HARNESS_DISABLED" });
  });

  it("EXPERIMENT_NOT_FOUND / LOAD_NOT_FOUND for a missing or cross-org id", async () => {
    const { org } = await seedAiHarnessFixture("Runner Missing Co");
    const other = await seedAiHarnessFixture("Runner Missing Other Co");
    const experiment = await seedExperiment(org.id, "Missing Experiment");
    const load = await createReeferLoad(org.id, "L-MISSING");
    const otherLoad = await createReeferLoad(other.org.id, "L-MISSING-OTHER");

    expect(await enqueueRun({ orgId: org.id, experimentId: "no-such-experiment", loadId: load.id, requestedById: null }))
      .toEqual({ error: "EXPERIMENT_NOT_FOUND" });
    expect(await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: "no-such-load", requestedById: null }))
      .toEqual({ error: "LOAD_NOT_FOUND" });
    expect(await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: otherLoad.id, requestedById: null }))
      .toEqual({ error: "LOAD_NOT_FOUND" });
  });
});

describe("cancelRun", () => {
  it("cancels a queued run without ever starting it", async () => {
    const { org, feasible } = await seedAiHarnessFixture("Runner Cancel Queued Co");
    const experiment = await seedExperiment(org.id, "Cancel Queued Experiment");
    const loadA = await createReeferLoad(org.id, "L-CQ-A");
    const loadB = await createReeferLoad(org.id, "L-CQ-B");

    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);

    const resultA = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: loadA.id, requestedById: null });
    if ("error" in resultA) throw new Error(`unexpected enqueue error: ${resultA.error}`);
    await waitForRunStatus(resultA.runId, ["running"]);

    const resultB = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: loadB.id, requestedById: null });
    if ("error" in resultB) throw new Error(`unexpected enqueue error: ${resultB.error}`);
    expect(runnerState(org.id).queued).toEqual([resultB.runId]);

    const spy = vi.spyOn(realtime, "emitToDispatchers");
    const cancelled = await cancelRun(org.id, resultB.runId);
    expect(cancelled).toBe(true);
    expect(runnerState(org.id).queued).toEqual([]);

    const rowB = await prisma.aiDecisionRecord.findUnique({ where: { id: resultB.runId } });
    expect(rowB?.status).toBe("cancelled");
    expect(rowB?.terminationReason).toBe("cancelled");
    expect(rowB?.completedAt).not.toBeNull();
    expect(spy.mock.calls).toContainEqual([org.id, "ai_run_status", { runId: resultB.runId, status: "cancelled" }]);

    // Never started — A is still the only thing this org ever ran.
    deferred.release(assistantProposeTurn(feasible.id));
    await waitForRunStatus(resultA.runId, TERMINAL_STATUSES);
  });

  it("aborts a running run", async () => {
    const { org } = await seedAiHarnessFixture("Runner Cancel Running Co");
    const experiment = await seedExperiment(org.id, "Cancel Running Experiment");
    const load = await createReeferLoad(org.id, "L-CR");

    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);

    const result = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: load.id, requestedById: null });
    if ("error" in result) throw new Error(`unexpected enqueue error: ${result.error}`);
    await waitForRunStatus(result.runId, ["running"]);

    const cancelled = await cancelRun(org.id, result.runId);
    expect(cancelled).toBe(true);

    await waitForRunStatus(result.runId, ["cancelled"]);
    const row = await prisma.aiDecisionRecord.findUnique({ where: { id: result.runId } });
    expect(row?.status).toBe("cancelled");
  });

  it("returns false for a run that is neither queued nor running", async () => {
    const { org, feasible } = await seedAiHarnessFixture("Runner Cancel Done Co");
    const experiment = await seedExperiment(org.id, "Cancel Done Experiment");
    const load = await createReeferLoad(org.id, "L-DONE");

    setAdapterFactory(() => scriptedAdapter([assistantProposeTurn(feasible.id)]));
    const result = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: load.id, requestedById: null });
    if ("error" in result) throw new Error(`unexpected enqueue error: ${result.error}`);
    await waitForRunStatus(result.runId, TERMINAL_STATUSES);

    expect(await cancelRun(org.id, result.runId)).toBe(false);
    expect(await cancelRun(org.id, "no-such-run")).toBe(false);
  });
});

describe("realtime emits", () => {
  it("emits ai_run_step per step and ai_run_status per status change", async () => {
    const { org, feasible } = await seedAiHarnessFixture("Runner WS Co");
    const experiment = await seedExperiment(org.id, "WS Experiment");
    const load = await createReeferLoad(org.id, "L-WS");
    setAdapterFactory(() => scriptedAdapter([assistantProposeTurn(feasible.id)]));

    const spy = vi.spyOn(realtime, "emitToDispatchers");

    const result = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: load.id, requestedById: null });
    if ("error" in result) throw new Error(`unexpected enqueue error: ${result.error}`);
    await waitForRunStatus(result.runId, TERMINAL_STATUSES);

    const runId = result.runId;
    const stepCalls = spy.mock.calls.filter((c) => c[0] === org.id && c[1] === "ai_run_step" && (c[2] as { runId: string }).runId === runId);
    const statusCalls = spy.mock.calls.filter((c) => c[0] === org.id && c[1] === "ai_run_status" && (c[2] as { runId: string }).runId === runId);

    expect(stepCalls.length).toBeGreaterThan(0);
    for (const call of stepCalls) {
      const payload = call[2] as { runId: string; seq: number; kind: string };
      expect(typeof payload.seq).toBe("number");
      expect(typeof payload.kind).toBe("string");
    }
    expect(statusCalls.map((c) => (c[2] as { status: string }).status)).toEqual(expect.arrayContaining(["running", "proposed"]));
  });
});

describe("a throwing adapter factory", () => {
  it("marks that run failed/internal_error and the queue keeps draining", async () => {
    const { org, feasible } = await seedAiHarnessFixture("Runner Throw Co");
    const experiment = await seedExperiment(org.id, "Throw Experiment");
    const badLoad = await createReeferLoad(org.id, "L-BAD");
    const goodLoad = await createReeferLoad(org.id, "L-GOOD");

    let calls = 0;
    setAdapterFactory(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom: no model configured");
      return scriptedAdapter([assistantProposeTurn(feasible.id)]);
    });

    const badResult = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: badLoad.id, requestedById: null });
    if ("error" in badResult) throw new Error(`unexpected enqueue error: ${badResult.error}`);
    const goodResult = await enqueueRun({ orgId: org.id, experimentId: experiment.id, loadId: goodLoad.id, requestedById: null });
    if ("error" in goodResult) throw new Error(`unexpected enqueue error: ${goodResult.error}`);

    await waitForRunStatus(badResult.runId, ["failed"]);
    await waitForRunStatus(goodResult.runId, TERMINAL_STATUSES);

    const badRow = await prisma.aiDecisionRecord.findUnique({ where: { id: badResult.runId } });
    expect(badRow?.status).toBe("failed");
    expect(badRow?.terminationReason).toBe("internal_error");
    expect(badRow?.error).toContain("boom");
    expect(badRow?.completedAt).not.toBeNull();

    const goodRow = await prisma.aiDecisionRecord.findUnique({ where: { id: goodResult.runId } });
    expect(goodRow?.status).toBe("proposed");
  });
});
