import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { STANDARD_POLICY } from "../src/lib/agentPolicies.js";

// Task 5: Night Shift's own OrgApiKey (spec §10/§12) — key management
// (session-only) and the apiKeyAuth/apiKeyAllowList middleware pair that lets
// an x-api-key request reach the small set of routes the MCP server needs
// and nothing else. Separate from tests/night-shift-routes.test.ts (which
// covers the routes themselves under a dispatcher session) and from the
// untouched webhook-ingest key (Org.apiKey, dispatcherIntegrations.ts).

beforeEach(resetDb);

let seq = 0;

async function seedOrg() {
  seq += 1;
  const org = await prisma.org.create({ data: { name: `KeyOrg-${seq}` } });
  const disp = await prisma.dispatcher.create({
    data: { email: `key-${seq}@x.com`, passwordHash: "x", name: "Dana Ops", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  return { org, disp, auth };
}

async function seedStandard(orgId: string) {
  return prisma.agentPolicy.create({ data: { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com" } });
}

async function issueKeyViaRoute(auth: string, name = "Claude Desktop") {
  const res = await request(app).post("/api/dispatcher/night-shift/api-keys").set("authorization", auth).send({ name });
  return res.body as { key: string; id: string; prefix: string };
}

// --- Key management (session-only) ------------------------------------------

describe("POST /night-shift/api-keys", () => {
  it("issues a key, shown once, hashed at rest", async () => {
    const { org, auth } = await seedOrg();
    const res = await request(app).post("/api/dispatcher/night-shift/api-keys").set("authorization", auth).send({ name: "Claude Desktop" });

    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^ns_live_/);
    expect(res.body.prefix).toBe(res.body.key.slice(0, 10));

    const row = await prisma.orgApiKey.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.orgId).toBe(org.id);
    expect(row.role).toBe("nightshift");
    expect(row.keyHash).not.toBe(res.body.key);
    expect(row.revokedAt).toBeNull();
  });

  it("400s a blank name", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).post("/api/dispatcher/night-shift/api-keys").set("authorization", auth).send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("sits behind the dispatcher auth gate — unauthenticated is 401", async () => {
    const res = await request(app).post("/api/dispatcher/night-shift/api-keys").send({ name: "x" });
    expect(res.status).toBe(401);
  });
});

describe("GET /night-shift/api-keys", () => {
  it("lists the org's keys with prefix/name/created, never the raw key", async () => {
    const { auth } = await seedOrg();
    await issueKeyViaRoute(auth, "Claude Desktop");
    await issueKeyViaRoute(auth, "Cursor");

    const res = await request(app).get("/api/dispatcher/night-shift/api-keys").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(2);
    expect(res.body.keys.map((k: { name: string }) => k.name).sort()).toEqual(["Claude Desktop", "Cursor"]);
    for (const k of res.body.keys) {
      expect(k.key).toBeUndefined();
      expect(k.prefix).toMatch(/^ns_live_/);
    }
  });

  it("never lists another org's keys", async () => {
    const { auth } = await seedOrg();
    const other = await seedOrg();
    await issueKeyViaRoute(other.auth, "Other org's key");

    const res = await request(app).get("/api/dispatcher/night-shift/api-keys").set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([]);
  });
});

describe("DELETE /night-shift/api-keys/:id", () => {
  it("revokes a key — it stops authenticating immediately", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const before = await request(app).get("/api/dispatcher/night-shift/policies").set("x-api-key", issued.key);
    expect(before.status).toBe(200);

    const del = await request(app).delete(`/api/dispatcher/night-shift/api-keys/${issued.id}`).set("authorization", auth);
    expect(del.status).toBe(204);

    const after = await request(app).get("/api/dispatcher/night-shift/policies").set("x-api-key", issued.key);
    expect(after.status).toBe(401);
  });

  it("404s another org's key id, never 403", async () => {
    const { auth } = await seedOrg();
    const other = await seedOrg();
    const theirs = await issueKeyViaRoute(other.auth);

    const res = await request(app).delete(`/api/dispatcher/night-shift/api-keys/${theirs.id}`).set("authorization", auth);
    expect(res.status).toBe(404);
  });

  it("404s an unknown id", async () => {
    const { auth } = await seedOrg();
    const res = await request(app).delete("/api/dispatcher/night-shift/api-keys/does-not-exist").set("authorization", auth);
    expect(res.status).toBe(404);
  });
});

// --- apiKeyAuth + apiKeyAllowList (the machine path) ------------------------

describe("an x-api-key request", () => {
  it("reaches an allow-listed Night Shift route, org-scoped to the key's own org", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const res = await request(app).get("/api/dispatcher/night-shift/policies").set("x-api-key", issued.key);
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(1);
  });

  it("401s an unknown key", async () => {
    const res = await request(app).get("/api/dispatcher/night-shift/policies").set("x-api-key", "ns_live_not-a-real-key");
    expect(res.status).toBe(401);
  });

  it("401s a route not on the allow-list, even with a valid key (integrations stay session-only)", async () => {
    const { auth } = await seedOrg();
    const issued = await issueKeyViaRoute(auth);
    const res = await request(app).get("/api/dispatcher/night-shift/api-keys").set("x-api-key", issued.key);
    expect(res.status).toBe(401);
  });

  it("401s the sheet OAuth routes", async () => {
    const { auth } = await seedOrg();
    const issued = await issueKeyViaRoute(auth);
    const res = await request(app).get("/api/dispatcher/sheet").set("x-api-key", issued.key);
    expect(res.status).toBe(401);
  });

  it("401s the webhook-ingest style route (the plain dispatcher loads list)", async () => {
    const { auth } = await seedOrg();
    const issued = await issueKeyViaRoute(auth);
    const res = await request(app).get("/api/dispatcher/loads").set("x-api-key", issued.key);
    expect(res.status).toBe(401);
  });

  it("a bearer session still wins when both headers are present", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const res = await request(app)
      .get("/api/dispatcher/night-shift/policies")
      .set("authorization", auth)
      .set("x-api-key", "ns_live_garbage-should-be-ignored");
    expect(res.status).toBe(200);
  });

  it("can reach GET/POST /loads/:id/agent, the commands route, night-shift/loads, usage, and loads/lookup", async () => {
    const { org, auth } = await seedOrg();
    const policy = await seedStandard(org.id);
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", boardLoadNo: "L100" } });
    const issued = await issueKeyViaRoute(auth);
    const key = issued.key;

    const lookup = await request(app).get("/api/dispatcher/loads/lookup?ref=L100").set("x-api-key", key);
    expect(lookup.status).toBe(200);
    expect(lookup.body.load.id).toBe(load.id);

    const watch = await request(app).post(`/api/dispatcher/loads/${load.id}/agent`).set("x-api-key", key).send({ enabled: true, policyId: policy.id });
    expect(watch.status).toBe(200);

    const status = await request(app).get(`/api/dispatcher/loads/${load.id}/agent`).set("x-api-key", key);
    expect(status.status).toBe(200);

    const cmd = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("x-api-key", key).send({ kind: "stop" });
    expect(cmd.status).toBe(202);

    const watched = await request(app).get("/api/dispatcher/night-shift/loads").set("x-api-key", key);
    expect(watched.status).toBe(200);
    expect(watched.body.loads.map((l: { id: string }) => l.id)).toContain(load.id);

    const usage = await request(app).get("/api/dispatcher/night-shift/usage").set("x-api-key", key);
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual({ nights: [] });
  });

  it("traces a command queued via a key with an api: actor name", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const load = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan" } });
    const issued = await issueKeyViaRoute(auth, "Claude Desktop");

    const res = await request(app).post(`/api/dispatcher/loads/${load.id}/agent/commands`).set("x-api-key", issued.key).send({ kind: "stop" });
    expect(res.status).toBe(202);
    expect(res.body.command.actorName).toBe("api:Claude Desktop");
  });

  it("refuses PUT .../policies/:id when the body changes shadow", async () => {
    const { org, auth } = await seedOrg();
    const policy = await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const body = { ...STANDARD_POLICY, dispatcherEmail: "ops@acme.com", dispatcherPhone: null, shadow: !policy.shadow };
    const res = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("x-api-key", issued.key).send(body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN", message: "shadow can only be changed from the Night Shift page" });

    const unchanged = await prisma.agentPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(unchanged.shadow).toBe(policy.shadow);
  });

  it("allows PUT .../policies/:id via key when shadow is repeated unchanged", async () => {
    const { org, auth } = await seedOrg();
    const policy = await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const body = { ...STANDARD_POLICY, dispatcherEmail: "ops@acme.com", dispatcherPhone: null, shadow: policy.shadow, maxCalls: 3 };
    const res = await request(app).put(`/api/dispatcher/night-shift/policies/${policy.id}`).set("x-api-key", issued.key).send(body);
    expect(res.status).toBe(200);
    expect(res.body.policy.maxCalls).toBe(3);
  });

  // --- Fix round 1 ------------------------------------------------------------

  it("PATCH .../policies/:id via a key changes only the named field", async () => {
    const { org, auth } = await seedOrg();
    const policy = await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const res = await request(app).patch(`/api/dispatcher/night-shift/policies/${policy.id}`).set("x-api-key", issued.key).send({ maxCalls: 4 });
    expect(res.status).toBe(200);
    expect(res.body.policy.maxCalls).toBe(4);
    expect(res.body.policy.dispatcherEmail).toBe(policy.dispatcherEmail);
  });

  it("PATCH .../policies/:id refuses a body carrying shadow via a key", async () => {
    const { org, auth } = await seedOrg();
    const policy = await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const res = await request(app).patch(`/api/dispatcher/night-shift/policies/${policy.id}`).set("x-api-key", issued.key).send({ shadow: !policy.shadow });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN", message: "shadow can only be changed from the Night Shift page" });
  });

  it("PATCH .../policies/:id refuses a body carrying shadow via a session too — PUT is the Night Shift page's own route for that", async () => {
    const { org, auth } = await seedOrg();
    const policy = await seedStandard(org.id);

    const res = await request(app).patch(`/api/dispatcher/night-shift/policies/${policy.id}`).set("authorization", auth).send({ shadow: !policy.shadow });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN", message: "shadow can only be changed from the Night Shift page" });
  });

  it("org A's key against org B's load 404s on GET /loads/:id/agent", async () => {
    const { org: orgA, auth: authA } = await seedOrg();
    const { org: orgB } = await seedOrg();
    await seedStandard(orgA.id);
    const loadB = await prisma.load.create({ data: { orgId: orgB.id, requiredEquip: "DryVan" } });
    const issued = await issueKeyViaRoute(authA);

    const res = await request(app).get(`/api/dispatcher/loads/${loadB.id}/agent`).set("x-api-key", issued.key);
    expect(res.status).toBe(404);
  });

  it("org A's key against org B's load 404s on POST /loads/:id/agent/commands", async () => {
    const { org: orgA, auth: authA } = await seedOrg();
    const { org: orgB } = await seedOrg();
    await seedStandard(orgA.id);
    const loadB = await prisma.load.create({ data: { orgId: orgB.id, requiredEquip: "DryVan" } });
    const issued = await issueKeyViaRoute(authA);

    const res = await request(app).post(`/api/dispatcher/loads/${loadB.id}/agent/commands`).set("x-api-key", issued.key).send({ kind: "stop" });
    expect(res.status).toBe(404);
  });

  it("a garbage bearer is not rescued by a VALID x-api-key sitting alongside it", async () => {
    const { org, auth } = await seedOrg();
    await seedStandard(org.id);
    const issued = await issueKeyViaRoute(auth);

    const res = await request(app)
      .get("/api/dispatcher/night-shift/policies")
      .set("authorization", "Bearer this-is-not-a-real-token")
      .set("x-api-key", issued.key);
    expect(res.status).toBe(401);
  });
});
