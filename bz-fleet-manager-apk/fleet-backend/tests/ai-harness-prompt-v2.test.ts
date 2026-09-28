import { describe, expect, it } from "vitest";
import { PROMPT_PROFILES, PROMPT_VERSIONS, resolvePromptProfile } from "../src/lib/aiHarness/prompts/index.js";
import { DISPATCH_PROMPT_V2, proposalV2Schema } from "../src/lib/aiHarness/prompts/dispatch-v2.js";

// dispatch-v2 A/B experiment, Task 1 — the prompt-profile registry and
// dispatch-v2's own terminal schema/text. Pure/DB-free: proposalV2Schema's
// edge cases are schema-shape only (no driver ids ever reach a `findMany`
// here); the full validate() flow (schema + DB + protocol together) is
// exercised by ai-harness-loop-v2.test.ts against a real seeded org instead.

function validProposal(overrides: Record<string, unknown> = {}) {
  return {
    driverId: "driver-1",
    reason: "This driver has the strongest overall evidence for this load.",
    confidence: 0.6,
    alternatives: [],
    comparison: [{ driverId: "driver-1", strengths: ["Available now"], weaknesses: [], unknowns: [] }],
    ...overrides,
  };
}

describe("prompt registry", () => {
  it("PROMPT_VERSIONS lists both dispatch-v1 and dispatch-v2", () => {
    expect(PROMPT_VERSIONS.sort()).toEqual(["dispatch-v1", "dispatch-v2"]);
    expect(Object.keys(PROMPT_PROFILES).sort()).toEqual(["dispatch-v1", "dispatch-v2"]);
  });

  it("resolvePromptProfile resolves both versions by their own version string", () => {
    const v1 = resolvePromptProfile("dispatch-v1");
    const v2 = resolvePromptProfile("dispatch-v2");
    expect(v1?.version).toBe("dispatch-v1");
    expect(v2?.version).toBe("dispatch-v2");
    expect(v1?.terminalDefinition.name).toBe("propose_decision");
    expect(v2?.terminalDefinition.name).toBe("propose_decision");
  });

  it("resolvePromptProfile returns null for an unknown version", () => {
    expect(resolvePromptProfile("dispatch-v3")).toBeNull();
    expect(resolvePromptProfile("")).toBeNull();
  });
});

