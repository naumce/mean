import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

beforeEach(resetDb);

const DAY_MS = 24 * 60 * 60 * 1000;

async function orgScopedDispatcher(name = "Acme", email = "d@x.com") {
  const org = await prisma.org.create({ data: { name } });
  await prisma.dispatcher.create({ data: {
    email, passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email, password: "secret123" });
  return { org, token: login.body.token as string };
}

it("lists units and drivers with their compliance clocks, org-scoped", async () => {
  const { org, token } = await orgScopedDispatcher();
  const soon = new Date(Date.now() + 10 * DAY_MS);
  await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active", inspectionExpiresAt: soon } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-1", type: "DryVan", status: "active", nextServiceAt: soon } });
  await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id, medicalCertExpiresAt: soon } });

  const rival = await prisma.org.create({ data: { name: "Rival" } });
  await prisma.tractor.create({ data: { orgId: rival.id, unit: "R-1", status: "active" } });

  const res = await request(app).get("/api/dispatcher/fleet").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.tractors).toHaveLength(1);
  expect(res.body.tractors[0].inspectionExpiresAt).toBe(soon.toISOString());
  expect(res.body.trailers[0].nextServiceAt).toBe(soon.toISOString());
  expect(res.body.drivers[0].medicalCertExpiresAt).toBe(soon.toISOString());
});

it("registers a shop (geocoding the address) and logs a record that refreshes the unit's clock", async () => {
  const { org, token } = await orgScopedDispatcher();
  const auth = `Bearer ${token}`;
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });

  const shopRes = await request(app).post("/api/dispatcher/fleet/services").set("authorization", auth)
    .send({ name: "KC Truck Center", address: "Kansas City, MO", phone: "816-555-0101" });
  expect(shopRes.status).toBe(201);
  expect(shopRes.body.lat).toBeCloseTo(39.0997, 2); // offline gazetteer hit

  const nextDue = new Date(Date.now() + 365 * DAY_MS).toISOString();
  const recRes = await request(app).post("/api/dispatcher/fleet/records").set("authorization", auth)
    .send({ shopId: shopRes.body.id, tractorId: tractor.id, kind: "inspection", nextDueAt: nextDue, notes: "annual DOT" });
  expect(recRes.status).toBe(201);

  // The ledger entry IS the clock refresh — the engine checks this field.
  const fresh = await prisma.tractor.findUniqueOrThrow({ where: { id: tractor.id } });
  expect(fresh.inspectionExpiresAt?.toISOString()).toBe(nextDue);

  const history = await request(app).get(`/api/dispatcher/fleet/records?tractorId=${tractor.id}`)
    .set("authorization", auth);
  expect(history.body.records).toHaveLength(1);
  expect(history.body.records[0].shopName).toBe("KC Truck Center");
  expect(history.body.records[0].unit).toBe("Tractor #1207");
});

it("digest surfaces expired and 30-day items worst-first, ignoring healthy clocks", async () => {
  const { org, token } = await orgScopedDispatcher();
  await prisma.tractor.create({ data: {
    orgId: org.id, unit: "1212", status: "active",
    inspectionExpiresAt: new Date(Date.now() + 6 * DAY_MS),   // due soon
    registrationExpiresAt: new Date(Date.now() + 200 * DAY_MS), // healthy — excluded
  } });
  await prisma.trailer.create({ data: {
    orgId: org.id, unit: "FB-1", type: "Flatbed", status: "active",
    registrationExpiresAt: new Date(Date.now() - 12 * DAY_MS), // expired
  } });
  await prisma.driver.create({ data: {
    email: "s@x.com", passwordHash: "x", name: "Sam", orgId: org.id,
    medicalCertExpiresAt: new Date(Date.now() + 20 * DAY_MS),
  } });

  const res = await request(app).get("/api/dispatcher/fleet/digest").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.expiredCount).toBe(1);
  expect(res.body.dueSoonCount).toBe(2);
  expect(res.body.items).toHaveLength(3); // the 200-day registration stays out
  expect(res.body.items[0]).toMatchObject({ label: "Trailer FB-1", kind: "registration", expired: true });
  expect(res.body.items[1].label).toBe("Tractor #1212"); // 6d before Sam's 20d
});

it("validates exactly one unit per record and hides cross-org shops as 404", async () => {
  const { org, token } = await orgScopedDispatcher();
  const auth = `Bearer ${token}`;
  const shop = await prisma.serviceShop.create({ data: { orgId: org.id, name: "Shop", address: "x" } });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "T", status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "V", type: "DryVan", status: "active" } });

  const both = await request(app).post("/api/dispatcher/fleet/records").set("authorization", auth)
    .send({ shopId: shop.id, tractorId: tractor.id, trailerId: trailer.id, kind: "service" });
  expect(both.status).toBe(400);

  const { token: rivalToken } = await orgScopedDispatcher("Rival", "r@x.com");
  const foreign = await request(app).post("/api/dispatcher/fleet/records")
    .set("authorization", `Bearer ${rivalToken}`)
    .send({ shopId: shop.id, tractorId: tractor.id, kind: "service" });
  expect(foreign.status).toBe(404);
});
