import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import {
  PROPOSE_DECISION_NAME,
  PROPOSE_DECISION_DEFINITION,
  validateProposal,
  type Proposal,
} from "../src/lib/aiHarness/decision.js";
import { DISPATCH_PROMPT_V1 } from "../src/lib/aiHarness/prompts/dispatch-v1.js";

// Qwen Harness v0.1, Task 4 — decision.ts: the terminal `propose_decision`
// contract a dispatch run ends on. Schema edge cases never touch the
// database (validateProposal returns on the first proposalSchema failure);
// the org/feasibility checks below seed real Driver rows because
// validateProposal's whole point is one real `findMany` against them. The
// prompt's own contract (dispatch-v1.ts) is tested at the bottom, since its
// `nudge` string references this same PROPOSE_DECISION_NAME.

beforeEach(resetDb);

function validProposal(overrides: Partial<Proposal> = {}): unknown {
  return {
    driverId: "driver-1",
    reason: "This driver is closest to the pickup and has full hours available.",
    confidence: 0.8,
    alternatives: [],
    ...overrides,
  };
}

describe("PROPOSE_DECISION_DEFINITION", () => {
  it("is named propose_decision and requires all four fields as an object schema", () => {
    expect(PROPOSE_DECISION_NAME).toBe("propose_decision");
    expect(PROPOSE_DECISION_DEFINITION.name).toBe(PROPOSE_DECISION_NAME);

    const params = PROPOSE_DECISION_DEFINITION.parameters as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["driverId", "reason", "confidence", "alternatives"]);
    expect(Object.keys(params.properties).sort()).toEqual(
      ["alternatives", "confidence", "driverId", "reason"].sort(),
    );
  });
});

