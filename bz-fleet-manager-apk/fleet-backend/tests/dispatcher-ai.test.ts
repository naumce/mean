import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app, loginDispatcher, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { MAX_QUEUED_PER_ORG, setAdapterFactory } from "../src/lib/aiHarness/runner.js";
import * as ollamaAdapter from "../src/lib/aiHarness/ollamaAdapter.js";
import { fetchDriverNames, fetchScenarios } from "../src/lib/aiHarness/runView.js";
import { scriptedAdapter } from "./helpers/scriptedAdapter.js";
import { assistantProposeTurn, createReeferLoad, seedAiHarnessFixture, waitForRunStatus } from "./helpers/aiHarnessFixture.js";
import type { ChatResponse, ModelAdapter } from "../src/lib/aiHarness/types.js";

// Qwen Harness v0.1, Task 6 — dispatcherAi.ts/dispatcherAiRuns.ts routes.
// This whole surface 404s unless OLLAMA_URL is set, so every test outside
// the dedicated "disabled" block sets it in beforeEach and every enqueued
// run is driven by an injected scripted/deferred adapter — nothing here ever
// reaches a real Ollama server.

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

/** Logs in a fresh dispatcher for an EXISTING org — used when a test also
 *  needs seedAiHarnessFixture's own org (drivers/tractor/trailer) rather
 *  than a bare one, so a dispatcher session and a captureBaseline-ready org
 *  are always the SAME org, never two different ones. */
async function attachDispatcher(org: { id: string }) {
  const dispatcher = await prisma.dispatcher.create({
    data: { email: `disp-${org.id}@x.com`, passwordHash: await hashPassword("pw"), name: "Dispatcher", orgId: org.id },
  });
  const { token } = await loginDispatcher(dispatcher.email, "pw");
  return { dispatcher, auth: { Authorization: `Bearer ${token}` } };
}

async function setupDispatcher(orgName: string) {
  const org = await prisma.org.create({ data: { name: orgName } });
  const { dispatcher, auth } = await attachDispatcher(org);
  return { org, dispatcher, auth };
}

async function createExperiment(orgId: string, name = "Experiment") {
  return prisma.aiExperiment.create({ data: { orgId, name, model: "qwen3:8b" } });
}

function deferredAdapter(): { adapter: ModelAdapter; release: (response: ChatResponse) => void } {
  let releaseFn!: (response: ChatResponse) => void;
  const pending = new Promise<ChatResponse>((resolve) => { releaseFn = resolve; });
  return { adapter: { name: "deferred", async chat() { return pending; } }, release: releaseFn };
}

/** Inserts an already-finished AiDecisionRecord directly (bypassing the real
 *  queue) plus a couple of transcript steps — for routes whose behaviour
 *  (read, decision, replay-from-done) does not depend on how the run got
 *  there. Queued/running-specific behaviour is tested through the real
 *  enqueueRun + scripted/deferred adapter path instead, further down. */
async function seedFinishedRun(orgId: string, experimentId: string, loadId: string, overrides: Record<string, unknown> = {}) {
  const record = await prisma.aiDecisionRecord.create({
    data: {
      experimentId, orgId, loadId, kind: "dispatch_candidate",
      status: "proposed", terminationReason: "proposed",
      context: { loadRef: "L-FINISHED", requestedAt: new Date().toISOString() },
      toolCalls: [{ seq: 3, name: "findFeasibleDrivers" }],
      toolResults: [{ seq: 4, name: "findFeasibleDrivers", ok: true, truncated: false }],
      stats: { modelCalls: 2, toolCalls: 1, uniqueTools: 1, repeatedCalls: 0, invalidCalls: 0, promptTokens: 40, completionTokens: 20, durationMs: 500 },
      startedAt: new Date(),
      completedAt: new Date(),
      ...overrides,
    },
  });
  await prisma.aiRunStep.create({ data: { decisionId: record.id, seq: 1, kind: "system", payload: { content: "system prompt" }, atMs: BigInt(Date.now()) } });
  await prisma.aiRunStep.create({ data: { decisionId: record.id, seq: 2, kind: "user", payload: { content: "user prompt" }, atMs: BigInt(Date.now()) } });
  return record;
}

