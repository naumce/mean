import { describe, expect, it } from "vitest";
import {
  checkProtocolV2,
  investigationsFromSteps,
  isCandidateInvestigated,
  type ProtocolContext,
} from "../src/lib/aiHarness/protocol.js";
import type { ProposalV2 } from "../src/lib/aiHarness/prompts/dispatch-v2.js";
import type { StoredStep } from "../src/lib/aiHarness/runStore.js";

// dispatch-v2 A/B experiment, Task 1 — protocol.ts's own two pure functions:
// investigationsFromSteps (which feasible candidates a run's tool calls
// actually investigated) and checkProtocolV2 (the comparison/confidence
// rules dispatch-v2's terminal contract enforces from that). Both are pure
// and DB-free, so every case here is a synthetic step list — no seeded org,
// no resetDb.

const LOAD_ID = "load-1";

function toolCall(seq: number, name: string, args: Record<string, unknown>): StoredStep {
  return { seq, kind: "tool_call", name, payload: { name, arguments: args }, atMs: seq, durationMs: null };
}

function toolResult(seq: number, name: string, ok: boolean): StoredStep {
  return { seq, kind: "tool_result", name, payload: { name, ok }, atMs: seq, durationMs: null };
}

function candidateDetails(seq: number, driverId: string, loadId: string = LOAD_ID, ok = true): StoredStep[] {
  return [toolCall(seq, "getDispatchCandidateDetails", { loadId, driverId }), toolResult(seq + 1, "getDispatchCandidateDetails", ok)];
}

function availabilityCall(seq: number, driverId: string, ok = true): StoredStep[] {
  return [toolCall(seq, "getDriverAvailability", { driverId }), toolResult(seq + 1, "getDriverAvailability", ok)];
}

function metricsCall(seq: number, driverId: string, ok = true): StoredStep[] {
  return [toolCall(seq, "getDriverMetrics", { driverId }), toolResult(seq + 1, "getDriverMetrics", ok)];
}

function driverCall(seq: number, driverId: string, ok = true): StoredStep[] {
  return [toolCall(seq, "getDriver", { driverId }), toolResult(seq + 1, "getDriver", ok)];
}

describe("investigationsFromSteps", () => {
  it("getDispatchCandidateDetails alone qualifies a driver as investigated", () => {
    const steps = candidateDetails(1, "d1");
    const investigations = investigationsFromSteps(steps, LOAD_ID);
    const investigation = investigations.get("d1");
    expect(investigation).toBeDefined();
    expect(isCandidateInvestigated(investigation!.covers)).toBe(true);
  });

  it("getDriverAvailability + getDriverMetrics together qualify", () => {
    const steps = [...availabilityCall(1, "d1"), ...metricsCall(3, "d1")];
    const investigation = investigationsFromSteps(steps, LOAD_ID).get("d1");
    expect(investigation).toBeDefined();
    expect(isCandidateInvestigated(investigation!.covers)).toBe(true);
  });

  it("getDriver + getDriverAvailability + getDriverMetrics together qualify", () => {
    const steps = [...driverCall(1, "d1"), ...availabilityCall(3, "d1"), ...metricsCall(5, "d1")];
    const investigation = investigationsFromSteps(steps, LOAD_ID).get("d1");
    expect(investigation).toBeDefined();
    expect(isCandidateInvestigated(investigation!.covers)).toBe(true);
    expect(investigation!.tools.sort()).toEqual(["getDriver", "getDriverAvailability", "getDriverMetrics"]);
  });

  it("getDriverMetrics alone does not qualify (no availability evidence)", () => {
    const steps = metricsCall(1, "d1");
    const investigation = investigationsFromSteps(steps, LOAD_ID).get("d1");
    expect(investigation).toBeDefined(); // metrics coverage is still recorded...
    expect(isCandidateInvestigated(investigation!.covers)).toBe(false); // ...but does not qualify on its own
  });

  it("a failed tool_result does not count", () => {
    const steps = candidateDetails(1, "d1", LOAD_ID, false);
    const investigations = investigationsFromSteps(steps, LOAD_ID);
    expect(investigations.get("d1")).toBeUndefined();
  });

  it("a getDispatchCandidateDetails call for ANOTHER load does not count", () => {
    const steps = candidateDetails(1, "d1", "some-other-load");
    const investigations = investigationsFromSteps(steps, LOAD_ID);
    expect(investigations.get("d1")).toBeUndefined();
  });
});