describe("proposalSchema edge cases (via validateProposal; no DB row is ever reached)", () => {
  const ctx = { orgId: "org-x", feasibleDriverIds: new Set<string>() };

  it("rejects a reason under 20 characters", async () => {
    const result = await validateProposal(validProposal({ reason: "too short" }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("reason must be a string between 20 and 2000 characters");
  });

  it("rejects confidence above 1", async () => {
    const result = await validateProposal(validProposal({ confidence: 1.5 }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("confidence must be a number between 0 and 1");
  });

  it("rejects more than 3 alternatives", async () => {
    const alternatives = [1, 2, 3, 4].map((n) => ({
      driverId: `alt-${n}`,
      reason: "Backup option with open hours.",
    }));
    const result = await validateProposal(validProposal({ alternatives }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("alternatives must be an array of at most 3 entries");
  });

  it("rejects an alternative reason under 5 characters", async () => {
    const result = await validateProposal(
      validProposal({ alternatives: [{ driverId: "alt-1", reason: "hi" }] }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("each alternative's reason must be between 5 and 500 characters");
    }
  });

  it("rejects a non-object payload", async () => {
    const result = await validateProposal("not an object", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["the proposal must be a JSON object"]);
  });

  it("collects all errors together, not just the first, for a proposal with three problems", async () => {
    const result = await validateProposal(
      validProposal({ reason: "short", confidence: 5, alternatives: [{ driverId: "a", reason: "hi" }] }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "reason must be a string between 20 and 2000 characters",
          "confidence must be a number between 0 and 1",
          "each alternative's reason must be between 5 and 500 characters",
        ]),
      );
      expect(result.errors.length).toBe(3);
    }
  });
});

describe("validateProposal: org/feasibility checks against real Driver rows", () => {
  async function seed() {
    const orgA = await prisma.org.create({ data: { name: "Org A" } });
    const orgB = await prisma.org.create({ data: { name: "Org B" } });
    const feasible = await prisma.driver.create({
      data: { email: "feasible@a.com", passwordHash: "x", name: "Feasible Driver", orgId: orgA.id },
    });
    const notFeasible = await prisma.driver.create({
      data: { email: "notfeasible@a.com", passwordHash: "x", name: "Not Feasible Driver", orgId: orgA.id },
    });
    const otherOrgDriver = await prisma.driver.create({
      data: { email: "other@b.com", passwordHash: "x", name: "Other Org Driver", orgId: orgB.id },
    });
    const ctx = { orgId: orgA.id, feasibleDriverIds: new Set([feasible.id]) };
    return { orgA, orgB, feasible, notFeasible, otherOrgDriver, ctx };
  }

  it("accepts a valid proposal for a feasible driver", async () => {
    const { feasible, ctx } = await seed();
    const result = await validateProposal(validProposal({ driverId: feasible.id }), ctx);
    expect(result).toEqual({ ok: true, proposal: expect.objectContaining({ driverId: feasible.id }) });
  });

  it("rejects a driver from another org", async () => {
    const { otherOrgDriver, ctx } = await seed();
    const result = await validateProposal(validProposal({ driverId: otherOrgDriver.id }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(`driver ${otherOrgDriver.id} does not exist in this organization`);
    }
  });

  it("rejects a driver that exists in the org but was never among the feasible candidates", async () => {
    const { notFeasible, ctx } = await seed();
    const result = await validateProposal(validProposal({ driverId: notFeasible.id }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        `driver ${notFeasible.id} was not among the feasible candidates for this load — call findFeasibleDrivers and choose from its feasible rows`,
      );
    }
  });

  it("rejects duplicate alternative ids", async () => {
    const { feasible, ctx } = await seed();
    const result = await validateProposal(
      validProposal({
        driverId: feasible.id,
        alternatives: [
          { driverId: "dup-1", reason: "Also nearby and available." },
          { driverId: "dup-1", reason: "Also nearby and available." },
        ],
      }),
      { orgId: ctx.orgId, feasibleDriverIds: new Set([feasible.id, "dup-1"]) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("alternative driver dup-1 is listed more than once");
  });

  it("rejects an alternative equal to the main driverId", async () => {
    const { feasible, ctx } = await seed();
    const result = await validateProposal(
      validProposal({
        driverId: feasible.id,
        alternatives: [{ driverId: feasible.id, reason: "Same driver as the recommendation." }],
      }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        `alternative driver ${feasible.id} cannot be the same as the recommended driver`,
      );
    }
  });

  it("accepts driverId: null with a reason", async () => {
    const { ctx } = await seed();
    const result = await validateProposal(
      validProposal({
        driverId: null,
        reason: "No feasible driver is actually appropriate for this load right now.",
      }),
      ctx,
    );
    expect(result).toEqual({ ok: true, proposal: expect.objectContaining({ driverId: null }) });
  });

  it("returns every error together for a proposal with three separate problems", async () => {
    const { notFeasible, otherOrgDriver, ctx } = await seed();
    const result = await validateProposal(
      validProposal({
        driverId: notFeasible.id, // exists in the org, but not feasible
        alternatives: [
          { driverId: otherOrgDriver.id, reason: "From the wrong org entirely." },
          { driverId: otherOrgDriver.id, reason: "Listed a second time on purpose." }, // duplicate
        ],
      }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          `driver ${notFeasible.id} was not among the feasible candidates for this load — call findFeasibleDrivers and choose from its feasible rows`,
          `driver ${otherOrgDriver.id} does not exist in this organization`,
          `alternative driver ${otherOrgDriver.id} is listed more than once`,
        ]),
      );
      expect(result.errors.length).toBe(3);
    }
  });
});

describe("DISPATCH_PROMPT_V1", () => {
  const FORBIDDEN_WORDS = ["score", "rank", "ranking", "deterministic", "scenario", "expected", "engine"];

  it('version is "dispatch-v1"', () => {
    expect(DISPATCH_PROMPT_V1.version).toBe("dispatch-v1");
  });

  it("system never mentions scores, ranking, determinism, scenarios, or the engine", () => {
    const lower = DISPATCH_PROMPT_V1.system.toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      expect(lower).not.toContain(word);
    }
  });

  it("system stays well under ~350 words", () => {
    const words = DISPATCH_PROMPT_V1.system.trim().split(/\s+/);
    expect(words.length).toBeLessThan(350);
  });

  it("user(...) mentions both the loadId and the loadRef", () => {
    const text = DISPATCH_PROMPT_V1.user({ loadId: "load-123", loadRef: "L-456" });
    expect(text).toContain("load-123");
    expect(text).toContain("L-456");
  });

  it("nudge mentions propose_decision", () => {
    expect(DISPATCH_PROMPT_V1.nudge).toContain(PROPOSE_DECISION_NAME);
  });
});