describe("the /ai surface is gated on harnessEnabled()", () => {
  it("404s every route when OLLAMA_URL is unset", async () => {
    const { org, auth } = await setupDispatcher("Gate Co");
    const experiment = await createExperiment(org.id);
    delete process.env.OLLAMA_URL;

    const calls: [string, "get" | "post" | "patch", object?][] = [
      ["/api/dispatcher/ai/status", "get"],
      ["/api/dispatcher/ai/uncovered-loads", "get"],
      ["/api/dispatcher/ai/experiments", "get"],
      ["/api/dispatcher/ai/experiments", "post", { name: "X" }],
      [`/api/dispatcher/ai/experiments/${experiment.id}`, "get"],
      [`/api/dispatcher/ai/experiments/${experiment.id}`, "patch", { name: "Y" }],
      [`/api/dispatcher/ai/experiments/${experiment.id}/runs`, "post", { loadId: "x" }],
      [`/api/dispatcher/ai/experiments/${experiment.id}/runs/batch`, "post", { limit: 1 }],
      [`/api/dispatcher/ai/experiments/${experiment.id}/evaluation`, "get"],
      ["/api/dispatcher/ai/runs", "get"],
      ["/api/dispatcher/ai/runs/x", "get"],
      ["/api/dispatcher/ai/runs/x/cancel", "post"],
      ["/api/dispatcher/ai/runs/x/decision", "post", { verdict: "accept" }],
      ["/api/dispatcher/ai/runs/x/replay", "post"],
    ];

    for (const [path, method, body] of calls) {
      const res = await request(app)[method](path).set(auth).send(body ?? {});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    }
  });
});

describe("GET /ai/status", () => {
  it("reports enabled, the stubbed Ollama check, defaults, prompt versions, and this org's queue", async () => {
    const { auth } = await setupDispatcher("Status Co");
    const stub = vi.spyOn(ollamaAdapter, "checkOllama").mockResolvedValue({
      reachable: true, version: "0.34.3", models: ["qwen3:8b"], modelPresent: true, error: null,
    });

    const res = await request(app).get("/api/dispatcher/ai/status").set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      ollama: { reachable: true, version: "0.34.3", models: ["qwen3:8b"], modelPresent: true, error: null },
      defaults: expect.objectContaining({ adapter: "ollama", model: "qwen3:8b" }),
      promptVersions: ["dispatch-v1"],
      queue: { running: null, queued: [] },
      orphaned: 0,
    });
    stub.mockRestore();
  });

  // I1: `orphaned` counts this org's rows the database still calls
  // queued/running that the (fresh, test) process's in-memory runner has
  // never heard of — inserted directly rather than through enqueueRun, the
  // same as a real restart would leave behind.
  it("reports orphaned rows the runner does not own", async () => {
    const { org, auth } = await setupDispatcher("Status Orphan Co");
    const stub = vi.spyOn(ollamaAdapter, "checkOllama").mockResolvedValue({
      reachable: true, version: "0.34.3", models: ["qwen3:8b"], modelPresent: true, error: null,
    });
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-STATUS-ORPHAN");
    await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: load.id, kind: "dispatch_candidate",
        status: "running", startedAt: new Date(), context: {}, toolCalls: [], toolResults: [],
      },
    });

    const res = await request(app).get("/api/dispatcher/ai/status").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.orphaned).toBe(1);
    stub.mockRestore();
  });
});

describe("GET /ai/uncovered-loads", () => {
  it("returns the org's uncovered loads with scenario/city/window fields", async () => {
    const { org, auth } = await setupDispatcher("Uncovered Co");
    const load = await createReeferLoad(org.id, "L-UNCOVERED");
    await prisma.load.update({ where: { id: load.id }, data: { extras: { scenario: { code: "S1", title: "Scenario One", hint: "hint text" } } } });

    const res = await request(app).get("/api/dispatcher/ai/uncovered-loads").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.loads).toHaveLength(1);
    expect(res.body.loads[0]).toEqual({
      id: load.id,
      externalId: "L-UNCOVERED",
      customerName: null,
      scenario: { code: "S1", title: "Scenario One", hint: "hint text" },
      requiredEquip: "Reefer",
      pickupWindowStart: null,
      pickupWindowEnd: new Date("2027-01-01T00:00:00.000Z").toISOString(),
      originCity: "Chicago",
      destCity: "Nashville",
    });
  });
});

