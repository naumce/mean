import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";

// Qwen Harness v0.1, Task 1 — schema-only tests for the experiment config
// columns, the AiDecisionRecord run-lifecycle columns, and the new AiRunStep
// transcript table. No harness or routes exist yet; these pin the Prisma
// layer the later tasks build on.

beforeEach(resetDb);

async function createExperiment(orgId: string) {
  return prisma.aiExperiment.create({
    data: { orgId, name: "Run 1", model: "qwen3:8b" },
  });
}

async function createDecision(experimentId: string, orgId: string) {
  return prisma.aiDecisionRecord.create({
    data: { experimentId, orgId, kind: "dispatch_candidate", context: {}, toolCalls: [], toolResults: [] },
  });
}

describe("Qwen Harness schema (Task 1)", () => {
  it("deleting an AiDecisionRecord cascades to its AiRunStep rows", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const experiment = await createExperiment(org.id);
    const decision = await createDecision(experiment.id, org.id);

    await prisma.aiRunStep.create({
      data: { decisionId: decision.id, seq: 0, kind: "system", payload: {}, atMs: BigInt(Date.now()) },
    });
    await prisma.aiRunStep.create({
      data: { decisionId: decision.id, seq: 1, kind: "assistant", payload: {}, atMs: BigInt(Date.now()) },
    });
    expect(await prisma.aiRunStep.count({ where: { decisionId: decision.id } })).toBe(2);

    await prisma.aiDecisionRecord.delete({ where: { id: decision.id } });

    expect(await prisma.aiRunStep.count({ where: { decisionId: decision.id } })).toBe(0);
  });

  it("rejects two steps on the same decision with the same seq", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const experiment = await createExperiment(org.id);
    const decision = await createDecision(experiment.id, org.id);

    await prisma.aiRunStep.create({
      data: { decisionId: decision.id, seq: 0, kind: "system", payload: {}, atMs: BigInt(Date.now()) },
    });

    await expect(
      prisma.aiRunStep.create({
        data: { decisionId: decision.id, seq: 0, kind: "user", payload: {}, atMs: BigInt(Date.now()) },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it('a fresh AiDecisionRecord defaults to status "queued"', async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const experiment = await createExperiment(org.id);
    const decision = await createDecision(experiment.id, org.id);

    expect(decision.status).toBe("queued");
  });

  it("a fresh AiExperiment defaults status, promptVersion and config", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const experiment = await createExperiment(org.id);

    expect(experiment.status).toBe("active");
    expect(experiment.promptVersion).toBe("dispatch-v1");
    expect(experiment.config).toEqual({});
  });

  it("an experiment's config JSON round-trips", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const config = { model: "qwen3:8b", think: true, temperature: 0.2, numCtx: 16384, maxTurns: 12 };
    const experiment = await prisma.aiExperiment.create({
      data: { orgId: org.id, name: "Run 1", model: "qwen3:8b", config },
    });

    const reread = await prisma.aiExperiment.findUniqueOrThrow({ where: { id: experiment.id } });
    expect(reread.config).toEqual(config);
  });
});
