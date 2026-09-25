import { resetDb } from "./helpers.js";
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

import { invokeTool, toolDefinitionsForModel } from "../src/lib/dispatchTools/invoke.js";
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

  it("findFeasibleDrivers(orgId, loadId)", async () => {
    vi.mocked(findFeasibleDrivers).mockResolvedValueOnce({ loadId: "load-1", candidates: [] } as any);
    const result = await invokeTool(ORG, "findFeasibleDrivers", { loadId: "load-1" });
    expect(findFeasibleDrivers).toHaveBeenCalledWith(ORG, "load-1");
    expect(result).toEqual({ ok: true, value: { loadId: "load-1", candidates: [] } });
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