describe("proposalV2Schema: comparison edge cases", () => {
  it("rejects a proposal missing comparison entirely", () => {
    const { comparison: _drop, ...rest } = validProposal();
    const result = proposalV2Schema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("accepts an empty comparison array at the schema level (checkProtocolV2 enforces the minimum, not the schema — see ai-harness-protocol.test.ts's zero-feasible cases)", () => {
    const result = proposalV2Schema.safeParse(validProposal({ comparison: [] }));
    expect(result.success).toBe(true);
  });

  it("rejects more than 6 comparison entries", () => {
    const comparison = Array.from({ length: 7 }, (_, i) => ({
      driverId: `d${i}`,
      strengths: [],
      weaknesses: [],
      unknowns: [],
    }));
    const result = proposalV2Schema.safeParse(validProposal({ comparison }));
    expect(result.success).toBe(false);
  });

  it("accepts up to 6 comparison entries", () => {
    const comparison = Array.from({ length: 6 }, (_, i) => ({
      driverId: `d${i}`,
      strengths: [`Evidence for driver ${i}`],
      weaknesses: [],
      unknowns: [],
    }));
    const result = proposalV2Schema.safeParse(validProposal({ driverId: "d0", comparison }));
    expect(result.success).toBe(true);
  });

  it("rejects a comparison string under 3 characters", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({ comparison: [{ driverId: "driver-1", strengths: ["hi"], weaknesses: [], unknowns: [] }] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a comparison string over 300 characters", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({
        comparison: [{ driverId: "driver-1", strengths: ["x".repeat(301)], weaknesses: [], unknowns: [] }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects more than 8 strengths on one entry", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({
        comparison: [
          { driverId: "driver-1", strengths: Array.from({ length: 9 }, (_, i) => `Reason number ${i}`), weaknesses: [], unknowns: [] },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts an entry whose weaknesses/unknowns are empty as long as one of the three arrays has an item", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({ comparison: [{ driverId: "driver-1", strengths: ["Available now"], weaknesses: [], unknowns: [] }] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a comparison entry whose strengths, weaknesses, and unknowns are ALL empty", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({ comparison: [{ driverId: "driver-1", strengths: [], weaknesses: [], unknowns: [] }] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("at least one item"))).toBe(true);
    }
  });

  it("rejects a comparison with a duplicate driverId", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({
        comparison: [
          { driverId: "driver-1", strengths: ["Close by"], weaknesses: [], unknowns: [] },
          { driverId: "driver-1", strengths: ["Also close"], weaknesses: [], unknowns: [] },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("more than once"))).toBe(true);
    }
  });

  it("rejects a comparison entry missing driverId", () => {
    const result = proposalV2Schema.safeParse(
      validProposal({ comparison: [{ strengths: [], weaknesses: [], unknowns: [] }] }),
    );
    expect(result.success).toBe(false);
  });

  it("still enforces v1's own field rules (reason length)", () => {
    const result = proposalV2Schema.safeParse(validProposal({ reason: "too short" }));
    expect(result.success).toBe(false);
  });
});

describe("DISPATCH_PROMPT_V2", () => {
  const FORBIDDEN_WORDS = ["score", "rank", "ranking", "deterministic", "scenario", "expected", "engine", "winner"];

  it('version is "dispatch-v2"', () => {
    expect(DISPATCH_PROMPT_V2.version).toBe("dispatch-v2");
  });

  it("system never mentions scores, ranking, determinism, scenarios, the engine, or a winner", () => {
    const lower = DISPATCH_PROMPT_V2.system.toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      expect(lower).not.toContain(word);
    }
  });

  it("system stays at or under 550 words", () => {
    const words = DISPATCH_PROMPT_V2.system.trim().split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(550);
  });

  it("system includes the confidence bands and the evidence-strength sentence verbatim", () => {
    expect(DISPATCH_PROMPT_V2.system).toContain(
      "Confidence measures evidence strength, not how certain you sound. Do not default to 0.95 or 1.0.",
    );
    expect(DISPATCH_PROMPT_V2.system).toContain("0.90–1.00 exceptionally strong evidence, very little relevant uncertainty");
    expect(DISPATCH_PROMPT_V2.system).toContain("0.70–0.89 strong recommendation with some uncertainty");
    expect(DISPATCH_PROMPT_V2.system).toContain("0.50–0.69 reasonable preference but meaningful uncertainty");
    expect(DISPATCH_PROMPT_V2.system).toContain("below 0.50 weak evidence or insufficient differentiation");
  });

  it("system names the comparison field and the investigation-count rule", () => {
    expect(DISPATCH_PROMPT_V2.system).toContain("comparison");
    expect(DISPATCH_PROMPT_V2.system).toContain("Investigate at least two feasible candidates");
    expect(DISPATCH_PROMPT_V2.system).toContain("findFeasibleDrivers");
  });

  it("system tells the model getDispatchCandidateDetails alone can cover most of one finalist's evidence", () => {
    expect(DISPATCH_PROMPT_V2.system).toContain(
      "getDispatchCandidateDetails returns most of this for one driver in a single call; use the other tools only for what it leaves unknown.",
    );
  });

  it("system names every investigation tool the brief requires", () => {
    for (const tool of [
      "getDispatchCandidateDetails",
      "getDriverAvailability",
      "getDriverMetrics",
      "getDriverHistory",
      "getDriver",
      "getDriverLocationHistory",
      "getCustomer",
      "getLoad",
    ]) {
      expect(DISPATCH_PROMPT_V2.system).toContain(tool);
    }
  });

  it("user(...) mentions both the loadId and the loadRef, and the process reminder", () => {
    const text = DISPATCH_PROMPT_V2.user({ loadId: "load-123", loadRef: "L-456" });
    expect(text).toContain("load-123");
    expect(text).toContain("L-456");
    expect(text).toContain("Follow the investigation and comparison process before proposing.");
  });

  it("nudge reminds of the investigation requirement and the terminal call", () => {
    expect(DISPATCH_PROMPT_V2.nudge.toLowerCase()).toContain("investigat");
    expect(DISPATCH_PROMPT_V2.nudge).toContain("propose_decision");
  });
});
