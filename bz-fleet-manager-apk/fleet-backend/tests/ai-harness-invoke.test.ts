import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { seedDispatchToolsFixture } from "./dispatch-tools-fixture.js";

// Qwen Harness v0.1, Task 2 — dispatchTools/invoke.ts: every one of the 17
// tools is invoked with the right positional arguments (mocked here so each
// assertion is independent of real data), plus the unknown-tool/invalid-
// params/tool-error codes and the manifest reshape for a model. getLoad is
// the one exception: its mock wraps the REAL implementation (via
// importOriginal) rather than replacing it, so the cross-org test further
// down exercises actual org-scoping through a real database row, the same
// discipline tests/dispatch-tools.test.ts already applies to getLoad itself.

vi.mock("../src/lib/dispatchTools/loads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dispatchTools/loads.js")>();
  return {
    ...actual,
    getLoad: vi.fn(actual.getLoad),
    searchLoads: vi.fn(actual.searchLoads),
    getUncoveredLoads: vi.fn(actual.getUncoveredLoads),
  };
});
vi.mock("../src/lib/dispatchTools/drivers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dispatchTools/drivers.js")>();
  return {
    ...actual,
    getDriver: vi.fn(actual.getDriver),
    searchDrivers: vi.fn(actual.searchDrivers),
    getAvailableDrivers: vi.fn(actual.getAvailableDrivers),
    getDriverAvailability: vi.fn(actual.getDriverAvailability),
    getDriverMetrics: vi.fn(actual.getDriverMetrics),
    getDriverHistory: vi.fn(actual.getDriverHistory),
    getDriverLocationHistory: vi.fn(actual.getDriverLocationHistory),
  };
});
vi.mock("../src/lib/dispatchTools/customers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dispatchTools/customers.js")>();
  return { ...actual, getCustomer: vi.fn(actual.getCustomer), getCustomerHistory: vi.fn(actual.getCustomerHistory) };
});
vi.mock("../src/lib/dispatchTools/eta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dispatchTools/eta.js")>();
  return { ...actual, getCurrentETA: vi.fn(actual.getCurrentETA) };
});
vi.mock("../src/lib/dispatchTools/events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dispatchTools/events.js")>();
  return { ...actual, getLoadEvents: vi.fn(actual.getLoadEvents), getAgentEvents: vi.fn(actual.getAgentEvents) };
});
vi.mock("../src/lib/dispatchTools/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dispatchTools/dispatch.js")>();
  return {
    ...actual,
    findFeasibleDrivers: vi.fn(actual.findFeasibleDrivers),
    getDispatchCandidateDetails: vi.fn(actual.getDispatchCandidateDetails),
  };
});

import { invokeTool, toolDefinitionsForModel, projectForModel } from "../src/lib/dispatchTools/invoke.js";
import { getLoad, searchLoads, getUncoveredLoads } from "../src/lib/dispatchTools/loads.js";
import {
  getDriver,
  searchDrivers,
  getAvailableDrivers,
  getDriverAvailability,
  getDriverMetrics,
  getDriverHistory,
  getDriverLocationHistory,
} from "../src/lib/dispatchTools/drivers.js";
import { getCustomer, getCustomerHistory } from "../src/lib/dispatchTools/customers.js";
import { getCurrentETA } from "../src/lib/dispatchTools/eta.js";
import { getLoadEvents, getAgentEvents } from "../src/lib/dispatchTools/events.js";
import { findFeasibleDrivers, getDispatchCandidateDetails } from "../src/lib/dispatchTools/dispatch.js";

const ORG = "org-1";

beforeEach(resetDb);
afterEach(() => {
  vi.clearAllMocks();
});

