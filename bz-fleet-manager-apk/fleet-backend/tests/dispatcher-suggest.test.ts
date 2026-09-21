import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

async function dispatcherAuth() {
  const disp = await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const DES_MOINES = { lat: 41.5868, lng: -93.625 };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

async function seedOrgWithLoad(trailerType = "Reefer") {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: trailerType, status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 60000, fscCents: 0, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC", lat: KC.lat, lng: KC.lng, appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "OMA", lat: OMAHA.lat, lng: OMAHA.lng, appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, load };
}

it("ranks feasible drivers first (nearest best) and greys infeasible with a reason", async () => {
  const auth = await dispatcherAuth();
  const { org, load } = await seedOrgWithLoad();
  await prisma.driver.create({ data: { email: "near@x.com", passwordHash: "x", name: "Near", orgId: org.id, lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH } } });
  await prisma.driver.create({ data: { email: "far@x.com", passwordHash: "x", name: "Far", orgId: org.id, lastLat: DES_MOINES.lat, lastLng: DES_MOINES.lng, hos: { create: FRESH } } });
  await prisma.driver.create({ data: { email: "nohours@x.com", passwordHash: "x", name: "NoHours", orgId: org.id, lastLat: KC.lat, lastLng: KC.lng, hos: { create: { ...FRESH, driveRemainingMin: 30 } } } });

  const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.tractorId).not.toBeNull();
  expect(res.body.trailerId).not.toBeNull();

  const rows = res.body.candidates as Array<{ driverName: string; feasible: boolean; score: number | null; blockedReason?: string }>;
  expect(rows).toHaveLength(3);
  // feasible first
  const feasible = rows.filter((r) => r.feasible);
  const infeasible = rows.filter((r) => !r.feasible);
  expect(rows.slice(0, feasible.length).every((r) => r.feasible)).toBe(true);
  expect(feasible[0].driverName).toBe("Near");
  expect(feasible[0].score!).toBeGreaterThan(feasible[1].score!); // Near beats Far
  expect(infeasible[0].driverName).toBe("NoHours");
  expect(typeof infeasible[0].blockedReason).toBe("string");
});

it("includes an undispatchable-position driver as an infeasible row, never hidden", async () => {
  const auth = await dispatcherAuth();
  const { org, load } = await seedOrgWithLoad();
  await prisma.driver.create({ data: { email: "noloc@x.com", passwordHash: "x", name: "NoLoc", orgId: org.id, hos: { create: FRESH } } });

  const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
  const noloc = (res.body.candidates as Array<{ driverName: string; feasible: boolean; blockedReason?: string }>).find((r) => r.driverName === "NoLoc");
  expect(noloc?.feasible).toBe(false);
  expect(noloc?.blockedReason).toMatch(/position/);
});

it("flags an unknown-HOS driver with a warning but keeps them feasible", async () => {
  const auth = await dispatcherAuth();
  const { org, load } = await seedOrgWithLoad();
  await prisma.driver.create({ data: { email: "nohos@x.com", passwordHash: "x", name: "NoHos", orgId: org.id, lastLat: KC.lat, lastLng: KC.lng } });

  const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
  const row = (res.body.candidates as Array<{ driverName: string; feasible: boolean; warnings: string[] }>).find((r) => r.driverName === "NoHos");
  expect(row?.feasible).toBe(true);
  expect(row?.warnings.some((w) => /HOS not imported/.test(w))).toBe(true);
});

it("returns a note when the pool has no trailer of the required type", async () => {
  const auth = await dispatcherAuth();
  const { org, load } = await seedOrgWithLoad("DryVan"); // no Reefer in pool
  await prisma.driver.create({ data: { email: "d@x2.com", passwordHash: "x", name: "D", orgId: org.id, lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH } } });

  const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.candidates).toHaveLength(0);
  expect(res.body.note).toMatch(/Reefer/);
});

it("400s without loadId and 404s an unknown load", async () => {
  const auth = await dispatcherAuth();
  expect((await request(app).get(`/api/dispatcher/suggest`).set("authorization", auth)).status).toBe(400);
  expect((await request(app).get(`/api/dispatcher/suggest?loadId=nope`).set("authorization", auth)).status).toBe(404);
});
