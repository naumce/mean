import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { rateConfigForDriver } from "../src/lib/rateConfig.js";

// T1 Carrier Layer, Task 4 — CRUD for the entities a dispatch service
// dispatches trucks for. Every case below is either a tenancy check (a
// foreign carrier must be invisible/unreachable, never merely undercounted)
// or a cost-model check (the null-means-inherit contract src/lib/rateConfig.ts
// depends on, and the mpg<=0 refusal that keeps a broken cost model from ever
// reaching computeEconomics's division).

beforeEach(resetDb);

async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

describe("carrier CRUD", () => {
  it("creates a carrier for the caller's org", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);

    const res = await request(app).post("/api/dispatcher/carriers").set("authorization", auth)
      .send({ name: "Carrier One", mcNumber: "MC123", dotNumber: "DOT456" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Carrier One");
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.status).toBe("active"); // schema default when omitted
  });

  it("rejects creating a carrier without an org-scoped dispatcher account", async () => {
    // Carrier.orgId is NOT nullable (unlike Driver/Vehicle), so there is no
    // "orgless carrier" convention to fall back on the way POST /drivers has.
    const disp = await createDispatcher({ email: "legacy@x.com" });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

    const res = await request(app).post("/api/dispatcher/carriers").set("authorization", auth)
      .send({ name: "Orgless" });
    expect(res.status).toBe(400);
  });

  it("GET /carriers returns only the caller's org's carriers - a foreign carrier is absent, not merely undercounted", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const carrierB = await prisma.carrier.create({ data: { orgId: orgB.id, name: "Beta Carrier" } });
    const authA = await scopedAuth(orgA.id);
    const created = await request(app).post("/api/dispatcher/carriers").set("authorization", authA)
      .send({ name: "Alpha Carrier" });

    const list = await request(app).get("/api/dispatcher/carriers").set("authorization", authA);
    expect(list.status).toBe(200);
    const ids = list.body.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(carrierB.id);
    expect(ids).toContain(created.body.id);
  });

  it("returns 404 for an unknown carrier id", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).patch("/api/dispatcher/carriers/does-not-exist")
      .set("authorization", auth).send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects mpg: 0 on create with a stated reason", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).post("/api/dispatcher/carriers").set("authorization", auth)
      .send({ name: "Broken Carrier", mpg: 0 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/mpg/i);
  });

  it("rejects mpg: 0 on PATCH with a stated reason", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "C" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).patch(`/api/dispatcher/carriers/${carrier.id}`)
      .set("authorization", auth).send({ mpg: 0 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/mpg/i);
  });

  it("rejects a negative mpg and a negative money field", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const negMpg = await request(app).post("/api/dispatcher/carriers").set("authorization", auth)
      .send({ name: "X", mpg: -6 });
    expect(negMpg.status).toBe(400);
    const negMoney = await request(app).post("/api/dispatcher/carriers").set("authorization", auth)
      .send({ name: "Y", driverPayCentsPerMi: -1 });
    expect(negMoney.status).toBe(400);
  });

  it("cost fields sent as null persist as null, and a driver of that carrier then prices at the org's values", async () => {
    const org = await prisma.org.create({
      data: { name: "Acme", mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45 },
    });
    const auth = await scopedAuth(org.id);

    // Only driverPayCentsPerMi is set; mpg/dieselCentsPerGal/fixedCentsPerMi
    // are OMITTED from the request body entirely (not sent as null) - this
    // also proves POST leaves an unspecified cost field at its natural null,
    // not a stripped/defaulted-to-zero value.
    const create = await request(app).post("/api/dispatcher/carriers").set("authorization", auth)
      .send({ name: "Partial Carrier", driverPayCentsPerMi: 90 });
    expect(create.status).toBe(201);
    expect(create.body.mpg).toBeNull();
    expect(create.body.dieselCentsPerGal).toBeNull();
    expect(create.body.fixedCentsPerMi).toBeNull();
    expect(create.body.driverPayCentsPerMi).toBe(90);

    const driver = await prisma.driver.create({
      data: { email: "carrier-driver@x.com", passwordHash: "x", name: "CD", orgId: org.id, carrierId: create.body.id },
    });

    // Tied directly to the one function that owns carrier-vs-org resolution
    // (src/lib/rateConfig.ts) rather than re-deriving the rule here.
    const resolved = await rateConfigForDriver(driver.id);
    expect(resolved).toEqual({ mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 90, fixedCentsPerMi: 45 });
  });

  it("PATCHing a cost field to explicit null clears a previously-set value back to inherit", async () => {
    const org = await prisma.org.create({
      data: { name: "Acme", mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45 },
    });
    const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "C", driverPayCentsPerMi: 90 } });
    const auth = await scopedAuth(org.id);

    const patch = await request(app).patch(`/api/dispatcher/carriers/${carrier.id}`)
      .set("authorization", auth).send({ driverPayCentsPerMi: null });
    expect(patch.status).toBe(200);
    expect(patch.body.driverPayCentsPerMi).toBeNull();

    const reread = await prisma.carrier.findUniqueOrThrow({ where: { id: carrier.id } });
    expect(reread.driverPayCentsPerMi).toBeNull();

    const driver = await prisma.driver.create({
      data: { email: "carrier-driver-2@x.com", passwordHash: "x", name: "CD2", orgId: org.id, carrierId: carrier.id },
    });
    // Cleared field must inherit the org's, not price at zero.
    const resolved = await rateConfigForDriver(driver.id);
    expect(resolved.driverPayCentsPerMi).toBe(60);
  });

  it("an omitted cost field on PATCH leaves the existing value untouched", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const carrier = await prisma.carrier.create({
      data: { orgId: org.id, name: "C", mpg: 5.8, driverPayCentsPerMi: 72 },
    });
    const auth = await scopedAuth(org.id);

    // Cost fields are not mentioned in the body at all - only name changes.
    const patch = await request(app).patch(`/api/dispatcher/carriers/${carrier.id}`)
      .set("authorization", auth).send({ name: "Renamed" });
    expect(patch.status).toBe(200);
    expect(patch.body.name).toBe("Renamed");
    expect(patch.body.mpg).toBe(5.8);
    expect(patch.body.driverPayCentsPerMi).toBe(72);
  });

  it("cross-org PATCH 404s and leaves the row unchanged when re-read", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const carrierB = await prisma.carrier.create({
      data: { orgId: orgB.id, name: "Beta Original", driverPayCentsPerMi: 60 },
    });
    const authA = await scopedAuth(orgA.id);

    const res = await request(app).patch(`/api/dispatcher/carriers/${carrierB.id}`)
      .set("authorization", authA).send({ name: "HIJACKED", driverPayCentsPerMi: 999 });

    // Data assertion FIRST: reverting the guard must fail here, on "the
    // write landed", not merely on the status line below.
    const after = await prisma.carrier.findUniqueOrThrow({ where: { id: carrierB.id } });
    expect(after.name).toBe("Beta Original");
    expect(after.driverPayCentsPerMi).toBe(60);
    expect(res.status).toBe(404);
  });
});
