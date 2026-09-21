import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

async function seedOrgWithConflicts() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({
    data: { email: "d@x.com", passwordHash: "x", name: "Jake", orgId: org.id },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-9", requiredEquip: "DryVan", status: "assigned",
      stops: { create: [{ sequence: 1, type: "pickup", address: "A" }] },
    },
  });
  await prisma.dispatchConflict.createMany({
    data: [
      { orgId: org.id, loadId: load.id, driverId: driver.id, kind: "hos", severity: "warn", detail: "HOS not imported" },
      { orgId: org.id, loadId: load.id, driverId: driver.id, kind: "equipment", severity: "block", detail: "forced past wrong trailer" },
    ],
  });
  return { org, driver, load };
}

it("returns the org's conflicts newest-first with load + driver context", async () => {
  const { org } = await seedOrgWithConflicts();
  const disp = await prisma.dispatcher.create({ data: { email: "disp@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

  const res = await request(app).get("/api/dispatcher/alerts").set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.alerts).toHaveLength(2);
  const alert = res.body.alerts.find((a: { kind: string }) => a.kind === "equipment");
  expect(alert.severity).toBe("block");
  expect(alert.loadReference).toBe("L-9");
  expect(alert.driverName).toBe("Jake");
});

it("does not leak another org's conflicts", async () => {
  await seedOrgWithConflicts();
  const other = await prisma.org.create({ data: { name: "Other" } });
  const disp = await prisma.dispatcher.create({ data: { email: "o@x.com", passwordHash: "x", name: "O", orgId: other.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

  const res = await request(app).get("/api/dispatcher/alerts").set("authorization", auth);
  expect(res.body.alerts).toHaveLength(0);
});

it("respects the limit param and rejects a bad one", async () => {
  const { org } = await seedOrgWithConflicts();
  const disp = await prisma.dispatcher.create({ data: { email: "disp2@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

  const one = await request(app).get("/api/dispatcher/alerts?limit=1").set("authorization", auth);
  expect(one.body.alerts).toHaveLength(1);
  const bad = await request(app).get("/api/dispatcher/alerts?limit=0").set("authorization", auth);
  expect(bad.status).toBe(400);
});