function ctxWith(overrides: Partial<ProtocolContext>): ProtocolContext {
  return {
    orgId: "org-1",
    loadId: LOAD_ID,
    feasibleDriverIds: new Set(),
    steps: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposalV2> = {}): ProposalV2 {
  return {
    driverId: null,
    reason: "This recommendation rests on the evidence retrieved from the tools above.",
    confidence: 0.6,
    alternatives: [],
    comparison: [],
    ...overrides,
  };
}

function comparisonEntry(driverId: string, unknowns: string[] = []): ProposalV2["comparison"][number] {
  return { driverId, strengths: [], weaknesses: [], unknowns };
}

describe("checkProtocolV2", () => {
  it("1 of 2 feasible investigated: one error naming the investigated driver, the count, and a concrete next call", () => {
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps: candidateDetails(1, "d1") });
    const errors = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d1")] }), ctx);

    const investigationError = errors.find((e) => e.includes("investigated 1 feasible candidate"));
    expect(investigationError).toBeDefined();
    expect(investigationError).toContain("d1");
    expect(investigationError).toContain("d2");
    expect(investigationError).toContain("getDispatchCandidateDetails");
  });

  it("chosen driver absent from comparison", () => {
    const steps = [...candidateDetails(1, "d1"), ...candidateDetails(3, "d2")];
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps });
    const errors = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d2")] }), ctx);

    expect(errors.some((e) => e.includes("d1") && e.includes("must have its own entry"))).toBe(true);
  });

  it("comparison entry for a non-feasible driver", () => {
    const steps = [...candidateDetails(1, "d1"), ...candidateDetails(3, "d2")];
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps });
    const errors = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d1"), comparisonEntry("d3")] }), ctx);

    expect(errors.some((e) => e.includes("d3") && e.includes("not a feasible candidate"))).toBe(true);
  });

  it("comparison entry for an uninvestigated driver", () => {
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps: candidateDetails(1, "d1") });
    const errors = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d1"), comparisonEntry("d2")] }), ctx);

    expect(errors.some((e) => e.includes("d2") && e.includes("has not been investigated yet"))).toBe(true);
  });

  it("confidence 0.95 with unknowns on the chosen entry", () => {
    const steps = [...candidateDetails(1, "d1"), ...candidateDetails(3, "d2")];
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps });
    const errors = checkProtocolV2(
      proposal({
        driverId: "d1",
        confidence: 0.95,
        comparison: [comparisonEntry("d1", ["Home terminal proximity is unclear"]), comparisonEntry("d2")],
      }),
      ctx,
    );

    expect(errors.some((e) => e.includes("0.90+"))).toBe(true);
  });

  it("confidence 0.80 with 3 unknowns on the chosen entry", () => {
    const steps = [...candidateDetails(1, "d1"), ...candidateDetails(3, "d2")];
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps });
    const errors = checkProtocolV2(
      proposal({
        driverId: "d1",
        confidence: 0.8,
        comparison: [comparisonEntry("d1", ["Unknown A", "Unknown B", "Unknown C"]), comparisonEntry("d2")],
      }),
      ctx,
    );

    expect(errors.some((e) => e.includes("0.70+"))).toBe(true);
    expect(errors.some((e) => e.includes("0.90+"))).toBe(false);
  });

  it("a single feasible candidate: one investigation suffices and a one-entry comparison passes", () => {
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1"]), steps: candidateDetails(1, "d1") });
    const errors = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d1")] }), ctx);

    expect(errors).toEqual([]);
  });

  it("driverId: null with a comparison passes when >= 2 feasible candidates are investigated", () => {
    const steps = [...candidateDetails(1, "d1"), ...candidateDetails(3, "d2")];
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps });
    const errors = checkProtocolV2(
      proposal({ driverId: null, comparison: [comparisonEntry("d1"), comparisonEntry("d2")] }),
      ctx,
    );

    expect(errors).toEqual([]);
  });

  it("resolves driver names for the investigated list when given a driverNames map, falling back to ids otherwise", () => {
    // The actionable "next call" ids (protocol.ts's own next-call ids) stay raw
    // id either way, matching the brief's own template ("for driver <id>
    // call ...") — the model must call the tool with a real id, not a name.
    // Only the descriptive "you have investigated" list gets friendlier names.
    const ctx = ctxWith({ feasibleDriverIds: new Set(["d1", "d2"]), steps: candidateDetails(1, "d1") });
    const withNames = checkProtocolV2(
      proposal({ driverId: "d1", comparison: [comparisonEntry("d1")] }),
      ctx,
      new Map([["d1", "First Driver"]]),
    );
    expect(withNames.some((e) => e.includes("First Driver"))).toBe(true);

    const withoutNames = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d1")] }), ctx);
    expect(withoutNames.some((e) => e.includes("First Driver"))).toBe(false);
    expect(withoutNames.some((e) => e.includes("(d1)"))).toBe(true);
  });

  describe("zero feasible candidates", () => {
    it("driverId null with an empty comparison validates", () => {
      const ctx = ctxWith({ feasibleDriverIds: new Set(), steps: [] });
      const errors = checkProtocolV2(proposal({ driverId: null, comparison: [] }), ctx);
      expect(errors).toEqual([]);
    });

    it("proposing a driver is rejected with a message saying no feasible candidate exists", () => {
      const ctx = ctxWith({ feasibleDriverIds: new Set(), steps: [] });
      const errors = checkProtocolV2(proposal({ driverId: "d1", comparison: [comparisonEntry("d1")] }), ctx);
      expect(errors.some((e) => e.includes("no feasible candidate exists"))).toBe(true);
    });

    it("a non-empty comparison is rejected even when driverId is null", () => {
      const ctx = ctxWith({ feasibleDriverIds: new Set(), steps: [] });
      const errors = checkProtocolV2(proposal({ driverId: null, comparison: [comparisonEntry("d1")] }), ctx);
      expect(errors.some((e) => e.includes("no feasible candidate exists") && e.includes("comparison must be empty"))).toBe(true);
    });
  });

  describe("the next-call naming never steers toward engine order", () => {
    it("with an engine-ranked feasible set and nothing investigated, the next-call ids are sorted by id — the engine's own top is never named first unless the proposal itself named it", () => {
      // feasibleDriverIds preserves insertion order, i.e. the deterministic
      // baseline's own ranking — "top" is deliberately first here, the way a
      // real baseline.ts feasible set would put its top-ranked driver first.
      const ctx = ctxWith({ feasibleDriverIds: new Set(["top", "b", "c"]), steps: [] });
      const errors = checkProtocolV2(proposal({ driverId: null, comparison: [] }), ctx);

      const investigationError = errors.find((e) => e.includes("Investigate at least one"));
      expect(investigationError).toBeDefined();
      const nextCallText = investigationError!.split(" — for ")[1] ?? "";
      expect(nextCallText.startsWith("one of: b, c, top")).toBe(true);
      expect(nextCallText).toContain("b");
      expect(nextCallText).toContain("c");
    });

    it("prefers an uninvestigated feasible id the proposal itself already named (alternatives), even if that id is the engine's own top", () => {
      const ctx = ctxWith({ feasibleDriverIds: new Set(["top", "b", "c"]), steps: [] });
      const errors = checkProtocolV2(
        proposal({
          driverId: null,
          alternatives: [{ driverId: "top", reason: "Worth a look based on early signals." }],
          comparison: [],
        }),
        ctx,
      );

      const investigationError = errors.find((e) => e.includes("Investigate at least one"));
      expect(investigationError).toBeDefined();
      expect(investigationError).toContain("driver top");
    });
  });
});
