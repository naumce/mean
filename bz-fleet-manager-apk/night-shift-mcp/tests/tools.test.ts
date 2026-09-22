import { beforeEach, describe, expect, it, vi } from "vitest";
import { NightShiftClient } from "../src/client.js";
import { createTools } from "../src/tools.js";

// Task 5 / spec §14: "each tool calls exactly one route with the org's key;
// no tool can set shadow: false". Mocked at global fetch (not the client),
// so these tests exercise the real NightShiftClient too — the same
// discipline the backend suite uses for its own HTTP-boundary tests.

const BASE = "https://ns.example.com/api";
const KEY = "ns_live_test-key";

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function client() {
  return new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
}

function calls() {
  return fetchMock.mock.calls as [string, RequestInit][];
}

function expectApiKeyHeader() {
  for (const [, init] of calls()) {
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
  }
}

describe("list_watched_loads", () => {
  it("makes exactly one GET call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ loads: [] }));
    const tools = createTools(client());
    const result = await tools.list_watched_loads.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls()[0][0]).toBe(`${BASE}/dispatcher/night-shift/loads`);
    expect(calls()[0][1].method).toBe("GET");
    expect(result).toEqual({ loads: [] });
    expectApiKeyHeader();
  });
});

describe("load_status", () => {
  it("resolves loadRef then GETs the load's agent status — two calls", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ enabled: true, pill: "watching" }));
    const tools = createTools(client());
    const result = await tools.load_status.handler({ loadRef: "L100" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls()[0][0]).toBe(`${BASE}/dispatcher/loads/lookup?ref=L100`);
    expect(calls()[0][1].method).toBe("GET");
    expect(calls()[1][0]).toBe(`${BASE}/dispatcher/loads/load-1/agent`);
    expect(calls()[1][1].method).toBe("GET");
    expect(result).toEqual({ enabled: true, pill: "watching" });
  });
});

describe("watch_load", () => {
  it("with no policy: resolves the load and POSTs enabled:true, no policyId", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1", agentEnabled: true }, version: 1 }));
    const tools = createTools(client());
    await tools.watch_load.handler({ loadRef: "L100" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls()[1][0]).toBe(`${BASE}/dispatcher/loads/load-1/agent`);
    expect(calls()[1][1].method).toBe("POST");
    expect(JSON.parse(calls()[1][1].body as string)).toEqual({ enabled: true });
  });

  it("with a policy name: resolves the load, resolves the policy id, then POSTs — three calls", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ policies: [{ id: "pol-1", name: "Aggressive" }, { id: "pol-2", name: "Standard" }] }))
      .mockResolvedValueOnce(jsonResponse({ load: {}, version: 1 }));
    const tools = createTools(client());
    await tools.watch_load.handler({ loadRef: "L100", policy: "Aggressive" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calls()[1][0]).toBe(`${BASE}/dispatcher/night-shift/policies`);
    expect(calls()[2][0]).toBe(`${BASE}/dispatcher/loads/load-1/agent`);
    expect(JSON.parse(calls()[2][1].body as string)).toEqual({ enabled: true, policyId: "pol-1" });
  });

  it("rejects a policy name that does not exist, without ever POSTing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ policies: [{ id: "pol-2", name: "Standard" }] }));
    const tools = createTools(client());
    await expect(tools.watch_load.handler({ loadRef: "L100", policy: "Ghost" })).rejects.toThrow(/No policy named/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe.each([
  ["stop", "stop", undefined],
  ["call_now", "call", undefined],
  ["takeover", "takeover", undefined],
  ["handback", "handback", undefined],
])("%s", (toolName, kind) => {
  it(`resolves the load then POSTs { kind: "${kind}" } to the commands route`, async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ command: { id: "cmd-1", kind } }));
    const tools = createTools(client());
    await tools[toolName].handler({ loadRef: "L100" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls()[1][0]).toBe(`${BASE}/dispatcher/loads/load-1/agent/commands`);
    expect(calls()[1][1].method).toBe("POST");
    expect(JSON.parse(calls()[1][1].body as string)).toEqual({ kind });
  });
});

