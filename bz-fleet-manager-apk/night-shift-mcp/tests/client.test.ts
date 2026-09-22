import { beforeEach, describe, expect, it, vi } from "vitest";
import { NightShiftApiError, NightShiftClient } from "../src/client.js";

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

describe("NightShiftClient", () => {
  it("sends the x-api-key header and a JSON content-type on every call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
    await client.get("/dispatcher/night-shift/loads");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["content-type"]).toBe("application/json");
  });

  it("throws NightShiftApiError with the server's message on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "FORBIDDEN", message: "shadow can only be changed from the Night Shift page" }, 403));
    const client = new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.get("/dispatcher/night-shift/policies/pol-1")).rejects.toMatchObject({
      status: 403,
      message: "shadow can only be changed from the Night Shift page",
    });
  });

  it("falls back to the error field, then the HTTP status, when no message is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Load not found" }, 404));
    const client = new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.get("/dispatcher/loads/x/agent")).rejects.toThrow("Load not found");
  });

  it("lookupLoadId GETs the lookup route and returns the load id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ load: { id: "load-1", boardLoadNo: "L100", orderRef: null } }));
    const client = new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
    const id = await client.lookupLoadId("L100");
    expect(id).toBe("load-1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/dispatcher/loads/lookup?ref=L100`);
  });

  it("policyByName throws a clear error for an unknown name", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ policies: [{ id: "p1", name: "Standard" }] }));
    const client = new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.policyByName("Ghost")).rejects.toThrow(/No policy named "Ghost"/);
  });

  it("is a NightShiftApiError instance (not a plain Error) for status-carrying failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 401));
    const client = new NightShiftClient({ baseUrl: BASE, apiKey: KEY });
    try {
      await client.get("/x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NightShiftApiError);
    }
  });
});
