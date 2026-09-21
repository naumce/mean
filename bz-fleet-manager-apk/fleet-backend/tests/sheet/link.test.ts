import { randomBytes } from "node:crypto";
import request from "supertest";
import { app, resetDb } from "../helpers.js";
import { prisma } from "../../src/db.js";
import { linkUrlFor, orgTokenFor } from "../../src/lib/nightShiftLink.js";
import { STANDARD_POLICY } from "../../src/lib/agentPolicies.js";

// Task 10: the deep link — GET/POST /api/n/:orgToken/loads/:id/agent(/commands),
// authenticated by the org token alone (no dispatcher session, no
// Authorization header at all). Every tenancy assertion answers 404, never
// 403 — same discipline as tests/night-shift-routes.test.ts, since a bad
// token or a foreign load must read exactly like a load that does not exist.

beforeEach(resetDb);

let seq = 0;
async function seedOrg() {
  seq += 1;
  return prisma.org.create({ data: { name: `LinkOrg-${seq}`, linkSecret: randomBytes(32).toString("hex") } });
}

function policyData(orgId: string, over: Partial<Record<string, unknown>> = {}) {
  return { ...STANDARD_POLICY, orgId, dispatcherEmail: "ops@acme.com", ...over };
}

async function seedLoad(orgId: string, over: Partial<Record<string, unknown>> = {}) {
  return prisma.load.create({ data: { orgId, requiredEquip: "DryVan", revenueCents: 10000, status: "open", ...over } });
}

// --- linkUrlFor -----------------------------------------------------------------

describe("linkUrlFor", () => {
  it("throws naming PORTAL_URL when it is unset — never builds 'undefined/n/…' (final fix wave, I13)", () => {
    const saved = process.env.PORTAL_URL;
    try {
      delete process.env.PORTAL_URL;
      expect(() => linkUrlFor({ id: "org-1", linkSecret: "s" }, "load-1")).toThrow(/PORTAL_URL/);
      process.env.PORTAL_URL = "https://app.example.com/";
      expect(linkUrlFor({ id: "org-1", linkSecret: "s" }, "load-1")).toMatch(/^https:\/\/app\.example\.com\/n\/[0-9a-f]{32}\.org-1\/load-1$/);
    } finally {
      if (saved === undefined) delete process.env.PORTAL_URL; else process.env.PORTAL_URL = saved;
    }
  });
});

// --- GET /api/n/:orgToken/loads/:id/agent -----------------------------------

describe("GET /api/n/:orgToken/loads/:id/agent", () => {
  it("a valid token for the load's own org returns the timeline, matching the dispatcher route's body", async () => {
    const org = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id) });
    const load = await seedLoad(org.id, { agentEnabled: true, agentPill: "watching" });
    await prisma.agentUpdate.create({ data: { loadId: load.id, atMs: BigInt(1000), kind: "status", text: "En route" } });

    const token = orgTokenFor(org);
    const res = await request(app).get(`/api/n/${token}/loads/${load.id}/agent`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, pill: "watching", line: "En route" });
    expect(res.body.timeline).toHaveLength(1);
    expect(res.body.policy.name).toBe("Standard");
  });

  it("a token for org A against org B's load id 404s", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(orgB.id) });
    const loadB = await seedLoad(orgB.id);

    const tokenA = orgTokenFor(orgA);
    const res = await request(app).get(`/api/n/${tokenA}/loads/${loadB.id}/agent`);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("a tampered token (digest flipped) 404s", async () => {
    const org = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id) });
    const load = await seedLoad(org.id);

    const [digest, orgId] = orgTokenFor(org).split(".");
    const tampered = `${digest!.split("").reverse().join("")}.${orgId}`;
    const res = await request(app).get(`/api/n/${tampered}/loads/${load.id}/agent`);

    expect(res.status).toBe(404);
  });

  // Final fix wave, I12: an org whose linkSecret is empty has no signable
  // link at all — an HMAC keyed by "" is a guessable digest, so the token
  // is refused outright. (New orgs get a DB-generated secret; the migration
  // back-filled the old ones. This pins what happens if one is ever blank.)
  it("an org with an empty linkSecret 404s even with the token that empty secret would sign", async () => {
    const org = await prisma.org.create({ data: { name: "NoSecretOrg" } });
    await prisma.org.update({ where: { id: org.id }, data: { linkSecret: "" } });
    await prisma.agentPolicy.create({ data: policyData(org.id) });
    const load = await seedLoad(org.id);

    const token = orgTokenFor({ id: org.id, linkSecret: "" });
    const res = await request(app).get(`/api/n/${token}/loads/${load.id}/agent`);
    expect(res.status).toBe(404);
  });

  it("a freshly created org gets a real linkSecret from the database, not an empty string", async () => {
    const org = await prisma.org.create({ data: { name: "FreshOrg" } });
    expect(org.linkSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  // Minor (final fix wave): the deep link's policy carries no dispatcher
  // contact details — a URL in an SMS must not leak the boss's phone/email.
  it("the timeline's policy is { id, name, shadow } only — no dispatcherEmail/dispatcherPhone", async () => {
    const org = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id, { dispatcherPhone: "+15550001111" }) });
    const load = await seedLoad(org.id);

    const res = await request(app).get(`/api/n/${orgTokenFor(org)}/loads/${load.id}/agent`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.policy).sort()).toEqual(["id", "name", "shadow"]);
    expect(JSON.stringify(res.body)).not.toContain("ops@acme.com");
    expect(JSON.stringify(res.body)).not.toContain("+15550001111");
  });

  // Minor (final fix wave): the phone page's header shows the board's LOAD#.
  it("the timeline carries boardLoadNo so the link page can show LOAD#, not the uuid", async () => {
    const org = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id) });
    const load = await seedLoad(org.id, { boardLoadNo: "145219" });

    const res = await request(app).get(`/api/n/${orgTokenFor(org)}/loads/${load.id}/agent`);
    expect(res.status).toBe(200);
    expect(res.body.boardLoadNo).toBe("145219");
  });

  it("a token naming an org that does not exist 404s", async () => {
    const load = await seedLoad((await seedOrg()).id);
    const res = await request(app).get(`/api/n/deadbeefdeadbeefdeadbeefdeadbeef.does-not-exist/loads/${load.id}/agent`);
    expect(res.status).toBe(404);
  });

  it("an unknown load id 404s even with a genuinely valid token", async () => {
    const org = await seedOrg();
    const token = orgTokenFor(org);
    const res = await request(app).get(`/api/n/${token}/loads/does-not-exist/agent`);
    expect(res.status).toBe(404);
  });

  it("no switch route exists under /api/n — POST the switch path 404s (the route does not exist)", async () => {
    const org = await seedOrg();
    await prisma.agentPolicy.create({ data: policyData(org.id) });
    const load = await seedLoad(org.id);
    const token = orgTokenFor(org);

    const res = await request(app).post(`/api/n/${token}/loads/${load.id}/agent`).send({ enabled: true });

    expect(res.status).toBe(404);
  });
});

