import request from "supertest";
import WebSocket from "ws";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { STANDARD_POLICY } from "../src/lib/agentPolicies.js";
import { createMessageCollector, startServer, stopServer, waitForOpen } from "./realtime-helpers.js";
import { FakeConnector } from "../src/lib/sheet/fakeConnector.js";
import type { SheetConnector } from "../src/lib/sheet/connector.js";

// Task 9: a policy create/rename re-installs a connected org's sheet columns
// (installAgentColumns, via connectorFor). Mocked here the same way
// tests/sheet/routes.test.ts mocks it for the HTTP routes — a single shared
// connector this whole file's tests read/write through `sheetConnector`.
let sheetConnector: SheetConnector | null = null;
vi.mock("../src/lib/sheet/connectorFor.js", () => ({
  connectorFor: vi.fn(() => sheetConnector),
}));

// Task 3 (Night Shift on the Board): policies, the switch, the timeline and
// the supervision drawer — src/routes/dispatcherNightShift.ts. Every
// tenancy assertion goes through the real app (helpers.js's `app`, built by
// the real createApp()), same discipline tests/dispatcher-rest-stops.test.ts
// and tests/load-changed-events.test.ts already follow: a cross-tenant id
// reads as 404, never 403 — a 403 would confirm the row exists.

beforeEach(() => { sheetConnector = null; });
beforeEach(resetDb);

let seq = 0;

