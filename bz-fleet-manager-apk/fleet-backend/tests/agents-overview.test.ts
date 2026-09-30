import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { STANDARD_POLICY } from "../src/lib/agentPolicies.js";
import * as ollamaAdapter from "../src/lib/aiHarness/ollamaAdapter.js";

// Task 3 (AI Agents Surface): GET /api/dispatcher/agents/overview — the one
// read-only endpoint the "AI Agents" page (portal Task 4) and the demo both
// read. Every test here goes through the real app (helpers.js's `app`), the
// same discipline tests/night-shift-routes.test.ts follows: a cross-tenant
// row must never appear, and "not configured" must never be confused with
// "configured, nothing to show" (Global Constraints).

const ORIGINAL_OLLAMA_URL = process.env.OLLAMA_URL;
const ORIGINAL_WORKER_URL = process.env.WORKER_URL;
afterEach(() => {
  if (ORIGINAL_OLLAMA_URL === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = ORIGINAL_OLLAMA_URL;
  if (ORIGINAL_WORKER_URL === undefined) delete process.env.WORKER_URL;
  else process.env.WORKER_URL = ORIGINAL_WORKER_URL;
});

beforeEach(resetDb);

let seq = 0;

async function seedOrg() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: `AgentsOverviewOrg-${seq}` } });
  const disp = await prisma.dispatcher.create({
    data: { email: `ao-${seq}@x.com`, passwordHash: "x", name: "Dana Ops", orgId: org.id },
  });
  const token = signDispatcherAccess(disp.id);
  return { org, disp, token };
}

/** An AgentPolicy row, defaulted to the Standard thresholds — pass `over` to
 *  make it a distinct, non-Standard policy (a different `name` above all). */