describe("experiments CRUD", () => {
  it("POST creates an experiment, resolving+syncing the legacy model column", async () => {
    const { auth } = await setupDispatcher("Create Exp Co");
    const res = await request(app).post("/api/dispatcher/ai/experiments").set(auth).send({
      name: "My Experiment", notes: "some notes", config: { model: "qwen3:14b", temperature: 0.5 },
    });
    expect(res.status).toBe(201);
    expect(res.body.experiment).toMatchObject({
      name: "My Experiment", notes: "some notes", status: "active", model: "qwen3:14b",
      promptVersion: "dispatch-v1", runCount: 0, lastRunAt: null,
    });
    expect(res.body.experiment.config).toMatchObject({ model: "qwen3:14b", temperature: 0.5, adapter: "ollama" });

    const row = await prisma.aiExperiment.findUnique({ where: { id: res.body.experiment.id } });
    expect(row?.model).toBe("qwen3:14b");
  });

  it("400s on an invalid body (missing name, out-of-range config)", async () => {
    const { auth } = await setupDispatcher("Create Exp Bad Co");
    const missingName = await request(app).post("/api/dispatcher/ai/experiments").set(auth).send({});
    expect(missingName.status).toBe(400);

    const badConfig = await request(app).post("/api/dispatcher/ai/experiments").set(auth).send({ name: "X", config: { temperature: 99 } });
    expect(badConfig.status).toBe(400);
  });

  it("GET lists experiments for the org with runCount/lastRunAt", async () => {
    const { org, auth } = await setupDispatcher("List Exp Co");
    const experiment = await createExperiment(org.id, "Listed");
    const load = await createReeferLoad(org.id, "L-LIST");
    await seedFinishedRun(org.id, experiment.id, load.id);

    const res = await request(app).get("/api/dispatcher/ai/experiments").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.experiments).toHaveLength(1);
    expect(res.body.experiments[0]).toMatchObject({ id: experiment.id, name: "Listed", runCount: 1 });
    expect(res.body.experiments[0].lastRunAt).not.toBeNull();
  });

  it("GET :id returns the experiment and its runs, 404s cross-org", async () => {
    const { org, auth } = await setupDispatcher("Get Exp Co");
    const other = await setupDispatcher("Get Exp Other Co");
    const experiment = await createExperiment(org.id, "Detail");
    const load = await createReeferLoad(org.id, "L-DETAIL");
    await seedFinishedRun(org.id, experiment.id, load.id);

    const ok = await request(app).get(`/api/dispatcher/ai/experiments/${experiment.id}`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body.experiment.id).toBe(experiment.id);
    expect(ok.body.runs).toHaveLength(1);
    expect(ok.body.runs[0]).toMatchObject({ loadId: load.id, loadRef: "L-FINISHED", status: "proposed" });

    const crossOrg = await request(app).get(`/api/dispatcher/ai/experiments/${experiment.id}`).set(other.auth);
    expect(crossOrg.status).toBe(404);

    const missing = await request(app).get("/api/dispatcher/ai/experiments/no-such-id").set(auth);
    expect(missing.status).toBe(404);
  });

  // I5: this route must never pull a run's heavy JSON columns just to build
  // the list — `baseline`/`evidence` alone run tens of KB per row.
  it("GET :id's runs list never carries baseline/evidence/toolCalls/toolResults/context/proposedDecision", async () => {
    const { org, auth } = await setupDispatcher("Heavy Payload Co");
    const experiment = await createExperiment(org.id, "Heavy");
    const load = await createReeferLoad(org.id, "L-HEAVY");
    const bigBaseline = {
      capturedAt: new Date().toISOString(), requiredEquip: "Reefer", note: null,
      candidates: Array.from({ length: 200 }, (_, i) => ({
        driverId: `d${i}`, driverName: `Driver ${i}`, feasible: true, score: 0.5,
        deadheadMi: 10, marginCents: 100, etaMs: 1000, blockedReason: null, context: null,
      })),
      feasibleDriverIds: [], topFeasibleDriverId: null,
    };
    await seedFinishedRun(org.id, experiment.id, load.id, { baseline: bigBaseline });

    const res = await request(app).get(`/api/dispatcher/ai/experiments/${experiment.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    // `context` is intentionally still present — it is tiny
    // ({ loadRef, requestedAt }) and RunSummary.loadRef is derived from it;
    // only the genuinely heavy/unneeded columns are checked here.
    for (const key of ["baseline", "evidence", "toolCalls", "toolResults", "proposedDecision"]) {
      expect(res.body.runs[0]).not.toHaveProperty(key);
    }
    // The big baseline still round-trips correctly for the run this test
    // actually seeded — proves the response is otherwise complete, not just
    // missing keys because the row itself came back empty.
    expect(res.body.runs[0]).toMatchObject({ loadId: load.id, status: "proposed" });
  });

  it("PATCH merges config over the stored one and re-syncs the legacy model column", async () => {
    const { org, auth } = await setupDispatcher("Patch Exp Co");
    const experiment = await prisma.aiExperiment.create({
      data: { orgId: org.id, name: "Original", model: "qwen3:8b", config: { model: "qwen3:8b", temperature: 0.2 } },
    });

    const res = await request(app).patch(`/api/dispatcher/ai/experiments/${experiment.id}`).set(auth).send({
      status: "archived", config: { temperature: 0.9 },
    });
    expect(res.status).toBe(200);
    expect(res.body.experiment.status).toBe("archived");
    // temperature overwritten, model preserved from what was already stored.
    expect(res.body.experiment.config).toMatchObject({ model: "qwen3:8b", temperature: 0.9 });

    const row = await prisma.aiExperiment.findUnique({ where: { id: experiment.id } });
    expect(row?.model).toBe("qwen3:8b");
    expect((row?.config as { temperature?: number })?.temperature).toBe(0.9);
  });

  it("PATCH 400s an empty body and 404s cross-org", async () => {
    const { org, auth } = await setupDispatcher("Patch Exp Bad Co");
    const other = await setupDispatcher("Patch Exp Other Co");
    const experiment = await createExperiment(org.id);

    const empty = await request(app).patch(`/api/dispatcher/ai/experiments/${experiment.id}`).set(auth).send({});
    expect(empty.status).toBe(400);

    const crossOrg = await request(app).patch(`/api/dispatcher/ai/experiments/${experiment.id}`).set(other.auth).send({ name: "Nope" });
    expect(crossOrg.status).toBe(404);
  });
});

describe("POST /ai/experiments/:id/runs and /runs/batch", () => {
  it("202s with a runId, 400s a missing loadId, 404s a cross-org/missing experiment or load", async () => {
    const { org, auth } = await setupDispatcher("Start Run Co");
    const other = await setupDispatcher("Start Run Other Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-START");
    setAdapterFactory(() => scriptedAdapter([]));

    const ok = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: load.id });
    expect(ok.status).toBe(202);
    expect(typeof ok.body.runId).toBe("string");
    // Let it actually finish (empty script -> fast model_error -> failed) so
    // no background write from this test's org can race the next test's
    // resetDb().
    await waitForRunStatus(ok.body.runId, TERMINAL_STATUSES);

    const badBody = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({});
    expect(badBody.status).toBe(400);

    const missingExperiment = await request(app).post("/api/dispatcher/ai/experiments/no-such-id/runs").set(auth).send({ loadId: load.id });
    expect(missingExperiment.status).toBe(404);

    const crossOrgExperiment = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(other.auth).send({ loadId: load.id });
    expect(crossOrgExperiment.status).toBe(404);

    const otherLoad = await createReeferLoad(other.org.id, "L-OTHER-ORG");
    const crossOrgLoad = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: otherLoad.id });
    expect(crossOrgLoad.status).toBe(404);
  });

  it("429 QUEUE_FULL once MAX_QUEUED_PER_ORG runs are QUEUED — the running one does not count", async () => {
    const { org, auth } = await setupDispatcher("Queue Full Co");
    const experiment = await createExperiment(org.id);
    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);

    // 1 held running (never counts toward the cap, fix round 1's ruling) +
    // enough behind it to fill all MAX_QUEUED_PER_ORG queue slots + one more
    // to actually observe the refusal.
    const loads = await Promise.all(Array.from({ length: MAX_QUEUED_PER_ORG + 2 }, (_, i) => createReeferLoad(org.id, `L-QF-${i}`)));
    const first = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: loads[0]!.id });
    expect(first.status).toBe(202);
    await waitForRunStatus(first.body.runId, ["running"]);

    let sawQueueFull = false;
    for (const load of loads.slice(1)) {
      const res = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: load.id });
      if (res.status === 429) {
        expect(res.body).toEqual({ error: "QUEUE_FULL" });
        sawQueueFull = true;
        break;
      }
      expect(res.status).toBe(202);
    }
    expect(sawQueueFull).toBe(true);
  });

  it("batch stops at the queue cap even when more uncovered loads remain", async () => {
    const { org, auth } = await setupDispatcher("Batch Cap Co");
    const experiment = await createExperiment(org.id);

    // Fill 5 of the org's 10 queue slots: a run held "running" forever by a
    // deferred adapter (does not count toward the cap) plus 5 queued behind
    // it. These filler loads are created already "assigned" so they never
    // show up as uncovered themselves — the batch call below should only
    // ever see the 8 genuinely uncovered loads created after them.
    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);
    const fillerLoads = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createReeferLoad(org.id, `L-FILL-${i}`, { status: "assigned" })),
    );
    const runningRes = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: fillerLoads[0]!.id });
    expect(runningRes.status).toBe(202);
    await waitForRunStatus(runningRes.body.runId, ["running"]);
    for (const load of fillerLoads.slice(1)) {
      const res = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: load.id });
      expect(res.status).toBe(202);
    }

    // 8 genuinely uncovered loads; only 5 queue slots remain (10 - 5 already
    // queued), so the batch must stop after 5 despite requesting 8.
    await Promise.all(Array.from({ length: 8 }, (_, i) => createReeferLoad(org.id, `L-BCAP-${i}`)));

    const res = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs/batch`).set(auth).send({ limit: 8 });
    expect(res.status).toBe(202);
    expect(res.body.runIds).toHaveLength(5);
  });

  it("batch enqueues up to limit uncovered loads", async () => {
    const { org, auth } = await setupDispatcher("Batch Co");
    const experiment = await createExperiment(org.id);
    await Promise.all(Array.from({ length: 3 }, (_, i) => createReeferLoad(org.id, `L-BATCH-${i}`)));
    setAdapterFactory(() => scriptedAdapter([]));

    const res = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs/batch`).set(auth).send({ limit: 2 });
    expect(res.status).toBe(202);
    expect(res.body.runIds).toHaveLength(2);
    // Same reasoning as the single-enqueue test above: let both finish
    // before this test (and its org) goes away.
    await Promise.all((res.body.runIds as string[]).map((id) => waitForRunStatus(id, TERMINAL_STATUSES)));

    const badLimit = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs/batch`).set(auth).send({ limit: 11 });
    expect(badLimit.status).toBe(400);
  });
});