describe("reply", () => {
  it("POSTs kind reply with the text payload", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ command: { id: "cmd-1" } }));
    const tools = createTools(client());
    await tools.reply.handler({ loadRef: "L100", text: "on the way" });
    expect(JSON.parse(calls()[1][1].body as string)).toEqual({ kind: "reply", payload: { text: "on the way" } });
  });
});

describe("correct", () => {
  it("POSTs kind correct with the key payload", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ load: { id: "load-1" } }))
      .mockResolvedValueOnce(jsonResponse({ command: { id: "cmd-1" } }));
    const tools = createTools(client());
    await tools.correct.handler({ loadRef: "L100", key: "delayed" });
    expect(JSON.parse(calls()[1][1].body as string)).toEqual({ kind: "correct", payload: { key: "delayed" } });
  });
});

describe("list_policies", () => {
  it("makes exactly one GET call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ policies: [] }));
    const tools = createTools(client());
    await tools.list_policies.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls()[0][0]).toBe(`${BASE}/dispatcher/night-shift/policies`);
  });
});

const POLICY = {
  id: "pol-1", orgId: "org-1", name: "Standard",
  stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60,
  offRouteMi: 3.1, offRouteMin: 10, rungGapMin: 5, maxCalls: 2,
  dispatcherEmail: "ops@acme.com", dispatcherPhone: null,
  customerEmailOn: false, shadow: true, bossCallOn: true,
  quietFrom: null, quietTo: null,
};

describe("set_policy", () => {
  it("resolves the policy by name, then PATCHes just the patch fields — exactly two calls", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ policies: [POLICY] }))
      .mockResolvedValueOnce(jsonResponse({ policy: { ...POLICY, maxCalls: 4 } }));
    const tools = createTools(client());
    await tools.set_policy.handler({ name: "Standard", patch: { maxCalls: 4 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls()[0][0]).toBe(`${BASE}/dispatcher/night-shift/policies`);
    expect(calls()[1][0]).toBe(`${BASE}/dispatcher/night-shift/policies/pol-1`);
    expect(calls()[1][1].method).toBe("PATCH");
    // Only the patch fields — never the whole policy object list_policies
    // returned. This is the fix-round-1 point: no local merge, no stale
    // copy of anything else on the policy to accidentally revert.
    expect(JSON.parse(calls()[1][1].body as string)).toEqual({ maxCalls: 4 });
  });

  it('refuses a patch containing "shadow" locally, without any HTTP call at all', async () => {
    const tools = createTools(client());
    await expect(tools.set_policy.handler({ name: "Standard", patch: { shadow: false } })).rejects.toThrow(
      /live mode is changed on the Night Shift page/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses even when "shadow" is set to its own current value', async () => {
    const tools = createTools(client());
    await expect(tools.set_policy.handler({ name: "Standard", patch: { shadow: true } })).rejects.toThrow(
      /live mode is changed on the Night Shift page/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("usage", () => {
  it("with no range: one GET, no query string", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nights: [] }));
    const tools = createTools(client());
    const result = await tools.usage.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls()[0][0]).toBe(`${BASE}/dispatcher/night-shift/usage`);
    expect(result).toEqual({ nights: [] });
  });

  it("with a range: appends it as a query param, still one GET", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nights: [] }));
    const tools = createTools(client());
    await tools.usage.handler({ range: "last-7-days" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls()[0][0]).toBe(`${BASE}/dispatcher/night-shift/usage?range=last-7-days`);
  });
});

describe("every tool", () => {
  it("is exactly the spec's list — no more, no fewer", () => {
    const tools = createTools(client());
    expect(Object.keys(tools).sort()).toEqual(
      [
        "list_watched_loads", "load_status", "watch_load", "stop", "call_now",
        "takeover", "handback", "reply", "correct", "list_policies", "set_policy", "usage",
      ].sort(),
    );
  });
});
