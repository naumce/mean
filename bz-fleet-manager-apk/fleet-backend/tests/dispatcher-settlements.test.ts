import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

beforeEach(resetDb);

const DAY_MS = 24 * 60 * 60 * 1000;

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

async function completedRun(orgId: string, driverId: string, completedAt: Date, econ: {
  linehaul: number; loadedMi: number; deadheadMi?: number; cost?: number;
}) {
  const deadheadMi = econ.deadheadMi ?? 0;
  const cost = econ.cost ?? 0;
  return prisma.load.create({ data: {
    orgId, requiredEquip: "DryVan", status: "delivered", revenueCents: econ.linehaul,
    rate: { create: {
      linehaulCents: econ.linehaul, fscCents: 0, totalMi: econ.loadedMi + deadheadMi,
      loadedMi: econ.loadedMi, deadheadMi, ratePerLoadedMiCents: 0,
      estCostCents: cost, marginCents: econ.linehaul - cost,
    } },
    assignment: { create: {
      orgId, driverId, status: "completed", completedAt,
      plannedStart: new Date(completedAt.getTime() - 8 * 3600_000), plannedEnd: completedAt,
    } },
  } });
}

async function driver(orgId: string, tag: string) {
  return prisma.driver.create({ data: { email: `${tag}@x.com`, passwordHash: "x", name: `Driver ${tag}`, orgId } });
}

it("rolls completed work up per driver with pay at the org's configured rate", async () => {
  const { org, token } = await orgScopedDispatcher();
  await prisma.org.update({ where: { id: org.id }, data: { driverPayCentsPerMi: 70 } });
  const jake = await driver(org.id, "jake");
  const maya = await driver(org.id, "maya");
  const now = Date.now();

  await completedRun(org.id, jake.id, new Date(now - 2 * DAY_MS), { linehaul: 50000, loadedMi: 180, deadheadMi: 20, cost: 30000 });
  await completedRun(org.id, jake.id, new Date(now - 1 * DAY_MS), { linehaul: 30000, loadedMi: 100, cost: 20000 });
  await completedRun(org.id, maya.id, new Date(now - 3 * DAY_MS), { linehaul: 40000, loadedMi: 150, cost: 25000 });

  const res = await request(app).get("/api/dispatcher/settlements").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  // No top-level driverPayCentsPerMi any more (T1 I3 fix): with per-carrier
  // rates there is no single number for the whole response. Neither driver
  // here has a carrier, so both rows resolve to the org's 70c/mi — asserted
  // per row below instead of once at the top.
  expect(res.body.driverPayCentsPerMi).toBeUndefined();
  expect(res.body.drivers).toHaveLength(2);

  const [top, second] = res.body.drivers; // revenue desc
  expect(top.driverName).toBe("Driver jake");
  expect(top.loads).toBe(2);
  expect(top.totalMi).toBe(300);
  expect(top.revenueCents).toBe(80000);
  expect(top.marginCents).toBe(30000);
  expect(top.driverPayCentsPerMi).toBe(70);
  expect(top.estPayCents).toBe(300 * 70);
  expect(second.driverName).toBe("Driver maya");
  expect(second.driverPayCentsPerMi).toBe(70);
  expect(res.body.totals.loads).toBe(3);
  expect(res.body.totals.estPayCents).toBe(300 * 70 + 150 * 70);
});