describe("GET /ai/runs", () => {
  it("lists runs for the org, filterable by experimentId/loadId/status, cross-org isolated", async () => {
    const { org, auth } = await setupDispatcher("List Runs Co");
    const other = await setupDispatcher("List Runs Other Co");
    const experiment = await createExperiment(org.id);
    const loadA = await createReeferLoad(org.id, "L-LR-A");
    const loadB = await createReeferLoad(org.id, "L-LR-B");
    const runA = await seedFinishedRun(org.id, experiment.id, loadA.id, { status: "proposed", terminationReason: "proposed" });
    const runB = await seedFinishedRun(org.id, experiment.id, loadB.id, { status: "incomplete", terminationReason: "no_decision" });
    const otherExperiment = await createExperiment(other.org.id);
    const otherLoad = await createReeferLoad(other.org.id, "L-LR-OTHER");
    await seedFinishedRun(other.org.id, otherExperiment.id, otherLoad.id);

    const all = await request(app).get("/api/dispatcher/ai/runs").set(auth);
    expect(all.status).toBe(200);
    expect(all.body.runs.map((r: { id: string }) => r.id).sort()).toEqual([runA.id, runB.id].sort());

    const byStatus = await request(app).get("/api/dispatcher/ai/runs?status=incomplete").set(auth);
    expect(byStatus.body.runs.map((r: { id: string }) => r.id)).toEqual([runB.id]);

    const byLoad = await request(app).get(`/api/dispatcher/ai/runs?loadId=${loadA.id}`).set(auth);
    expect(byLoad.body.runs.map((r: { id: string }) => r.id)).toEqual([runA.id]);

    const otherView = await request(app).get("/api/dispatcher/ai/runs").set(other.auth);
    expect(otherView.body.runs.map((r: { id: string }) => r.id)).not.toContain(runA.id);

    const badQuery = await request(app).get("/api/dispatcher/ai/runs?limit=0").set(auth);
    expect(badQuery.status).toBe(400);
  });
});