async function seedOrg() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: `NightOrg-${seq}` } });
  const disp = await prisma.dispatcher.create({
    data: { email: `ns-${seq}@x.com`, passwordHash: "x", name: "Dana Ops", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  return { org, disp, auth };
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

async function openSocket(dispatcherId: string) {
  const { server, port } = await startServer();
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${signDispatcherAccess(dispatcherId)}`);
  await waitForOpen(ws);
  return { server, ws, collector: createMessageCollector(ws) };
}

/** Skips past any other frame type to the next `load_changed`, same helper
 *  tests/load-changed-events.test.ts uses for the same reason. */
async function nextLoadChanged(collector: ReturnType<typeof createMessageCollector>, timeoutMs = 2000): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await collector.next(timeoutMs);
    if (frame.type === "load_changed") return frame;
  }
}

// A full, valid agentPolicySchema body — every field the schema requires,
// `dispatcherPhone`/`quietFrom`/`quietTo` explicit `null` (the schema marks
// them `.nullable()`, not `.optional()`, so the key must be present).
const POLICY_BODY = {
  name: "Aggressive",
  stopMin: 10, delayMin: 20, darkMin: 15, darkAtStopMin: 45,
  offRouteMi: 2, offRouteMin: 8,
  rungGapMin: 5, maxCalls: 3,
  dispatcherEmail: "ops@acme.com", dispatcherPhone: null as string | null,
  customerEmailOn: false, shadow: true, bossCallOn: true,
  quietFrom: null as string | null, quietTo: null as string | null,
};

// --- GET /night-shift/policies ------------------------------------------------

describe("GET /night-shift/policies", () => {
  it("lists the org's policies with a per-policy load count", async () => {
    const { org, auth } = await seedOrg();
    const std = await seedStandard(org.id);
    const custom = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    await seedLoad(org.id, { agentPolicyId: custom.id });
    await seedLoad(org.id, { agentPolicyId: custom.id });
    await seedLoad(org.id); // no policy chosen — must not be counted under Standard

    const res = await request(app).get("/api/dispatcher/night-shift/policies").set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(2);
    expect(res.body.loadsByPolicy).toEqual({ [custom.id]: 2 });
    expect(res.body.loadsByPolicy[std.id]).toBeUndefined();
  });

  it("never lists another org's policies", async () => {
    const { auth } = await seedOrg();
    const other = await prisma.org.create({ data: { name: "Other" } });
    await seedStandard(other.id);

    const res = await request(app).get("/api/dispatcher/night-shift/policies").set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.policies).toEqual([]);
  });

  it("sits behind the dispatcher auth gate — unauthenticated is 401", async () => {
    const res = await request(app).get("/api/dispatcher/night-shift/policies");
    expect(res.status).toBe(401);
  });
});

// --- POST /night-shift/policies ------------------------------------------------

describe("POST /night-shift/policies", () => {
  it("creates a policy for the caller's org", async () => {
    const { org, auth } = await seedOrg();

    const res = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", auth).send(POLICY_BODY);

    expect(res.status).toBe(201);
    expect(res.body.policy).toMatchObject({ name: "Aggressive", orgId: org.id, stopMin: 10 });
    const row = await prisma.agentPolicy.findUnique({ where: { id: res.body.policy.id as string } });
    expect(row).not.toBeNull();
  });

  it("refuses a duplicate name within the same org with 409", async () => {
    const { org, auth } = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });

    const res = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", auth).send(POLICY_BODY);

    expect(res.status).toBe(409);
  });

  it("allows the same name in two different orgs", async () => {
    const { auth: authA } = await seedOrg();
    const { auth: authB } = await seedOrg();

    const resA = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", authA).send(POLICY_BODY);
    const resB = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", authB).send(POLICY_BODY);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
  });

  it("rejects a malformed body with 400 (a phone that is not E.164)", async () => {
    const { auth } = await seedOrg();

    const res = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", auth)
      .send({ ...POLICY_BODY, dispatcherPhone: "555-1234" });

    expect(res.status).toBe(400);
  });
});

// --- PUT /night-shift/policies/:id ------------------------------------------------

describe("PUT /night-shift/policies/:id", () => {
  it("updates a policy's thresholds", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });

    const res = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth)
      .send({ ...POLICY_BODY, stopMin: 99 });

    expect(res.status).toBe(200);
    expect(res.body.policy.stopMin).toBe(99);
    const row = await prisma.agentPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(row.stopMin).toBe(99);
  });

  it("a policy from another org 404s, never 403s — a 403 would confirm it exists", async () => {
    const { auth } = await seedOrg();
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.agentPolicy.create({ data: policyData(otherOrg.id, { name: "Foreign" }) });

    const res = await request(app).put(`/api/dispatcher/night-shift/policies/${foreign.id}`).set("authorization", auth).send(POLICY_BODY);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("404s an unknown policy id", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).put("/api/dispatcher/night-shift/policies/does-not-exist").set("authorization", auth).send(POLICY_BODY);
    expect(res.status).toBe(404);
  });

  it("flipping shadow off writes a plain console.info audit line naming the org and the actor, not a LoadChange", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive", shadow: true }) });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const res = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth)
      .send({ ...POLICY_BODY, shadow: false });

    expect(res.status).toBe(200);
    expect(res.body.policy.shadow).toBe(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [line] = infoSpy.mock.calls[0] as unknown[];
    expect(String(line)).toContain(org.id);
    expect(String(line)).toContain("Dana Ops");

    const changes = await prisma.loadChange.findMany({ where: { orgId: org.id } });
    expect(changes).toEqual([]);

    infoSpy.mockRestore();
  });

  it("does not log when shadow was already off, and does not log on any other field's change", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive", shadow: false }) });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth)
      .send({ ...POLICY_BODY, shadow: false, stopMin: 42 });

    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("rejects renaming a policy to a name the org already has, with 409", async () => {
    const { org, auth } = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Taken" }) });
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });

    const res = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth)
      .send({ ...POLICY_BODY, name: "Taken" });

    expect(res.status).toBe(409);
  });
});

// --- DELETE /night-shift/policies/:id ------------------------------------------------

describe("DELETE /night-shift/policies/:id", () => {
  it("refuses to delete Standard, even with zero loads", async () => {
    const { org, auth } = await seedOrg();
    const std = await seedStandard(org.id);

    const res = await request(app).delete(`/api/dispatcher/night-shift/policies/${std.id}`).set("authorization", auth);

    expect(res.status).toBe(409);
    const stillThere = await prisma.agentPolicy.findUnique({ where: { id: std.id } });
    expect(stillThere).not.toBeNull();
  });

  it("refuses to delete a policy loads still use", async () => {
    const { org, auth } = await seedOrg();
    const custom = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    await seedLoad(org.id, { agentPolicyId: custom.id });

    const res = await request(app).delete(`/api/dispatcher/night-shift/policies/${custom.id}`).set("authorization", auth);

    expect(res.status).toBe(409);
    const stillThere = await prisma.agentPolicy.findUnique({ where: { id: custom.id } });
    expect(stillThere).not.toBeNull();
  });

  it("deletes a policy no load uses", async () => {
    const { org, auth } = await seedOrg();
    const custom = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });

    const res = await request(app).delete(`/api/dispatcher/night-shift/policies/${custom.id}`).set("authorization", auth);

    expect(res.status).toBe(204);
    const gone = await prisma.agentPolicy.findUnique({ where: { id: custom.id } });
    expect(gone).toBeNull();
  });

  it("a policy from another org 404s on delete, never 403s", async () => {
    const { auth } = await seedOrg();
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.agentPolicy.create({ data: policyData(otherOrg.id, { name: "Foreign" }) });

    const res = await request(app).delete(`/api/dispatcher/night-shift/policies/${foreign.id}`).set("authorization", auth);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    const stillThere = await prisma.agentPolicy.findUnique({ where: { id: foreign.id } });
    expect(stillThere).not.toBeNull();
  });
});

// --- Policy writes re-install a connected sheet's columns (Task 9) --------------------

const AGENT_GRID = [
  ["LOAD#", "DRIVER PHONE", "PICK UP", "DELIVERY", "DEL APPT"],
  ["145219", "+15551234567", "Dallas, TX", "Reno, NV", "09/22 08:00"],
];

async function seedConnectedBinding(orgId: string) {
  sheetConnector = new FakeConnector({ s1: { title: "Loads", tabs: { t1: { title: "Sheet1", grid: AGENT_GRID.map((r) => [...r]) } } } });
  return prisma.sheetBinding.create({
    data: {
      orgId, provider: "google", spreadsheetId: "s1", tabId: "t1", tabTitle: "Sheet1",
      headerRow: 1, columns: { loadRef: "LOAD#" }, refreshToken: "sealed-x", status: "connected",
    },
  });
}

describe("policy writes re-install a connected sheet's Night Shift columns", () => {
  it("POST /night-shift/policies re-installs the columns when a connected binding exists", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    await seedConnectedBinding(org.id);

    const res = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", auth).send(POLICY_BODY);
    expect(res.status).toBe(201);

    const binding = await prisma.sheetBinding.findFirstOrThrow({ where: { orgId: org.id } });
    expect(binding.agentSwitchCol).not.toBeNull();
    expect(binding.agentStatusCol).not.toBeNull();
    expect((sheetConnector as FakeConnector).validation({ spreadsheetId: "s1", tabId: "t1" }, binding.agentSwitchCol as number))
      .toEqual(["OFF", "Standard", "Aggressive"]);
  });

  it("POST /night-shift/policies does nothing to the sheet when no binding is connected", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);

    const res = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", auth).send(POLICY_BODY);
    expect(res.status).toBe(201);
    // No SheetBinding row exists for this org at all — nothing to assert on
    // the sheet side; the point is that this request never touched
    // connectorFor (sheetConnector stayed null and nothing threw).
    const binding = await prisma.sheetBinding.findFirst({ where: { orgId: org.id } });
    expect(binding).toBeNull();
  });

  it("PUT .../:id re-installs only when the name actually changes", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    await seedConnectedBinding(org.id);

    // No rename: install must not run — the dropdown never gains anything,
    // so `validation` for the (not-yet-installed) switch column is empty.
    const unchanged = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth).send(POLICY_BODY);
    expect(unchanged.status).toBe(200);
    let binding = await prisma.sheetBinding.findFirstOrThrow({ where: { orgId: org.id } });
    expect(binding.agentSwitchCol).toBeNull();

    // A rename does re-install.
    const renamed = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth)
      .send({ ...POLICY_BODY, name: "Renamed" });
    expect(renamed.status).toBe(200);
    binding = await prisma.sheetBinding.findFirstOrThrow({ where: { orgId: org.id } });
    expect(binding.agentSwitchCol).not.toBeNull();
    expect((sheetConnector as FakeConnector).validation({ spreadsheetId: "s1", tabId: "t1" }, binding.agentSwitchCol as number))
      .toEqual(["OFF", "Renamed"]);
  });

  it("a connector failure during re-install does not fail the policy write, and sets binding.lastError", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const binding = await seedConnectedBinding(org.id);
    // Poison the connector so ensureAgentColumns throws.
    sheetConnector = {
      spreadsheetInfo: async () => ({ title: "Loads", tabs: [] }),
      readHeader: async () => { throw new Error("sheets API down"); },
      readRows: async () => ({ header: [], rows: [], version: "1", changed: false }),
      writeCells: async () => {},
      ensureAgentColumns: async () => { throw new Error("sheets API down"); },
    };

    const res = await request(app).post("/api/dispatcher/night-shift/policies").set("authorization", auth).send(POLICY_BODY);
    expect(res.status).toBe(201); // the policy write itself still succeeds

    const fresh = await prisma.sheetBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(fresh.lastError).toBe("sheets API down");
  });
});

// --- POST /loads/:id/agent — the switch ------------------------------------------------

describe("POST /loads/:id/agent — the switch", () => {
  it("enabling bumps agentEnabled/agentPill/version, writes a LoadChange row, and emits load_changed", async () => {
    const { org, disp, auth } = await seedOrg();
    await seedStandard(org.id);
    const load = await seedLoad(org.id);
    const { server, ws, collector } = await openSocket(disp.id);
    try {
      const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.load).toMatchObject({ agentEnabled: true, agentPill: "watching" });
      expect(res.body.version).toBe(load.version + 1);

      const frame = await nextLoadChanged(collector);
      expect(frame).toMatchObject({ loadId: load.id, version: res.body.version });
      expect(frame.fields).toContain("agentEnabled");

      const trace = await prisma.loadChange.findMany({ where: { loadId: load.id } });
      const fields = trace.map((t) => t.field);
      expect(fields).toContain("agentEnabled");
      expect(fields).toContain("agentPill");
    } finally {
      await stopServer(server, [ws]);
    }
  });

  it("sets the given policyId when enabling", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    const load = await seedLoad(org.id);

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
      .send({ enabled: true, policyId: policy.id });

    expect(res.status).toBe(200);
    expect(res.body.load.agentPolicyId).toBe(policy.id);
  });

  it("leaves agentPolicyId untouched when no policyId is given (no derivation)", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    const load = await seedLoad(org.id, { agentPolicyId: policy.id });

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.load.agentPolicyId).toBe(policy.id);
  });

  it("404s a policyId from another org, and applies nothing", async () => {
    const { org, auth } = await seedOrg();
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreignPolicy = await prisma.agentPolicy.create({ data: policyData(otherOrg.id, { name: "Foreign" }) });
    const load = await seedLoad(org.id);

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
      .send({ enabled: true, policyId: foreignPolicy.id });

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    const unchanged = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(unchanged.agentEnabled).toBe(false);
    expect(unchanged.version).toBe(load.version);
  });

  it("disabling sets agentPill off, agentEnabled false, and writes a stop AgentCommand", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const load = await seedLoad(org.id, { agentEnabled: true, agentPill: "watching" });

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.load).toMatchObject({ agentEnabled: false, agentPill: "off" });

    const commands = await prisma.agentCommand.findMany({ where: { loadId: load.id } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: "stop", appliedAt: null });
    expect(commands[0]?.actorName).toBe("Dana Ops");
  });

  it("404s a load from another org, never 403s", async () => {
    const { auth } = await seedOrg();
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreignLoad = await seedLoad(otherOrg.id);

    const res = await request(app).post(`/api/dispatcher/loads/${foreignLoad.id}/agent`).set("authorization", auth).send({ enabled: true });

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("refuses to flip the switch on a load someone else is editing", async () => {
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);
    await prisma.loadLock.create({
      data: { loadId: load.id, orgId: org.id, dispatcherId: "disp-maria", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
    });

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth).send({ enabled: true });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "LOAD_LOCKED", lock: { by: "Maria" } });
    const unchanged = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(unchanged.agentEnabled).toBe(false);
  });

  it("refuses a flip whose baseVersion is behind the record, and accepts a current one", async () => {
    // Spec §7.4: a view of the record that has moved on does not overwrite it.
    // Two dispatchers flipping the same load must not be last-write-wins.
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);
    // Move the record once (a real change: off -> on) so there is a version to be behind.
    const first = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth).send({ enabled: true });
    expect(first.status).toBe(200);
    const current = (await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).version;
    expect(current).toBeGreaterThan(0);

    // A colleague who rendered the row before that flip tries to switch it off.
    const stale = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
      .send({ enabled: false, baseVersion: current - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "STALE_VERSION", current });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).agentEnabled).toBe(true); // untouched

    const fresh = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth)
      .send({ enabled: false, baseVersion: current });
    expect(fresh.status).toBe(200);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).agentEnabled).toBe(false);
  });

  it("rejects a malformed body with 400", async () => {
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth).send({ enabled: "yes" });

    expect(res.status).toBe(400);
  });
});

// --- GET /loads/:id/agent — the timeline ------------------------------------------------

describe("GET /loads/:id/agent — the timeline", () => {
  it("returns enabled/policy/pill/line and merges AgentUpdate + AgentEvent rows, newest first", async () => {
    const { org, auth } = await seedOrg();
    const std = await seedStandard(org.id);
    const load = await seedLoad(org.id, { agentEnabled: true, agentPill: "watching" });

    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1000), kind: "status", text: "En route to pickup" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(2000), kind: "attention", text: "can't reach driver" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(3000), kind: "eta", text: "ETA 14:00" } });

    const trip = await prisma.agentTrip.create({
      data: { id: `trip-${load.id}`, loadRef: "L-1", loadId: load.id, driverToken: `tok-${load.id}`, brief: {}, status: "tracking" },
    });
    await prisma.agentEvent.create({ data: { tripId: trip.id, atMs: BigInt(1500), kind: "anomaly", evidence: { kind: "delay" }, actionTaken: "asked the driver" } });
    await prisma.agentEvent.create({ data: { tripId: trip.id, atMs: BigInt(2500), kind: "ping", evidence: { at: { lat: 1, lng: 2 } } } });

    const res = await request(app).get(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.pill).toBe("watching");
    // The load never named its own policy — resolves to the org's Standard,
    // the same fallback lib/agentPolicies.ts's policyFor() gives everywhere.
    expect(res.body.policy.id).toBe(std.id);
    // The newest AgentUpdate that is NOT an attention line.
    expect(res.body.line).toBe("ETA 14:00");

    const timeline = res.body.timeline as { atMs: number; kind: string; text: string; evidence?: unknown }[];
    expect(timeline.map((t) => t.atMs)).toEqual([3000, 2500, 2000, 1500, 1000]);

    const eventEntry = timeline.find((t) => t.atMs === 1500);
    expect(eventEntry).toMatchObject({ kind: "anomaly", text: "asked the driver" });
    expect(eventEntry?.evidence).toEqual({ kind: "delay" });

    const updateEntry = timeline.find((t) => t.atMs === 1000);
    expect(updateEntry).toMatchObject({ kind: "status", text: "En route to pickup" });
  });

  it("resolves the load's own policy when one is set", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const custom = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    const load = await seedLoad(org.id, { agentPolicyId: custom.id });

    const res = await request(app).get(`/api/dispatcher/loads/${load.id}/agent`).set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.policy.id).toBe(custom.id);
  });

  it("404s a load from another org, never 403s", async () => {
    const { auth } = await seedOrg();
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreignLoad = await seedLoad(otherOrg.id);

    const res = await request(app).get(`/api/dispatcher/loads/${foreignLoad.id}/agent`).set("authorization", auth);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });
});

// --- POST /loads/:id/agent/commands ------------------------------------------------

describe("POST /loads/:id/agent/commands", () => {
  it("writes an AgentCommand with the actor's name and answers 202; appliedAt is null", async () => {
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("authorization", auth)
      .send({ kind: "call" });

    expect(res.status).toBe(202);
    const rows = await prisma.agentCommand.findMany({ where: { loadId: load.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "call", actorName: "Dana Ops", appliedAt: null });
  });

  it("carries a payload through, and persists as null (not a written JSON null) when omitted", async () => {
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);

    const withPayload = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("authorization", auth)
      .send({ kind: "reply", payload: { text: "tell the driver to call in" } });
    expect(withPayload.status).toBe(202);
    expect(withPayload.body.command.payload).toEqual({ text: "tell the driver to call in" });

    const stop = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("authorization", auth)
      .send({ kind: "stop" });
    expect(stop.status).toBe(202);
    const row = await prisma.agentCommand.findUnique({ where: { id: stop.body.command.id as string } });
    expect(row?.payload).toBeNull();
  });

  it("accepts every kind in the drawer's vocabulary", async () => {
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);
    const kinds = ["stop", "call", "reply", "correct", "takeover", "handback", "send_customer_email"];

    for (const kind of kinds) {
      const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("authorization", auth).send({ kind });
      expect(res.status).toBe(202);
    }
    const rows = await prisma.agentCommand.findMany({ where: { loadId: load.id } });
    expect(rows.map((r) => r.kind).sort()).toEqual([...kinds].sort());
  });

  it("rejects a kind outside the vocabulary with 400", async () => {
    const { org, auth } = await seedOrg();
    const load = await seedLoad(org.id);

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("authorization", auth).send({ kind: "bogus" });

    expect(res.status).toBe(400);
  });

  it("404s a load from another org, never 403s", async () => {
    const { auth } = await seedOrg();
    const otherOrg = await prisma.org.create({ data: { name: "Other" } });
    const foreignLoad = await seedLoad(otherOrg.id);

    const res = await request(app).post(`/api/dispatcher/loads/${foreignLoad.id}/agent/commands`).set("authorization", auth).send({ kind: "stop" });

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });
});

// --- Board projections ------------------------------------------------

describe("the agent fields on both board GETs", () => {
  it("broker board projects agentEnabled/agentPolicyId/agentPill beside agentLine", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    const load = await seedLoad(org.id, { agentEnabled: true, agentPolicyId: policy.id, agentPill: "calling", customerName: "ACME" });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "status", text: "hello" } });

    const res = await request(app).get("/api/dispatcher/broker-board").set("authorization", auth);

    expect(res.status).toBe(200);
    type BrokerRow = { agentEnabled: boolean; agentPolicyId: string; agentPill: string; agentLine: { text: string } | null };
    const row = (res.body.loads as ({ id: string } & BrokerRow)[]).find((l) => l.id === load.id) as BrokerRow;
    expect(row).toMatchObject({ agentEnabled: true, agentPolicyId: policy.id, agentPill: "calling" });
    expect(row.agentLine).toMatchObject({ text: "hello" });
  });

  it("loadboard projects the same four fields, including the newest non-attention line as agentLine", async () => {
    const { org, auth } = await seedOrg();
    const policy = await prisma.agentPolicy.create({ data: policyData(org.id, { name: "Aggressive" }) });
    const load = await seedLoad(org.id, { agentEnabled: true, agentPolicyId: policy.id, agentPill: "asked", status: "open" });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1), kind: "attention", text: "can't reach driver" } });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(2), kind: "status", text: "waiting on reply" } });

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000 * 24).toISOString();
    const res = await request(app).get(`/api/dispatcher/loadboard?from=${from}&to=${to}`).set("authorization", auth);

    expect(res.status).toBe(200);
    type LoadboardRow = { agentEnabled: boolean; agentPolicyId: string; agentPill: string; agentLine: string | null; attention: string[] };
    const row = (res.body.loads as ({ id: string } & LoadboardRow)[]).find((l) => l.id === load.id) as LoadboardRow;
    expect(row).toMatchObject({ agentEnabled: true, agentPolicyId: policy.id, agentPill: "asked", agentLine: "waiting on reply" });
    expect(row.attention).toEqual(["can't reach driver"]);
  });
});
