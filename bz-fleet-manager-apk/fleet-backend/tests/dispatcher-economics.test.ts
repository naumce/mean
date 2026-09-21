import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

async function orgScopedDispatcher() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.dispatcher.create({ data: {
    email: "d@x.com", passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "d@x.com", password: "secret123" });
  return { org, token: login.body.token as string };
}

async function seedRunnable(orgId: string, tag: string, revenueCents: number) {
  const driver = await prisma.driver.create({ data: {
    email: `${tag}@x.com`, passwordHash: "x", name: `Driver ${tag}`, orgId,
    lastLat: KC.lat, lastLng: KC.lng,
    hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
  } });
  const tractor = await prisma.tractor.create({ data: { orgId, unit: `T-${tag}`, status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId, unit: `V-${tag}`, type: "DryVan", status: "active" } });
  const load = await prisma.load.create({ data: {
    orgId, requiredEquip: "DryVan", orderRef: `REF-${tag}`, brokerName: "Landstar",
    revenueCents, fscCents: 0, status: "open",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
        appointment: { create: { windowEnd: FAR, type: "pickup" } } },
      { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng,
        appointment: { create: { windowEnd: FAR, type: "delivery" } } },
    ] },
  } });
  return { driver, tractor, trailer, load };
}

async function commit(token: string, s: Awaited<ReturnType<typeof seedRunnable>>) {
  const res = await request(app).post("/api/dispatcher/assignments")
    .set("authorization", `Bearer ${token}`)
    .send({ loadId: s.load.id, driverId: s.driver.id, tractorId: s.tractor.id, trailerId: s.trailer.id });
  expect(res.status).toBe(201);
}

it("prices commits with the org's own cost model, not the default", async () => {
  const { org, token } = await orgScopedDispatcher();
  // An expensive shop: $2.00/gal-equivalent fuel burn at 5 mpg, $2.00/mi
  // driver, $3.00/mi fixed. Set through the same endpoint the UI uses.
  const patch = await request(app).patch("/api/dispatcher/settings/cost-model")
    .set("authorization", `Bearer ${token}`)
    .send({ mpg: 5, dieselCentsPerGal: 1000, driverPayCentsPerMi: 200, fixedCentsPerMi: 300 });
  expect(patch.status).toBe(200);

  const s = await seedRunnable(org.id, "a", 34000);
  await commit(token, s);

  const rate = await prisma.rate.findUniqueOrThrow({ where: { loadId: s.load.id } });
  const expectedCost =
    Math.round((rate.totalMi / 5) * 1000) +
    Math.round(rate.totalMi * 200) +
    Math.round(rate.totalMi * 300);
  expect(rate.estCostCents).toBe(expectedCost);
  expect(rate.marginCents).toBe(34000 - expectedCost);
});

it("lists per-load economics worst margin first, with honest totals", async () => {
  const { org, token } = await orgScopedDispatcher();
  const loser = await seedRunnable(org.id, "loser", 10000); // ~$100 for a ~166mi run
  const winner = await seedRunnable(org.id, "winner", 60000);
  await commit(token, loser);
  await commit(token, winner);

  const res = await request(app).get("/api/dispatcher/economics")
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.loads).toHaveLength(2);
  // Worst first: the underpriced load surfaces on top.
  expect(res.body.loads[0].ref).toBe("REF-loser");
  expect(res.body.loads[0].marginPct).toBeLessThan(res.body.loads[1].marginPct);
  expect(res.body.loads[0].driverName).toBe("Driver loser");
  expect(res.body.loads[0].broker).toBe("Landstar");

  const [loserRate, winnerRate] = await Promise.all([
    prisma.rate.findUniqueOrThrow({ where: { loadId: loser.load.id } }),
    prisma.rate.findUniqueOrThrow({ where: { loadId: winner.load.id } }),
  ]);
  expect(res.body.totals.loads).toBe(2);
  expect(res.body.totals.revenueCents).toBe(70000);
  expect(res.body.totals.marginCents).toBe(loserRate.marginCents + winnerRate.marginCents);
  expect(res.body.totals.estCostCents).toBe(loserRate.estCostCents + winnerRate.estCostCents);
  expect(res.body.loads[0].rpmLoadedCents).toBe(loserRate.ratePerLoadedMiCents);
});

it("exports the same rows as CSV with a TOTAL line when format=csv", async () => {
  const { org, token } = await orgScopedDispatcher();
  const s = await seedRunnable(org.id, "csv", 34000);
  await commit(token, s);

  const res = await request(app).get("/api/dispatcher/economics?format=csv")
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/csv");
  expect(res.headers["content-disposition"]).toContain('filename="money-per-load.csv"');
  const lines = res.text.trim().split("\r\n");
  expect(lines[0]).toBe(
    "load,broker,driver,status,planned_start,revenue_usd,loaded_mi,deadhead_mi,total_mi,rpm_loaded_usd,rpm_all_usd,est_cost_usd,margin_usd,margin_pct",
  );
  expect(lines[1]).toContain("REF-csv,Landstar,Driver csv,assigned");
  expect(lines[1]).toContain("340.00");
  expect(lines[lines.length - 1].startsWith("TOTAL,")).toBe(true);
  expect(lines[lines.length - 1]).toContain("340.00");
});

it("filters by dispatch date when a range is given, and rejects an inverted one", async () => {
  const { org, token } = await orgScopedDispatcher();
  const early = await seedRunnable(org.id, "early", 30000);
  const late = await seedRunnable(org.id, "late", 40000);
  await commit(token, early);
  await commit(token, late);
  // Push one commit's plannedStart a week back so the window separates them.
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  await prisma.assignment.update({
    where: { loadId: early.load.id },
    data: { plannedStart: weekAgo, plannedEnd: new Date(weekAgo.getTime() + 4 * 3600_000) },
  });

  const from = new Date(Date.now() - 24 * 3600_000).toISOString();
  const res = await request(app).get(`/api/dispatcher/economics?from=${from}`)
    .set("authorization", `Bearer ${token}`);
  expect(res.body.loads).toHaveLength(1);
  expect(res.body.loads[0].ref).toBe("REF-late");
  expect(res.body.totals.revenueCents).toBe(40000);

  const inverted = await request(app)
    .get(`/api/dispatcher/economics?from=${new Date().toISOString()}&to=${from}`)
    .set("authorization", `Bearer ${token}`);
  expect(inverted.status).toBe(400);
});

it("scopes to the caller's org and skips uncommitted loads", async () => {
  const { org, token } = await orgScopedDispatcher();
  await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 50000, status: "open" } });

  const other = await prisma.org.create({ data: { name: "Rival" } });
  const rival = await seedRunnable(other.id, "rival", 40000);
  await prisma.assignment.create({ data: {
    orgId: other.id, loadId: rival.load.id, driverId: rival.driver.id,
    plannedStart: new Date(), plannedEnd: new Date(Date.now() + 3600_000),
  } });
  await prisma.rate.create({ data: {
    loadId: rival.load.id, linehaulCents: 40000, fscCents: 0, totalMi: 100, loadedMi: 100,
    deadheadMi: 0, ratePerLoadedMiCents: 400, estCostCents: 20000, marginCents: 20000,
  } });

  const res = await request(app).get("/api/dispatcher/economics")
    .set("authorization", `Bearer ${token}`);
  expect(res.body.loads).toHaveLength(0); // open load has no Rate; rival's is invisible
  expect(res.body.totals.revenueCents).toBe(0);
});