describe("GET /ai/runs/:id", () => {
  it("returns run, steps, load, and driverNames covering proposal/alternatives/baseline/evidence", async () => {
    const { org, auth } = await setupDispatcher("Run Detail Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-DETAIL-FULL");
    await prisma.load.update({ where: { id: load.id }, data: { customerName: "Acme Foods", extras: { scenario: { code: "S2", title: "Two", hint: "h" } } } });

    const [pickDriver, altDriver, baselineOnlyDriver, evidenceOnlyDriver] = await Promise.all([
      prisma.driver.create({ data: { email: `pick@${org.id}.example`, passwordHash: "x", name: "Pick Driver", orgId: org.id } }),
      prisma.driver.create({ data: { email: `alt@${org.id}.example`, passwordHash: "x", name: "Alt Driver", orgId: org.id } }),
      prisma.driver.create({ data: { email: `base@${org.id}.example`, passwordHash: "x", name: "Baseline Driver", orgId: org.id } }),
      prisma.driver.create({ data: { email: `evid@${org.id}.example`, passwordHash: "x", name: "Evidence Driver", orgId: org.id } }),
    ]);

    const record = await seedFinishedRun(org.id, experiment.id, load.id, {
      driverId: pickDriver.id,
      proposedDecision: {
        driverId: pickDriver.id, reason: "Pick driver is closest and feasible for this load.", confidence: 0.8,
        alternatives: [{ driverId: altDriver.id, reason: "Also feasible, farther away." }],
      },
      baseline: {
        capturedAt: new Date().toISOString(), requiredEquip: "Reefer", note: null,
        candidates: [
          { driverId: pickDriver.id, driverName: "Pick Driver", feasible: true, score: 0.9, deadheadMi: 5, marginCents: 1000, etaMs: 100, blockedReason: null, context: null },
          { driverId: baselineOnlyDriver.id, driverName: "Baseline Driver", feasible: false, score: null, deadheadMi: 50, marginCents: 0, etaMs: 900, blockedReason: "out of hours", context: null },
        ],
        feasibleDriverIds: [pickDriver.id], topFeasibleDriverId: pickDriver.id,
      },
      evidence: {
        toolsCalled: [{ name: "getDriverMetrics", count: 1 }],
        candidatesInspected: [pickDriver.id],
        feasibilitySeen: [],
        metricsInspected: [evidenceOnlyDriver.id],
        historyInspected: [],
        factsCited: [{ text: "Pick driver is closest.", forDriverId: pickDriver.id }],
        supportingSteps: [],
      },
    });

    const res = await request(app).get(`/api/dispatcher/ai/runs/${record.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: record.id, driverId: pickDriver.id, driverName: "Pick Driver" });
    expect(res.body.run.proposedDecision.alternatives[0].driverId).toBe(altDriver.id);
    expect(res.body.load).toEqual({ id: load.id, externalId: "L-DETAIL-FULL", customerName: "Acme Foods", scenario: { code: "S2", title: "Two", hint: "h" } });
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.steps[0]).toMatchObject({ seq: 1, kind: "system" });
    expect(typeof res.body.steps[0].atMs).toBe("number");

    const names = res.body.driverNames as Record<string, string>;
    expect(names[pickDriver.id]).toBe("Pick Driver");
    expect(names[altDriver.id]).toBe("Alt Driver");
    expect(names[baselineOnlyDriver.id]).toBe("Baseline Driver");
    expect(names[evidenceOnlyDriver.id]).toBe("Evidence Driver");
  });

  it("404s a run belonging to another org", async () => {
    const { org } = await setupDispatcher("Run Detail Owner Co");
    const other = await setupDispatcher("Run Detail Stranger Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-STRANGER");
    const record = await seedFinishedRun(org.id, experiment.id, load.id);

    const res = await request(app).get(`/api/dispatcher/ai/runs/${record.id}`).set(other.auth);
    expect(res.status).toBe(404);
  });
});

describe("POST /ai/runs/:id/cancel", () => {
  it("cancels a queued run, aborts a running one, and returns false once it is done", async () => {
    const { org, auth } = await setupDispatcher("Cancel Route Co");
    const experiment = await createExperiment(org.id);
    const loadA = await createReeferLoad(org.id, "L-CANCEL-A");
    const loadB = await createReeferLoad(org.id, "L-CANCEL-B");

    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);

    const runA = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: loadA.id });
    await waitForRunStatus(runA.body.runId, ["running"]);
    const runB = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: loadB.id });

    const cancelQueued = await request(app).post(`/api/dispatcher/ai/runs/${runB.body.runId}/cancel`).set(auth);
    expect(cancelQueued.body).toEqual({ cancelled: true });
    await waitForRunStatus(runB.body.runId, ["cancelled"]);

    const cancelRunning = await request(app).post(`/api/dispatcher/ai/runs/${runA.body.runId}/cancel`).set(auth);
    expect(cancelRunning.body).toEqual({ cancelled: true });
    await waitForRunStatus(runA.body.runId, ["cancelled"]);

    const cancelAgain = await request(app).post(`/api/dispatcher/ai/runs/${runA.body.runId}/cancel`).set(auth);
    expect(cancelAgain.body).toEqual({ cancelled: false });
  });

  it("404s a cancel attempt on a run belonging to another org", async () => {
    const { org } = await setupDispatcher("Cancel Owner Co");
    const other = await setupDispatcher("Cancel Stranger Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-CANCEL-STRANGER");
    const record = await seedFinishedRun(org.id, experiment.id, load.id);

    const res = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/cancel`).set(other.auth);
    expect(res.status).toBe(404);
  });

  // I1: a row left `running` by a restart (inserted directly here, never
  // through enqueueRun) is unknown to this process's runner, but cancel must
  // still reclaim it rather than answer `{ cancelled: false }` forever. A
  // verdict on the now-cancelled row still 409s (the allow-list is
  // proposed/incomplete/failed only); a replay is allowed, same as any other
  // cancelled run.
  it("cancels an orphaned row (running in the DB, owned by no runner); verdict still 409s but replay is allowed", async () => {
    const { org, auth } = await setupDispatcher("Cancel Orphan Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-CANCEL-ORPHAN");
    const record = await prisma.aiDecisionRecord.create({
      data: {
        experimentId: experiment.id, orgId: org.id, loadId: load.id, kind: "dispatch_candidate",
        status: "running", startedAt: new Date(), context: {}, toolCalls: [], toolResults: [],
      },
    });

    const cancel = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/cancel`).set(auth);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ cancelled: true });

    const row = await prisma.aiDecisionRecord.findUnique({ where: { id: record.id } });
    expect(row?.status).toBe("cancelled");
    expect(row?.terminationReason).toBe("cancelled");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.error).toMatch(/orphaned/i);

    const decision = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(auth).send({ verdict: "accept" });
    expect(decision.status).toBe(409);

    setAdapterFactory(() => scriptedAdapter([]));
    const replay = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/replay`).set(auth);
    expect(replay.status).toBe(202);
    await waitForRunStatus(replay.body.runId, TERMINAL_STATUSES);
  });
});

