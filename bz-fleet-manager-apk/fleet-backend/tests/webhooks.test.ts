import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
beforeEach(resetDb);

const GOOD_LOAD = {
  externalId: "L-WH-1", requiredEquip: "DryVan", revenueCents: 45000,
  pickupAddress: "Kansas City, MO", pickupLat: 39.0997, pickupLng: -94.5786,
  deliveryAddress: "Omaha, NE", deliveryLat: 41.2565, deliveryLng: -95.9345,
};

async function seedOrgWithKey(key = "whk_test_key_1") {
  return prisma.org.create({ data: { name: "Acme", apiKey: key } });
}

it("rejects a missing or invalid API key with 401", async () => {
  await seedOrgWithKey();
  const noKey = await request(app).post("/api/webhooks/loads").send(GOOD_LOAD);
  expect(noKey.status).toBe(401);
  const badKey = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_wrong").send(GOOD_LOAD);
  expect(badKey.status).toBe(401);
});

it("ingests a single load object into the key's org and audits the batch", async () => {
  const org = await seedOrgWithKey();
  const res = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1").send(GOOD_LOAD);
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  expect(res.body.errors).toEqual([]);

  const load = await prisma.load.findFirst({ where: { externalId: "L-WH-1" }, include: { stops: true } });
  expect(load?.orgId).toBe(org.id);
  expect(load?.status).toBe("open");
  expect(load?.stops).toHaveLength(2);

  const batch = await prisma.importBatch.findFirst({ where: { orgId: org.id } });
  expect(batch?.source).toBe("webhook");
});

it("accepts an array and {loads:[...]}, reporting per-row errors", async () => {
  await seedOrgWithKey();
  const arr = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1")
    .send([GOOD_LOAD, { externalId: "L-BAD", requiredEquip: "Spaceship", pickupAddress: "A", deliveryAddress: "B" }]);
  expect(arr.status).toBe(200);
  expect(arr.body.imported).toBe(1);
  expect(arr.body.errors).toHaveLength(1);
  expect(arr.body.errors[0].error).toContain("requiredEquip");

  const wrapped = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1")
    .send({ loads: [{ ...GOOD_LOAD, externalId: "L-WH-2" }] });
  expect(wrapped.status).toBe(200);
  expect(wrapped.body.imported).toBe(1);
});

it("re-pushing an open load reconciles it; an assigned load is refused per-row", async () => {
  const org = await seedOrgWithKey();
  await request(app).post("/api/webhooks/loads").set("x-api-key", "whk_test_key_1").send(GOOD_LOAD);

  const update = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1").send({ ...GOOD_LOAD, revenueCents: 52000 });
  expect(update.status).toBe(200);
  const load = await prisma.load.findFirst({ where: { orgId: org.id, externalId: "L-WH-1" } });
  expect(load?.revenueCents).toBe(52000);
  expect(await prisma.load.count({ where: { orgId: org.id } })).toBe(1);

  await prisma.load.update({ where: { id: load!.id }, data: { status: "assigned" } });
  const refused = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1").send({ ...GOOD_LOAD, revenueCents: 1 });
  expect(refused.status).toBe(422);
  expect(refused.body.errors[0].error).toContain("already assigned");
});

it("caps a batch at 500 rows with a clear 400", async () => {
  await seedOrgWithKey();
  const rows = Array.from({ length: 501 }, (_, i) => ({ ...GOOD_LOAD, externalId: `L-${i}` }));
  const res = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1").send(rows);
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("max 500");
  expect(await prisma.load.count()).toBe(0);
});

it("all-bad payloads return 422; empty payloads 400", async () => {
  await seedOrgWithKey();
  const bad = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1").send({ externalId: "L-X" });
  expect(bad.status).toBe(422);
  const empty = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", "whk_test_key_1").send([]);
  expect(empty.status).toBe(400);
});

it("keys are tenant-fenced: org A's key never writes into org B", async () => {
  await seedOrgWithKey("whk_org_a");
  const orgB = await prisma.org.create({ data: { name: "B Corp", apiKey: "whk_org_b" } });
  await request(app).post("/api/webhooks/loads").set("x-api-key", "whk_org_a").send(GOOD_LOAD);
  expect(await prisma.load.count({ where: { orgId: orgB.id } })).toBe(0);
});

// --- key management ----------------------------------------------------------

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

it("GET returns null before generation; POST creates then rotates the key", async () => {
  const { org, token } = await orgScopedDispatcher();

  const before = await request(app).get("/api/dispatcher/integrations/webhook-key")
    .set("authorization", `Bearer ${token}`);
  expect(before.status).toBe(200);
  expect(before.body.apiKey).toBeNull();
  expect(before.body.url).toBe("/api/webhooks/loads");

  const created = await request(app).post("/api/dispatcher/integrations/webhook-key")
    .set("authorization", `Bearer ${token}`);
  expect(created.status).toBe(201);
  expect(created.body.apiKey).toMatch(/^whk_/);

  const rotated = await request(app).post("/api/dispatcher/integrations/webhook-key")
    .set("authorization", `Bearer ${token}`);
  expect(rotated.body.apiKey).not.toBe(created.body.apiKey);

  // The rotated-out key is dead immediately; the new one works.
  const oldKey = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", created.body.apiKey).send(GOOD_LOAD);
  expect(oldKey.status).toBe(401);
  const newKey = await request(app).post("/api/webhooks/loads")
    .set("x-api-key", rotated.body.apiKey).send(GOOD_LOAD);
  expect(newKey.status).toBe(200);
  expect((await prisma.load.findFirst({ where: { externalId: "L-WH-1" } }))?.orgId).toBe(org.id);
});

it("key endpoints require an org-scoped dispatcher (400 unscoped, 401 anon)", async () => {
  await prisma.dispatcher.create({ data: {
    email: "legacy@x.com", passwordHash: await hashPassword("secret123"), name: "L",
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "legacy@x.com", password: "secret123" });
  const unscoped = await request(app).get("/api/dispatcher/integrations/webhook-key")
    .set("authorization", `Bearer ${login.body.token}`);
  expect(unscoped.status).toBe(400);

  const anon = await request(app).get("/api/dispatcher/integrations/webhook-key");
  expect(anon.status).toBe(401);
});