it("prices each driver's estPayCents at their OWN carrier's rate, so it never contradicts marginCents", async () => {
  // T1 I3: the reviewer found dispatcherSettlements.ts summing marginCents
  // from the (now carrier-priced) Rate snapshot but computing estPayCents
  // from the org's rate alone — a driver on a carrier that pays differently
  // than the org got a margin and an estimated pay that disagreed inside one
  // JSON object. Two drivers on two carriers with different pay rates,
  // completing loads with the SAME committed margin math (completedRun's
  // `cost` param IS the committed estCostCents, independent of any rate
  // config) — so estPayCents must move with each driver's own carrier while
  // marginCents stays exactly what was committed.
  const { org, token } = await orgScopedDispatcher();
  await prisma.org.update({ where: { id: org.id }, data: { driverPayCentsPerMi: 60 } });
  const carrierA = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier A", driverPayCentsPerMi: 60 },
  });
  const carrierB = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier B", driverPayCentsPerMi: 90 },
  });
  const driverA = await prisma.driver.create({
    data: { email: "a@x.com", passwordHash: "x", name: "Driver A", orgId: org.id, carrierId: carrierA.id },
  });
  const driverB = await prisma.driver.create({
    data: { email: "b@x.com", passwordHash: "x", name: "Driver B", orgId: org.id, carrierId: carrierB.id },
  });
  const now = Date.now();
  // Same committed cost/margin for both — only the LIVE carrier rate used to
  // estimate pay should differ between them.
  await completedRun(org.id, driverA.id, new Date(now - DAY_MS), { linehaul: 50000, loadedMi: 200, cost: 30000 });
  await completedRun(org.id, driverB.id, new Date(now - DAY_MS), { linehaul: 50000, loadedMi: 200, cost: 30000 });

  const res = await request(app).get("/api/dispatcher/settlements").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  const rowA = res.body.drivers.find((d: { driverName: string }) => d.driverName === "Driver A");
  const rowB = res.body.drivers.find((d: { driverName: string }) => d.driverName === "Driver B");

  // Same committed margin — the snapshot never moves with the carrier's rate.
  expect(rowA.marginCents).toBe(20000);
  expect(rowB.marginCents).toBe(20000);

  // Different estimated pay, each at its OWN carrier's rate — no longer one
  // shared number that would put Driver B's margin next to Driver A's pay.
  expect(rowA.driverPayCentsPerMi).toBe(60);
  expect(rowB.driverPayCentsPerMi).toBe(90);
  expect(rowA.estPayCents).toBe(200 * 60);
  expect(rowB.estPayCents).toBe(200 * 90);
  expect(rowA.estPayCents).not.toBe(rowB.estPayCents);
});

it("buckets strictly by completion date and never counts another org", async () => {
  const { org, token } = await orgScopedDispatcher();
  const jake = await driver(org.id, "jake");
  const now = Date.now();
  await completedRun(org.id, jake.id, new Date(now - 10 * DAY_MS), { linehaul: 90000, loadedMi: 400 }); // outside default week
  await completedRun(org.id, jake.id, new Date(now - DAY_MS), { linehaul: 30000, loadedMi: 100 });

  const rival = await prisma.org.create({ data: { name: "Rival" } });
  const rex = await driver(rival.id, "rex");
  await completedRun(rival.id, rex.id, new Date(now - DAY_MS), { linehaul: 70000, loadedMi: 250 });

  const res = await request(app).get("/api/dispatcher/settlements").set("authorization", `Bearer ${token}`);
  expect(res.body.drivers).toHaveLength(1);
  expect(res.body.drivers[0].revenueCents).toBe(30000);

  // Widen the window and the older run appears.
  const wide = await request(app)
    .get(`/api/dispatcher/settlements?from=${new Date(now - 14 * DAY_MS).toISOString()}`)
    .set("authorization", `Bearer ${token}`);
  expect(wide.body.drivers[0].loads).toBe(2);
});

it("rejects an inverted range and exports CSV with a TOTAL row", async () => {
  const { org, token } = await orgScopedDispatcher();
  const jake = await driver(org.id, "jake");
  await completedRun(org.id, jake.id, new Date(Date.now() - DAY_MS), { linehaul: 30000, loadedMi: 100, cost: 20000 });

  const bad = await request(app)
    .get(`/api/dispatcher/settlements?from=${new Date().toISOString()}&to=${new Date(Date.now() - DAY_MS).toISOString()}`)
    .set("authorization", `Bearer ${token}`);
  expect(bad.status).toBe(400);

  const csv = await request(app).get("/api/dispatcher/settlements?format=csv")
    .set("authorization", `Bearer ${token}`);
  expect(csv.headers["content-disposition"]).toContain('filename="driver-settlements.csv"');
  const lines = csv.text.trim().split("\r\n");
  expect(lines[0]).toBe("driver,loads,loaded_mi,deadhead_mi,total_mi,revenue_usd,margin_usd,est_pay_usd,rpm_loaded_usd");
  expect(lines[1]).toContain("Driver jake,1,100.0,0.0,100.0,300.00,100.00");
  expect(lines[lines.length - 1].startsWith("TOTAL,1,")).toBe(true);
});