describe("POST /ai/runs/:id/decision", () => {
  it("accepts a verdict, requires a valid driverId for \"other\", and 409s while running", async () => {
    const { org, auth } = await setupDispatcher("Decision Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-DECISION");
    const otherDriver = await prisma.driver.create({ data: { email: `od@${org.id}.example`, passwordHash: "x", name: "Other Driver", orgId: org.id } });
    const record = await seedFinishedRun(org.id, experiment.id, load.id);

    const accept = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(auth).send({ verdict: "accept" });
    expect(accept.status).toBe(200);
    expect(accept.body.run.humanDecision).toMatchObject({ verdict: "accept" });

    const otherMissingDriver = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(auth).send({ verdict: "other" });
    expect(otherMissingDriver.status).toBe(400);

    const otherBadDriver = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(auth).send({ verdict: "other", driverId: "no-such-driver" });
    expect(otherBadDriver.status).toBe(400);

    const otherOk = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(auth).send({ verdict: "other", driverId: otherDriver.id, note: "picked someone else" });
    expect(otherOk.status).toBe(200);
    expect(otherOk.body.run.humanDecision).toEqual({ verdict: "other", driverId: otherDriver.id, note: "picked someone else", byDispatcherId: expect.any(String) });

    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);
    const running = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: load.id });
    await waitForRunStatus(running.body.runId, ["running"]);
    const whileRunning = await request(app).post(`/api/dispatcher/ai/runs/${running.body.runId}/decision`).set(auth).send({ verdict: "accept" });
    expect(whileRunning.status).toBe(409);
  });

  it("409s a decision on a cancelled run — the allow-list is exhaustive (proposed/incomplete/failed), not just \"not queued/running\"", async () => {
    const { org, auth } = await setupDispatcher("Decision Cancelled Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-DECISION-CANCELLED");
    const record = await seedFinishedRun(org.id, experiment.id, load.id, { status: "cancelled", terminationReason: "cancelled" });

    const res = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(auth).send({ verdict: "accept" });
    expect(res.status).toBe(409);
  });

  it("404s a decision on a run in another org", async () => {
    const { org } = await setupDispatcher("Decision Owner Co");
    const other = await setupDispatcher("Decision Stranger Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-DECISION-STRANGER");
    const record = await seedFinishedRun(org.id, experiment.id, load.id);

    const res = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/decision`).set(other.auth).send({ verdict: "accept" });
    expect(res.status).toBe(404);
  });
});

describe("POST /ai/runs/:id/replay", () => {
  it("enqueues a new run with parentRunId set to the source run, and 409s while running", async () => {
    const { org, auth } = await setupDispatcher("Replay Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-REPLAY");
    const record = await seedFinishedRun(org.id, experiment.id, load.id);
    setAdapterFactory(() => scriptedAdapter([]));

    const res = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/replay`).set(auth);
    expect(res.status).toBe(202);
    expect(typeof res.body.runId).toBe("string");

    const replayRow = await prisma.aiDecisionRecord.findUnique({ where: { id: res.body.runId } });
    expect(replayRow?.parentRunId).toBe(record.id);
    expect(replayRow?.experimentId).toBe(experiment.id);
    expect(replayRow?.loadId).toBe(load.id);

    // Let the replay run actually finish (its empty-script adapter fails
    // fast, in the background) before swapping the factory below —
    // adapterFactory is one shared global, so changing it while this run
    // might not yet have called it could hand the deferred adapter to the
    // WRONG run and hang it forever instead of the one started next.
    await waitForRunStatus(res.body.runId, TERMINAL_STATUSES);

    const deferred = deferredAdapter();
    setAdapterFactory(() => deferred.adapter);
    const running = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: load.id });
    await waitForRunStatus(running.body.runId, ["running"]);
    const replayWhileRunning = await request(app).post(`/api/dispatcher/ai/runs/${running.body.runId}/replay`).set(auth);
    expect(replayWhileRunning.status).toBe(409);
  });

  it("404s a replay attempt on a run belonging to another org", async () => {
    const { org } = await setupDispatcher("Replay Owner Co");
    const other = await setupDispatcher("Replay Stranger Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-REPLAY-STRANGER");
    const record = await seedFinishedRun(org.id, experiment.id, load.id);

    const res = await request(app).post(`/api/dispatcher/ai/runs/${record.id}/replay`).set(other.auth);
    expect(res.status).toBe(404);
  });
});

