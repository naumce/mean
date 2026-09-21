import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

async function scopedAuth() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const disp = await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  return { org, auth: `Bearer ${signDispatcherAccess(disp.id)}` };
}

const goodLoadRow = {
  externalId: "L-100", requiredEquip: "Reefer", revenueCents: 34000, fscCents: 4000,
  pickupAddress: "Kansas City, MO", pickupLat: 39.0997, pickupLng: -94.5786,
  pickupWindowEnd: "2027-01-01T00:00:00.000Z",
  deliveryAddress: "Omaha, NE", deliveryLat: 41.2565, deliveryLng: -95.9345,
  deliveryWindowEnd: "2027-01-02T00:00:00.000Z",
};

it("imports JSON load rows, creating stops + appointments + an audit batch", async () => {
  const { org, auth } = await scopedAuth();
  const res = await request(app).post("/api/dispatcher/import/loads").set("authorization", auth)
    .send({ rows: [goodLoadRow] });

  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  expect(res.body.errors).toEqual([]);

  const load = await prisma.load.findFirst({
    where: { orgId: org.id, externalId: "L-100" },
    include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } },
  });
  expect(load?.requiredEquip).toBe("Reefer");
  expect(load?.stops).toHaveLength(2);
  expect(load?.stops[0].appointment?.type).toBe("pickup");

  const batch = await prisma.importBatch.findUnique({ where: { id: res.body.batchId } });
  expect(batch?.entity).toBe("loads");
  expect(batch?.source).toBe("api");
  expect(batch?.rows).toBe(1);
});

it("imports CSV loads and reports bad rows without failing good ones", async () => {
  const { auth } = await scopedAuth();
  const csv = [
    "externalId,requiredEquip,revenueCents,pickupAddress,deliveryAddress",
    'L-201,DryVan,30000,"Memphis, TN","Little Rock, AR"',
    "L-202,Spaceship,10,A,B", // invalid equipment
  ].join("\n");

  const res = await request(app).post("/api/dispatcher/import/loads").set("authorization", auth).send({ csv });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  expect(res.body.errors).toHaveLength(1);
  expect(res.body.errors[0].row).toBe(2);
  expect(res.body.errors[0].error).toContain("requiredEquip");

  const batch = await prisma.importBatch.findUnique({ where: { id: res.body.batchId } });
  expect(batch?.source).toBe("csv");
  expect(JSON.parse(batch?.errors ?? "[]")).toHaveLength(1);
});

it("re-import replaces an open load's stops but refuses an assigned one", async () => {
  const { auth } = await scopedAuth();
  await request(app).post("/api/dispatcher/import/loads").set("authorization", auth).send({ rows: [goodLoadRow] });

  // Re-import with a new delivery address: replaced.
  const updated = { ...goodLoadRow, deliveryAddress: "Des Moines, IA" };
  const second = await request(app).post("/api/dispatcher/import/loads").set("authorization", auth).send({ rows: [updated] });
  expect(second.body.imported).toBe(1);
  const load = await prisma.load.findFirst({ where: { externalId: "L-100" }, include: { stops: { orderBy: { sequence: "asc" } } } });
  expect(load?.stops[1].address).toBe("Des Moines, IA");
  expect(await prisma.load.count({ where: { externalId: "L-100" } })).toBe(1); // reconciliation, not duplication

  // Mark assigned -> re-import is refused.
  await prisma.load.update({ where: { id: load!.id }, data: { status: "assigned" } });
  const third = await request(app).post("/api/dispatcher/import/loads").set("authorization", auth).send({ rows: [goodLoadRow] });
  expect(third.body.imported).toBe(0);
  expect(third.body.errors[0].error).toContain("already assigned");
});

it("imports drivers (upsert by email, position folded in) without enabling login", async () => {
  const { org, auth } = await scopedAuth();
  const res = await request(app).post("/api/dispatcher/import/drivers").set("authorization", auth).send({
    rows: [
      { email: "jake@x.com", name: "Jake", hazmatEndorsed: true, lat: 39.1, lng: -94.6 },
      { email: "not-an-email", name: "Bad" },
    ],
  });
  expect(res.body.imported).toBe(1);
  expect(res.body.errors).toHaveLength(1);

  const driver = await prisma.driver.findUnique({ where: { email: "jake@x.com" } });
  expect(driver?.orgId).toBe(org.id);
  expect(driver?.hazmatEndorsed).toBe(true);
  expect(driver?.lastLat).toBeCloseTo(39.1);
  expect(driver?.passwordHash).toBe("!imported-no-login!");
});

it("imports HOS onto an org driver and rejects unknown drivers", async () => {
  const { org, auth } = await scopedAuth();
  await prisma.driver.create({ data: { email: "jake@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });

  const csv = [
    "email,driveRemainingMin,windowRemainingMin,cycleRemainingMin,minutesSinceBreak",
    "jake@x.com,300,500,2000,120",
    "ghost@x.com,600,800,4000,0",
  ].join("\n");
  const res = await request(app).post("/api/dispatcher/import/hos").set("authorization", auth).send({ csv });
  expect(res.body.imported).toBe(1);
  expect(res.body.errors[0].error).toContain("ghost@x.com");

  const driver = await prisma.driver.findUnique({ where: { email: "jake@x.com" }, include: { hos: true } });
  expect(driver?.hos?.driveRemainingMin).toBe(300);
  expect(driver?.hos?.minutesSinceBreak).toBe(120);
  // Real clock data arrived -> the freshness stamp is set.
  expect(driver?.hos?.importedAt).not.toBeNull();
});

it("requires an org-scoped dispatcher and a valid body shape", async () => {
  const disp = await prisma.dispatcher.create({ data: { email: "legacy@x.com", passwordHash: "x", name: "L" } });
  const legacyAuth = `Bearer ${signDispatcherAccess(disp.id)}`;
  const unscoped = await request(app).post("/api/dispatcher/import/loads").set("authorization", legacyAuth)
    .send({ rows: [goodLoadRow] });
  expect(unscoped.status).toBe(400);

  const { auth } = await scopedAuth();
  const badBody = await request(app).post("/api/dispatcher/import/loads").set("authorization", auth).send({ nope: 1 });
  expect(badBody.status).toBe(400);
});

it("an all-bad import returns 422 and audits 0 rows", async () => {
  const { auth } = await scopedAuth();
  const res = await request(app).post("/api/dispatcher/import/loads").set("authorization", auth)
    .send({ rows: [{ externalId: "", requiredEquip: "DryVan", pickupAddress: "", deliveryAddress: "" }] });
  expect(res.status).toBe(422);
  expect(res.body.imported).toBe(0);
  const batch = await prisma.importBatch.findUnique({ where: { id: res.body.batchId } });
  expect(batch?.rows).toBe(0);
});
