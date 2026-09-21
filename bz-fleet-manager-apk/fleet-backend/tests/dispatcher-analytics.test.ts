import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
beforeEach(resetDb);

async function orgScopedDispatcher(orgName = "Acme") {
  const org = await prisma.org.create({ data: { name: orgName } });
  const email = `${orgName.toLowerCase()}@x.com`;
  await prisma.dispatcher.create({ data: {
    email, passwordHash: await hashPassword("secret123"), name: "D", orgId: org.id,
  } });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email, password: "secret123" });
  return { org, token: login.body.token as string };
}

async function committedLoad(orgId: string, broker: string | null, econ: {
  linehaul: number; fsc?: number; cost: number; loadedMi: number; deadheadMi?: number;
}, status = "assigned") {
  return prisma.load.create({ data: {
    orgId, requiredEquip: "DryVan", status, brokerName: broker,
    revenueCents: econ.linehaul, fscCents: econ.fsc ?? 0,
    rate: { create: {
      linehaulCents: econ.linehaul, fscCents: econ.fsc ?? 0,
      totalMi: econ.loadedMi + (econ.deadheadMi ?? 0), loadedMi: econ.loadedMi,
      deadheadMi: econ.deadheadMi ?? 0, ratePerLoadedMiCents: 0,
      estCostCents: econ.cost, marginCents: econ.linehaul + (econ.fsc ?? 0) - econ.cost,
    } },
  } });
}

it("rolls committed economics up per broker, best margin first", async () => {
  const { org, token } = await orgScopedDispatcher();
  await committedLoad(org.id, "Landstar", { linehaul: 50000, fsc: 5000, cost: 30000, loadedMi: 200, deadheadMi: 20 });
  await committedLoad(org.id, "Landstar", { linehaul: 40000, cost: 25000, loadedMi: 150 });
  await committedLoad(org.id, "CH Robinson", { linehaul: 30000, cost: 29000, loadedMi: 180, deadheadMi: 60 });
  await committedLoad(org.id, null, { linehaul: 20000, cost: 10000, loadedMi: 90 });

  const res = await request(app).get("/api/dispatcher/analytics/brokers")
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.brokers).toHaveLength(3);

  const [best] = res.body.brokers;
  expect(best.broker).toBe("Landstar");
  expect(best.loads).toBe(2);
  expect(best.revenueCents).toBe(95000);
  expect(best.marginCents).toBe(40000);
  expect(best.avgMarginPct).toBeCloseTo(40000 / 95000, 4);
  expect(best.ratePerLoadedMiCents).toBe(Math.round(95000 / 350));

  const names = res.body.brokers.map((b: { broker: string }) => b.broker);
  expect(names).toContain("(no broker)");
  const chr = res.body.brokers.find((b: { broker: string }) => b.broker === "CH Robinson");
  expect(chr.deadheadPct).toBeCloseTo(60 / 240, 4);
});

it("exports the broker rollup as CSV, quoting names that carry commas", async () => {
  const { org, token } = await orgScopedDispatcher();
  await committedLoad(org.id, "CH Robinson, Inc.", { linehaul: 30000, cost: 20000, loadedMi: 100 });

  const res = await request(app).get("/api/dispatcher/analytics/brokers?format=csv")
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/csv");
  expect(res.headers["content-disposition"]).toContain('filename="broker-profitability.csv"');
  const lines = res.text.trim().split("\r\n");
  expect(lines[0]).toBe(
    "broker,loads,revenue_usd,est_cost_usd,margin_usd,margin_pct,loaded_mi,deadhead_mi,deadhead_pct,rpm_loaded_usd",
  );
  expect(lines[1]).toContain('"CH Robinson, Inc.",1,300.00,200.00,100.00,33.3');
});

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };

async function laneRun(orgId: string, driverId: string, status: string, revenue = 30000) {
  return prisma.load.create({ data: {
    orgId, requiredEquip: "DryVan", status: status === "completed" ? "delivered" : "assigned",
    revenueCents: revenue,
    rate: { create: {
      linehaulCents: revenue, fscCents: 0, totalMi: 200, loadedMi: 190, deadheadMi: 10,
      ratePerLoadedMiCents: 0, estCostCents: 20000, marginCents: revenue - 20000,
    } },
    assignment: { create: {
      orgId, driverId, status,
      plannedStart: new Date("2026-08-01T08:00:00Z"), plannedEnd: new Date("2026-08-01T16:00:00Z"),
    } },
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", lat: KC.lat, lng: KC.lng, geocodeStatus: "ok" },
      { sequence: 2, type: "delivery", address: "Omaha, NE", lat: OMAHA.lat, lng: OMAHA.lng, geocodeStatus: "ok" },
    ] },
  } });
}

it("rolls recurring lanes up with runs, economics, and the top driver", async () => {
  const { org, token } = await orgScopedDispatcher();
  const jake = await prisma.driver.create({ data: { email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id } });
  const maria = await prisma.driver.create({ data: { email: "m@x.com", passwordHash: "x", name: "Maria", orgId: org.id } });
  await laneRun(org.id, jake.id, "completed");
  await laneRun(org.id, jake.id, "completed");
  await laneRun(org.id, maria.id, "assigned");

  const res = await request(app).get("/api/dispatcher/analytics/lanes")
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.lanes).toHaveLength(1);
  const [lane] = res.body.lanes;
  expect(lane.runs).toBe(3);
  expect(lane.origin).toContain("Kansas City");
  expect(lane.destination).toContain("Omaha");
  expect(lane.revenueCents).toBe(90000);
  expect(lane.topDriver).toBe("Jake (2)");
});

it("lane familiarity lifts the experienced driver in the suggest ranking", async () => {
  const { org, token } = await orgScopedDispatcher();
  const fresh = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };
  // Two drivers identical in every scoring dimension: same spot, same clocks.
  const veteran = await prisma.driver.create({ data: {
    email: "vet@x.com", passwordHash: "x", name: "Veteran", orgId: org.id,
    hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng, hos: { create: fresh },
  } });
  await prisma.driver.create({ data: {
    email: "rook@x.com", passwordHash: "x", name: "Rookie", orgId: org.id,
    hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng, hos: { create: fresh },
  } });
  await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "DryVan", status: "active" } });
  // The veteran has completed this KC->Omaha lane three times.
  await laneRun(org.id, veteran.id, "completed");
  await laneRun(org.id, veteran.id, "completed");
  await laneRun(org.id, veteran.id, "completed");

  const load = await prisma.load.create({ data: {
    orgId: org.id, externalId: "L-LANE", requiredEquip: "DryVan", revenueCents: 40000, status: "open",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", lat: KC.lat, lng: KC.lng, geocodeStatus: "ok",
        appointment: { create: { windowEnd: new Date("2027-01-01T00:00:00Z"), type: "pickup" } } },
      { sequence: 2, type: "delivery", address: "Omaha, NE", lat: OMAHA.lat, lng: OMAHA.lng, geocodeStatus: "ok",
        appointment: { create: { windowEnd: new Date("2027-01-01T00:00:00Z"), type: "delivery" } } },
    ] },
  } });

  const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`)
    .set("authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  const [first, second] = res.body.candidates;
  expect(first.driverName).toBe("Veteran");
  expect(first.score).toBeGreaterThan(second.score);
});

it("excludes canceled loads and other orgs", async () => {
  const { org, token } = await orgScopedDispatcher();
  await committedLoad(org.id, "Landstar", { linehaul: 10000, cost: 5000, loadedMi: 50 });
  await committedLoad(org.id, "Landstar", { linehaul: 99000, cost: 1000, loadedMi: 50 }, "canceled");
  const rival = await prisma.org.create({ data: { name: "Rival" } });
  await committedLoad(rival.id, "Rival Broker", { linehaul: 77000, cost: 1000, loadedMi: 50 });

  const res = await request(app).get("/api/dispatcher/analytics/brokers")
    .set("authorization", `Bearer ${token}`);
  expect(res.body.brokers).toHaveLength(1);
  expect(res.body.brokers[0].revenueCents).toBe(10000);
});