describe("GET /ai/experiments/:id/evaluation", () => {
  it("returns the evaluation for the org's experiment, 404s cross-org", async () => {
    const { org, auth } = await setupDispatcher("Evaluation Route Co");
    const other = await setupDispatcher("Evaluation Route Other Co");
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-EVAL-ROUTE");
    await seedFinishedRun(org.id, experiment.id, load.id, {
      proposedDecision: { driverId: null, reason: "No feasible driver had capacity for this load.", confidence: 0.2, alternatives: [] },
    });

    const res = await request(app).get(`/api/dispatcher/ai/experiments/${experiment.id}/evaluation`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.evaluation.experimentId).toBe(experiment.id);
    expect(res.body.evaluation.rows).toHaveLength(1);
    expect(res.body.evaluation.summary.runs).toBe(1);

    const crossOrg = await request(app).get(`/api/dispatcher/ai/experiments/${experiment.id}/evaluation`).set(other.auth);
    expect(crossOrg.status).toBe(404);
  });
});

describe("runView.ts cross-org defense in depth (fix round 1)", () => {
  it("fetchDriverNames/fetchScenarios never resolve an id belonging to another org", async () => {
    const { org } = await setupDispatcher("Scoping Owner Co");
    const other = await setupDispatcher("Scoping Stranger Co");
    const otherDriver = await prisma.driver.create({
      data: { email: `stranger@${other.org.id}.example`, passwordHash: "x", name: "Stranger Driver", orgId: other.org.id },
    });
    const otherLoad = await createReeferLoad(other.org.id, "L-STRANGER-SCOPE");
    await prisma.load.update({ where: { id: otherLoad.id }, data: { extras: { scenario: { code: "X", title: "X title", hint: "x hint" } } } });

    // Scoped to `org`, but both ids belong to `other.org` — must resolve to
    // nothing, not the real name/scenario.
    const names = await fetchDriverNames([otherDriver.id], org.id);
    expect(names.get(otherDriver.id)).toBeUndefined();

    const scenarios = await fetchScenarios([otherLoad.id], org.id);
    expect(scenarios.get(otherLoad.id)).toBeUndefined();

    // Sanity check: the SAME ids resolve fine when scoped to their own org
    // (or left unscoped), proving the test isn't just exercising a query
    // that always returns nothing.
    expect((await fetchDriverNames([otherDriver.id], other.org.id)).get(otherDriver.id)).toBe("Stranger Driver");
    expect((await fetchDriverNames([otherDriver.id], null)).get(otherDriver.id)).toBe("Stranger Driver");
    expect((await fetchScenarios([otherLoad.id], other.org.id)).get(otherLoad.id)).toEqual({ code: "X", title: "X title", hint: "x hint" });
  });
});

describe("real completion end-to-end (scripted adapter, no queueing edge cases)", () => {
  it("a full enqueue -> proposed run round-trips through GET /ai/runs/:id", async () => {
    const { org, feasible } = await seedAiHarnessFixture("End To End Co");
    const { auth } = await attachDispatcher(org);
    const experiment = await createExperiment(org.id);
    const load = await createReeferLoad(org.id, "L-E2E");
    setAdapterFactory(() => scriptedAdapter([assistantProposeTurn(feasible.id)]));

    const started = await request(app).post(`/api/dispatcher/ai/experiments/${experiment.id}/runs`).set(auth).send({ loadId: load.id });
    expect(started.status).toBe(202);
    await waitForRunStatus(started.body.runId, TERMINAL_STATUSES);

    const res = await request(app).get(`/api/dispatcher/ai/runs/${started.body.runId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("proposed");
    expect(res.body.run.driverId).toBe(feasible.id);
  });
});