describe("invokeTool: positional call per tool", () => {
  it("getLoad(orgId, loadId)", async () => {
    vi.mocked(getLoad).mockResolvedValueOnce({ id: "load-1" } as any);
    const result = await invokeTool(ORG, "getLoad", { loadId: "load-1" });
    expect(getLoad).toHaveBeenCalledWith(ORG, "load-1");
    expect(result).toEqual({ ok: true, value: { id: "load-1" } });
  });

  it("searchLoads(orgId, params)", async () => {
    vi.mocked(searchLoads).mockResolvedValueOnce([{ id: "load-1" }] as any);
    const params = { status: "open", limit: 10 };
    const result = await invokeTool(ORG, "searchLoads", params);
    expect(searchLoads).toHaveBeenCalledWith(ORG, params);
    expect(result).toEqual({ ok: true, value: [{ id: "load-1" }] });
  });

  it("getUncoveredLoads(orgId)", async () => {
    vi.mocked(getUncoveredLoads).mockResolvedValueOnce([] as any);
    const result = await invokeTool(ORG, "getUncoveredLoads", {});
    expect(getUncoveredLoads).toHaveBeenCalledWith(ORG);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("getDriver(orgId, driverId)", async () => {
    vi.mocked(getDriver).mockResolvedValueOnce({ id: "d1" } as any);
    const result = await invokeTool(ORG, "getDriver", { driverId: "d1" });
    expect(getDriver).toHaveBeenCalledWith(ORG, "d1");
    expect(result).toEqual({ ok: true, value: { id: "d1" } });
  });

  it("searchDrivers(orgId, params)", async () => {
    vi.mocked(searchDrivers).mockResolvedValueOnce([{ id: "d1" }] as any);
    const params = { status: "AVAILABLE", limit: 5 };
    const result = await invokeTool(ORG, "searchDrivers", params);
    expect(searchDrivers).toHaveBeenCalledWith(ORG, params);
    expect(result).toEqual({ ok: true, value: [{ id: "d1" }] });
  });

  it("getAvailableDrivers(orgId)", async () => {
    vi.mocked(getAvailableDrivers).mockResolvedValueOnce([] as any);
    const result = await invokeTool(ORG, "getAvailableDrivers", {});
    expect(getAvailableDrivers).toHaveBeenCalledWith(ORG);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("getDriverAvailability(orgId, driverId)", async () => {
    vi.mocked(getDriverAvailability).mockResolvedValueOnce({ status: "AVAILABLE" } as any);
    const result = await invokeTool(ORG, "getDriverAvailability", { driverId: "d1" });
    expect(getDriverAvailability).toHaveBeenCalledWith(ORG, "d1");
    expect(result).toEqual({ ok: true, value: { status: "AVAILABLE" } });
  });

  it("getDriverMetrics(orgId, driverId)", async () => {
    vi.mocked(getDriverMetrics).mockResolvedValueOnce({ onTimeRate: 0.9 } as any);
    const result = await invokeTool(ORG, "getDriverMetrics", { driverId: "d1" });
    expect(getDriverMetrics).toHaveBeenCalledWith(ORG, "d1");
    expect(result).toEqual({ ok: true, value: { onTimeRate: 0.9 } });
  });

  it("getDriverHistory(orgId, driverId, limit)", async () => {
    vi.mocked(getDriverHistory).mockResolvedValueOnce([] as any);
    const result = await invokeTool(ORG, "getDriverHistory", { driverId: "d1", limit: 25 });
    expect(getDriverHistory).toHaveBeenCalledWith(ORG, "d1", 25);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("getDriverLocationHistory(orgId, driverId, sinceMs)", async () => {
    vi.mocked(getDriverLocationHistory).mockResolvedValueOnce([] as any);
    const result = await invokeTool(ORG, "getDriverLocationHistory", { driverId: "d1", sinceMs: 12345 });
    expect(getDriverLocationHistory).toHaveBeenCalledWith(ORG, "d1", 12345);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("getCustomer(orgId, customerId)", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce({ id: "c1" } as any);
    const result = await invokeTool(ORG, "getCustomer", { customerId: "c1" });
    expect(getCustomer).toHaveBeenCalledWith(ORG, "c1");
    expect(result).toEqual({ ok: true, value: { id: "c1" } });
  });

  it("getCustomerHistory(orgId, customerId)", async () => {
    vi.mocked(getCustomerHistory).mockResolvedValueOnce({ totalLoads: 3 } as any);
    const result = await invokeTool(ORG, "getCustomerHistory", { customerId: "c1" });
    expect(getCustomerHistory).toHaveBeenCalledWith(ORG, "c1");
    expect(result).toEqual({ ok: true, value: { totalLoads: 3 } });
  });

  it("getCurrentETA(orgId, loadId)", async () => {
    vi.mocked(getCurrentETA).mockResolvedValueOnce({ source: "none" } as any);
    const result = await invokeTool(ORG, "getCurrentETA", { loadId: "load-1" });
    expect(getCurrentETA).toHaveBeenCalledWith(ORG, "load-1");
    expect(result).toEqual({ ok: true, value: { source: "none" } });
  });

  it("getLoadEvents(orgId, loadId)", async () => {
    vi.mocked(getLoadEvents).mockResolvedValueOnce([] as any);
    const result = await invokeTool(ORG, "getLoadEvents", { loadId: "load-1" });
    expect(getLoadEvents).toHaveBeenCalledWith(ORG, "load-1");
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("getAgentEvents(orgId, loadId)", async () => {
    vi.mocked(getAgentEvents).mockResolvedValueOnce([] as any);
    const result = await invokeTool(ORG, "getAgentEvents", { loadId: "load-1" });
    expect(getAgentEvents).toHaveBeenCalledWith(ORG, "load-1");
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("findFeasibleDrivers(orgId, loadId) — the model gets the I2 compact projection, not the raw candidates array", async () => {
    vi.mocked(findFeasibleDrivers).mockResolvedValueOnce({
      loadId: "load-1",
      requiredEquip: "Reefer",
      tractorId: "t1",
      trailerId: "tr1",
      candidates: [],
    } as any);
    const result = await invokeTool(ORG, "findFeasibleDrivers", { loadId: "load-1" });
    expect(findFeasibleDrivers).toHaveBeenCalledWith(ORG, "load-1");
    expect(result).toEqual({
      ok: true,
      value: {
        loadId: "load-1",
        requiredEquip: "Reefer",
        note: null,
        counts: { feasible: 0, blocked: 0, shownFeasible: 0, shownBlocked: 0 },
        feasible: [],
        blocked: [],
      },
    });
  });

  it("getDispatchCandidateDetails(orgId, loadId, driverId)", async () => {
    vi.mocked(getDispatchCandidateDetails).mockResolvedValueOnce({ loadId: "load-1", driverId: "d1" } as any);
    const result = await invokeTool(ORG, "getDispatchCandidateDetails", { loadId: "load-1", driverId: "d1" });
    expect(getDispatchCandidateDetails).toHaveBeenCalledWith(ORG, "load-1", "d1");
    expect(result).toEqual({ ok: true, value: { loadId: "load-1", driverId: "d1" } });
  });
});

describe("invokeTool: error codes", () => {
  it('returns "unknown_tool" for a name the manifest does not have', async () => {
    const result = await invokeTool(ORG, "definitelyNotARealTool", {});
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("definitelyNotARealTool"),
      code: "unknown_tool",
    });
  });

  it('returns "invalid_params" naming a missing required field', async () => {
    const result = await invokeTool(ORG, "getLoad", {});
    expect(result).toEqual({ ok: false, error: expect.stringContaining("loadId"), code: "invalid_params" });
  });

  it('returns "invalid_params" naming a wrong-type field', async () => {
    const result = await invokeTool(ORG, "getDriverLocationHistory", { driverId: "d1", sinceMs: "not-a-number" });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("sinceMs"), code: "invalid_params" });
  });

  it('a thrown tool error becomes "tool_error" with the error\'s message and no stack', async () => {
    const boom = new Error("driver lookup exploded");
    vi.mocked(getDriver).mockRejectedValueOnce(boom);
    const result = await invokeTool(ORG, "getDriver", { driverId: "d1" });
    expect(result).toEqual({ ok: false, error: "driver lookup exploded", code: "tool_error" });
  });

  it("a cross-org load id through the real (unmocked) getLoad returns { ok: true, value: null }", async () => {
    const { orgA, lB1 } = await seedDispatchToolsFixture();
    const result = await invokeTool(orgA.id, "getLoad", { loadId: lB1.id });
    expect(result).toEqual({ ok: true, value: null });
  });
});

// C1: the seeded demo world keeps its scenario answer key at
// `Load.extras.scenario`, and `hint` names the expected driver — a model
// reasoning from that instead of its own tool calls defeats the whole point
// of running one. Real (unmocked) getLoad/searchLoads/getUncoveredLoads,
// exactly like the cross-org test above, so this exercises the actual
// production code path end to end rather than a hand-built double.
describe("invokeTool: C1 — scenario hints never reach the model", () => {
  const SCENARIO = { code: "B", title: "Closer driver, spotty history", hint: "Milan Petrovski is nearby but has 3 unanswered check-ins." };

  it("getLoad's projected result has no extras key and no trace of the hint text", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    await prisma.load.update({ where: { id: l1.id }, data: { extras: { scenario: SCENARIO } } });

    const result = await invokeTool(orgA.id, "getLoad", { loadId: l1.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("extras");
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("scenario");
    expect(serialized).not.toContain("hint");
    expect(serialized).not.toContain("Petrovski");
  });

  it("searchLoads' projected results have no extras key on any row", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    await prisma.load.update({ where: { id: l1.id }, data: { extras: { scenario: SCENARIO } } });

    const result = await invokeTool(orgA.id, "searchLoads", { status: "open" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.value as Record<string, unknown>[];
    expect(rows.some((r) => r.id === l1.id)).toBe(true);
    for (const row of rows) expect(row).not.toHaveProperty("extras");
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("scenario");
    expect(serialized).not.toContain("Petrovski");
  });

  it("getUncoveredLoads' projected results have no extras key on any row", async () => {
    const { orgA, l1 } = await seedDispatchToolsFixture();
    await prisma.load.update({ where: { id: l1.id }, data: { extras: { scenario: SCENARIO } } });

    const result = await invokeTool(orgA.id, "getUncoveredLoads", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.value as Record<string, unknown>[];
    expect(rows.some((r) => r.id === l1.id)).toBe(true);
    for (const row of rows) expect(row).not.toHaveProperty("extras");
    expect(JSON.stringify(rows)).not.toContain("scenario");
  });

  it("projectForModel leaves a value with no extras field untouched in shape (deep clone, not identity)", () => {
    const value = { id: "d1", nested: { still: "here" } };
    expect(projectForModel("getDriver", value)).toEqual(value);
  });

  it("projectForModel strips extras nested under a load/loads field of another tool's result", () => {
    const value = { loadId: "l1", driverId: "d1", load: { id: "l1", extras: { scenario: SCENARIO } } };
    const projected = projectForModel("getDispatchCandidateDetails", value) as Record<string, unknown>;
    expect((projected.load as Record<string, unknown>)).not.toHaveProperty("extras");

    const arrayValue = { loads: [{ id: "l1", extras: { scenario: SCENARIO } }, { id: "l2" }] };
    const projectedArray = projectForModel("searchLoads", arrayValue) as { loads: Record<string, unknown>[] };
    for (const row of projectedArray.loads) expect(row).not.toHaveProperty("extras");
  });

  it("never mistakes a Date for a plain object to walk into (would otherwise turn it into {})", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const projected = projectForModel("getLoad", { id: "l1", createdAt, extras: { scenario: SCENARIO } }) as { createdAt: Date };
    expect(projected.createdAt).toBeInstanceOf(Date);
    expect(projected.createdAt.toISOString()).toBe(createdAt.toISOString());
  });
});

// I2: the raw findFeasibleDrivers result for a large fleet costs ~1.6 KB per
// driver (263 KB for 165 drivers, per the review); the compact projection
// must shrink that dramatically regardless of how many rows exist, while
// still surfacing everything a dispatch decision actually weighs, and (round
// 2) still fit inside serializeToolResult's own 8192-byte per-result cap so
// the model never sees a truncated wrapper around it.
describe("invokeTool: I2 — findFeasibleDrivers compact projection", () => {
  function syntheticCandidate(i: number, feasible: boolean) {
    const id = `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;
    return {
      driverId: id,
      driverName: `Driver ${i}`,
      feasible,
      score: feasible ? 0.5 : null,
      deadheadMi: 123.456789,
      loadedMi: 400,
      etaMs: 1_700_000_000_000 + i,
      marginCents: 50000,
      marginPct: 0.3,
      blockedReason: feasible ? undefined : "driver is off_duty",
      warnings: [],
      hosKnown: true,
      context: feasible
        ? { availability: { status: "AVAILABLE" }, laneRuns: 3, onTimeRate: 0.912345, responseRate: 0.6 }
        : undefined,
    };
  }

  it("caps feasible at 20 rows and blocked at 15, in engine order, with honest counts", async () => {
    const candidates = [
      ...Array.from({ length: 90 }, (_, i) => syntheticCandidate(i, true)),
      ...Array.from({ length: 75 }, (_, i) => syntheticCandidate(90 + i, false)),
    ];
    vi.mocked(findFeasibleDrivers).mockResolvedValueOnce({
      loadId: "load-1", requiredEquip: "Reefer", tractorId: "t1", trailerId: "tr1", candidates,
    } as any);

    const result = await invokeTool(ORG, "findFeasibleDrivers", { loadId: "load-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      feasible: { driverId: string }[];
      blocked: { driverId: string }[];
      counts: { feasible: number; blocked: number; shownFeasible: number; shownBlocked: number };
    };
    expect(value.feasible).toHaveLength(20);
    expect(value.blocked).toHaveLength(15);
    expect(value.counts).toEqual({ feasible: 90, blocked: 75, shownFeasible: 20, shownBlocked: 15 });
    // Engine order preserved (never re-sorted): the first N feasible/blocked
    // ids are candidates[0..N-1] of their own kind, not some other subset.
    expect(value.feasible.map((r) => r.driverId)).toEqual(candidates.slice(0, 20).map((c) => c.driverId));
    expect(value.blocked.map((r) => r.driverId)).toEqual(candidates.slice(90, 105).map((c) => c.driverId));
  });

  it("never carries marginCents/etaMs on a feasible row (round 2: dropped to make the byte budget)", async () => {
    vi.mocked(findFeasibleDrivers).mockResolvedValueOnce({
      loadId: "load-1", requiredEquip: "Reefer", tractorId: "t1", trailerId: "tr1",
      candidates: [syntheticCandidate(0, true)],
    } as any);
    const result = await invokeTool(ORG, "findFeasibleDrivers", { loadId: "load-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (result.value as { feasible: Record<string, unknown>[] }).feasible[0]!;
    expect(row).not.toHaveProperty("marginCents");
    expect(row).not.toHaveProperty("etaMs");
    expect(row).toMatchObject({ driverId: syntheticCandidate(0, true).driverId, score: 0.5 });
  });

  // Round 2: the coordinator's own stress parameters — real 36-char driver
  // ids (Driver.id is `@default(uuid())`), real 24-char names, and a
  // realistic long `blockedReason` on every one of the 15 shown blocked rows
  // (not the short common case) — the genuine worst case for this cap, not
  // an average one.
  function realisticCandidate(i: number, feasible: boolean) {
    const uuid = `1${String(i).padStart(7, "0")}-2222-4333-8444-${String(i).padStart(12, "0")}`;
    const name = `Driver Longname ${i}`.padEnd(24, " ").slice(0, 24);
    const longestBlockedReason = "30-min break falls near Chicago, IL with no rest option within 50 mi";
    return {
      driverId: uuid,
      driverName: name,
      feasible,
      score: feasible ? 0.876543 : null,
      deadheadMi: 154.789321,
      loadedMi: 400,
      etaMs: 1_700_000_000_000 + i,
      marginCents: 123456,
      marginPct: 0.3,
      blockedReason: feasible ? undefined : longestBlockedReason,
      warnings: [],
      hosKnown: true,
      context: feasible
        ? { availability: { status: "AVAILABLE_SOON" }, laneRuns: 12, onTimeRate: 0.912345, responseRate: 0.612345 }
        : undefined,
    };
  }

  it("stays under the 8192-byte per-result cap at the worst realistic case (165 drivers, real-length ids/names/reasons)", async () => {
    const candidates = [
      ...Array.from({ length: 90 }, (_, i) => realisticCandidate(i, true)),
      ...Array.from({ length: 75 }, (_, i) => realisticCandidate(90 + i, false)),
    ];
    vi.mocked(findFeasibleDrivers).mockResolvedValueOnce({
      loadId: "11111111-2222-4333-8444-999999999999", requiredEquip: "Reefer", tractorId: "t1", trailerId: "tr1", candidates,
    } as any);
    const result = await invokeTool(ORG, "findFeasibleDrivers", { loadId: "load-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projectedBytes = Buffer.byteLength(JSON.stringify(result.value), "utf8");

    // The review's own persisted runs measured 261,948-265,362 bytes raw for
    // a real 165-driver org — the compact shape stays roughly two orders of
    // magnitude smaller. The load-bearing assertion is the second one:
    // strictly under serializeToolResult's own 8192-byte per-result cap, so
    // the model is never handed a truncated wrapper around this result.
    expect(projectedBytes).toBeLessThan(261_948 / 10);
    expect(projectedBytes).toBeLessThan(8192);
  });

  it("rounds float fields so a floating-point artifact never inflates the wire size", async () => {
    vi.mocked(findFeasibleDrivers).mockResolvedValueOnce({
      loadId: "load-1", requiredEquip: "Reefer", tractorId: "t1", trailerId: "tr1",
      candidates: [syntheticCandidate(0, true)],
    } as any);
    const result = await invokeTool(ORG, "findFeasibleDrivers", { loadId: "load-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (result.value as { feasible: { deadheadMi: number; onTimeRate: number | null }[] }).feasible[0]!;
    expect(row.deadheadMi).toBe(123.46);
    expect(row.onTimeRate).toBe(0.91);
  });
});

describe("toolDefinitionsForModel", () => {
  it("returns all 17 tools as object-typed JSON-schema definitions", () => {
    const defs = toolDefinitionsForModel();
    expect(defs).toHaveLength(17);
    for (const def of defs) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters).toMatchObject({ type: "object" });
    }
  });
});