// --- POST /api/n/:orgToken/loads/:id/agent/commands -------------------------

describe("POST /api/n/:orgToken/loads/:id/agent/commands", () => {
  it("queues a takeover command with actorName 'link' and answers 202", async () => {
    const org = await seedOrg();
    const load = await seedLoad(org.id);
    const token = orgTokenFor(org);

    const res = await request(app).post(`/api/n/${token}/loads/${load.id}/agent/commands`).send({ kind: "takeover" });

    expect(res.status).toBe(202);
    expect(res.body.command).toMatchObject({ kind: "takeover", actorName: "link" });
    const rows = await prisma.agentCommand.findMany({ where: { loadId: load.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "takeover", actorName: "link" });
  });

  it("a load belonging to another org 404s, never 403s", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const loadB = await seedLoad(orgB.id);
    const tokenA = orgTokenFor(orgA);

    const res = await request(app).post(`/api/n/${tokenA}/loads/${loadB.id}/agent/commands`).send({ kind: "takeover" });

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    const rows = await prisma.agentCommand.findMany({ where: { loadId: loadB.id } });
    expect(rows).toHaveLength(0);
  });

  it("a tampered token 404s and writes nothing", async () => {
    const org = await seedOrg();
    const load = await seedLoad(org.id);
    const [digest, orgId] = orgTokenFor(org).split(".");
    const tampered = `${digest!.split("").reverse().join("")}.${orgId}`;

    const res = await request(app).post(`/api/n/${tampered}/loads/${load.id}/agent/commands`).send({ kind: "takeover" });

    expect(res.status).toBe(404);
    const rows = await prisma.agentCommand.findMany({ where: { loadId: load.id } });
    expect(rows).toHaveLength(0);
  });

  it("rejects a kind outside the vocabulary with 400", async () => {
    const org = await seedOrg();
    const load = await seedLoad(org.id);
    const token = orgTokenFor(org);

    const res = await request(app).post(`/api/n/${token}/loads/${load.id}/agent/commands`).send({ kind: "bogus" });

    expect(res.status).toBe(400);
  });

  it("accepts every kind in the drawer's vocabulary, same as the dispatcher route", async () => {
    const org = await seedOrg();
    const load = await seedLoad(org.id);
    const token = orgTokenFor(org);
    const kinds = ["stop", "call", "reply", "correct", "takeover", "handback", "send_customer_email"];

    for (const kind of kinds) {
      const res = await request(app).post(`/api/n/${token}/loads/${load.id}/agent/commands`).send({ kind });
      expect(res.status).toBe(202);
    }
    const rows = await prisma.agentCommand.findMany({ where: { loadId: load.id } });
    expect(rows.map((r) => r.kind).sort()).toEqual([...kinds].sort());
  });
});
