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

async function completedRun(orgId: string, driverId: string, completedAt: Date, revenue: number, cost: number) {
  return prisma.load.create({ data: {
    orgId, requiredEquip: "DryVan", status: "delivered", revenueCents: revenue,
    rate: { create: {
      linehaulCents: revenue, fscCents: 0, totalMi: 220, loadedMi: 200, deadheadMi: 20,
      ratePerLoadedMiCents: 0, estCostCents: cost, marginCents: revenue - cost,
    } },
    assignment: { create: {
      orgId, driverId, status: "completed", completedAt,
      plannedStart: new Date(completedAt.getTime() - 8 * 3600_000), plannedEnd: completedAt,
    } },
  } });
}

it("buckets completed work into this week vs last for the trend strip", async () => {
  const { org, token } = await orgScopedDispatcher();
  const driver = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
  const now = Date.now();

  await completedRun(org.id, driver.id, new Date(now - 2 * DAY_MS), 50000, 30000); // this week
  await completedRun(org.id, driver.id, new Date(now - 3 * DAY_MS), 30000, 20000); // this week
  await completedRun(org.id, driver.id, new Date(now - 10 * DAY_MS), 40000, 35000); // last week
  await completedRun(org.id, driver.id, new Date(now - 20 * DAY_MS), 90000, 10000); // beyond the fortnight — ignored

  const res = await request(app).get("/api/dispatcher/kpis").set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  const { thisWeek, lastWeek } = res.body.trend;
  expect(thisWeek.loads).toBe(2);
  expect(thisWeek.revenueCents).toBe(80000);
  expect(thisWeek.marginCents).toBe(30000);
  expect(thisWeek.deadheadPct).toBeCloseTo(40 / 440, 4);
  expect(lastWeek.loads).toBe(1);
  expect(lastWeek.revenueCents).toBe(40000);
  expect(lastWeek.marginCents).toBe(5000);
});

it("returns empty buckets when nothing completed recently", async () => {
  const { token } = await orgScopedDispatcher();
  const res = await request(app).get("/api/dispatcher/kpis").set("authorization", `Bearer ${token}`);
  expect(res.body.trend.thisWeek.loads).toBe(0);
  expect(res.body.trend.lastWeek.revenueCents).toBe(0);
});