function policyData(orgId: string, over: Partial<Record<string, unknown>> = {}) {
  return { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com", ...over };
}

async function seedStandard(orgId: string) {
  return prisma.agentPolicy.create({ data: policyData(orgId) });
}

async function seedLoad(orgId: string, over: Partial<Record<string, unknown>> = {}) {
  return prisma.load.create({ data: { orgId, requiredEquip: "DryVan", revenueCents: 10000, status: "open", ...over } });
}

async function createExperiment(orgId: string, name = "Experiment") {
  return prisma.aiExperiment.create({ data: { orgId, name, model: "qwen3:8b" } });
}

async function seedFinishedRun(orgId: string, experimentId: string, loadId: string, overrides: Record<string, unknown> = {}) {
  return prisma.aiDecisionRecord.create({
    data: {
      experimentId, orgId, loadId, kind: "dispatch_candidate",
      status: "proposed", terminationReason: "proposed",
      context: { loadRef: "L-FINISHED", requestedAt: new Date().toISOString() },
      toolCalls: [], toolResults: [],
      startedAt: new Date(),
      completedAt: new Date(),
      ...overrides,
    },
  });
}

describe("GET /api/dispatcher/agents/overview", () => {
  it("requires a dispatcher session", async () => {
    const res = await request(app).get("/api/dispatcher/agents/overview");
    expect(res.status).toBe(401);
  });

  it("unconfigured everything: rules available, model not configured, worker not configured, empty workload", async () => {
    delete process.env.OLLAMA_URL;
    delete process.env.WORKER_URL;
    const { token } = await seedOrg();

    const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.dispatch.rules).toEqual({ available: true });
    expect(res.body.dispatch.model).toEqual({ configured: false, reachable: null, modelPresent: null, model: null, error: null });
    expect(res.body.nightShift.service).toEqual({ configured: false, lastActivityAt: null });
    expect(res.body.nightShift.activity.total).toBe(0);
    expect(res.body.nightShift.enforcement).toEqual({ customerEmailOn: "not_enforced", quietHours: "not_enforced" });
    expect(res.body.nightShift.loads).toEqual([]);
  });

  it("configured worker with no loads is an empty workload, not an unavailable service", async () => {
    delete process.env.OLLAMA_URL;
    process.env.WORKER_URL = "http://127.0.0.1:3010";
    const { token } = await seedOrg();

    const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.nightShift.service.configured).toBe(true);
    expect(res.body.nightShift.loads).toEqual([]);
    expect(res.body.nightShift.activity.total).toBe(0);
  });

  it("model configured and reachable", async () => {
    process.env.OLLAMA_URL = "http://127.0.0.1:11434";
    const stub = vi.spyOn(ollamaAdapter, "checkOllama").mockResolvedValue({
      reachable: true, version: "0.34", models: ["qwen3:8b"], modelPresent: true, error: null,
    });
    const { token } = await seedOrg();

    const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.dispatch.model).toMatchObject({ configured: true, reachable: true, modelPresent: true, model: expect.any(String) });
    stub.mockRestore();
  });

  it("counts activity and mode per load using the shared summary, attention first", async () => {
    delete process.env.OLLAMA_URL;
    delete process.env.WORKER_URL;
    const { org, token } = await seedOrg();
    await seedStandard(org.id); // shadow: true — load A falls back to it.
    const livePolicy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Live", shadow: false }) });

    // Load A: shadow policy, pill "asked", an unanswered outbound message —
    // deriveAgentSummary reads this as waiting_reply/inferred.
    const loadA = await seedLoad(org.id, { agentEnabled: true, agentPill: "asked" });
    const tripA = await prisma.agentTrip.create({
      data: { id: `trip-${loadA.id}`, loadRef: "L-A", loadId: loadA.id, driverToken: `tok-${loadA.id}`, brief: {}, status: "tracking" },
    });
    await prisma.agentEvent.create({
      data: { tripId: tripA.id, atMs: BigInt(1000), kind: "anomaly", evidence: { kind: "unplanned_stop" }, actionTaken: "unplanned stop" },
    });
    await prisma.agentEvent.create({
      data: { tripId: tripA.id, atMs: BigInt(2000), kind: "action", evidence: { kind: "message" }, actionTaken: "asked the driver" },
    });

    // Load B: live policy, pill "attention", with an AgentUpdate attention
    // line — takes priority at the top of `loads`.
    const loadB = await seedLoad(org.id, { agentEnabled: true, agentPill: "attention", agentPolicyId: livePolicy.id });
    await prisma.agentUpdate.create({
      data: { loadId: loadB.id, atMs: BigInt(3000), kind: "attention", text: "ATTENTION — no driver or carrier phone on file" },
    });

    // Load C: switched off (pill "off") — still counted, but as "off".
    const loadC = await seedLoad(org.id, { agentEnabled: true, agentPill: "off" });

    const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.nightShift.activity).toMatchObject({ waitingReply: 1, attention: 1, off: 1, total: 3 });
    expect(res.body.nightShift.mode).toMatchObject({ shadowLoads: 1, liveLoads: 1, livePolicies: 1 });
    expect(res.body.nightShift.loads[0].loadId).toBe(loadB.id);
    expect(res.body.nightShift.loads).toHaveLength(3);
    expect(res.body.nightShift.loads.length).toBeLessThanOrEqual(25);
  });

  it("is tenant scoped: another org's loads and runs never appear", async () => {
    delete process.env.OLLAMA_URL;
    const { token } = await seedOrg();

    const otherOrg = await prisma.org.create({ data: { name: "Other Overview Org" } });
    await seedStandard(otherOrg.id);
    const foreignLoad = await seedLoad(otherOrg.id, { agentEnabled: true, agentPill: "asked" });
    const experiment = await createExperiment(otherOrg.id);
    await seedFinishedRun(otherOrg.id, experiment.id, foreignLoad.id);

    const res = await request(app).get("/api/dispatcher/agents/overview").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.nightShift.activity.total).toBe(0);
    expect(res.body.nightShift.loads).toEqual([]);
    expect(res.body.dispatch.activity.lastRun).toBeNull();
  });
});
