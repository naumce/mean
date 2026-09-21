import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

async function seedCommitted() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const disp = await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  const driver = await prisma.driver.create({
    data: {
      email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "DryVan", status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-1", requiredEquip: "DryVan", revenueCents: 40000, fscCents: 2000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "A", lat: KC.lat, lng: KC.lng, appointment: { create: { windowEnd: FAR } } },
          { sequence: 2, type: "delivery", address: "B", lat: OMAHA.lat, lng: OMAHA.lng, appointment: { create: { windowEnd: FAR } } },
        ],
      },
    },
  });
  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  return { org, auth, driver, load, assignmentId: commit.body.assignment.id as string };
}

it("kpis aggregate committed economics and load statuses", async () => {
  const { auth } = await seedCommitted();
  const res = await request(app).get("/api/dispatcher/kpis").set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.loads.assigned).toBe(1);
  expect(res.body.drivers.total).toBe(1);
  expect(res.body.drivers.hosKnown).toBe(1);
  const econ = res.body.economics;
  expect(econ.committedLoads).toBe(1);
  expect(econ.revenueCents).toBe(42000);
  expect(econ.loadedMi).toBeGreaterThan(100);
  expect(econ.deadheadPct).toBeCloseTo(0, 2); // driver parked at pickup
  expect(econ.ratePerLoadedMiCents).toBeGreaterThan(0);
});

it("kpis are org-scoped", async () => {
  await seedCommitted();
  const other = await prisma.org.create({ data: { name: "Other" } });
  const disp = await prisma.dispatcher.create({ data: { email: "o@x.com", passwordHash: "x", name: "O", orgId: other.id } });
  const res = await request(app).get("/api/dispatcher/kpis").set("authorization", `Bearer ${signDispatcherAccess(disp.id)}`);
  expect(res.body.economics.committedLoads).toBe(0);
  expect(res.body.drivers.total).toBe(0);
});

it("unassign restores HOS, reopens the load, and removes rate + assignment", async () => {
  const { auth, driver, load, assignmentId } = await seedCommitted();

  const before = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(before?.driveRemainingMin).toBeLessThan(660); // commit consumed hours

  const res = await request(app).delete(`/api/dispatcher/assignments/${assignmentId}`).set("authorization", auth);
  expect(res.status).toBe(200);

  const after = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(after?.driveRemainingMin).toBe(660);
  expect(after?.windowRemainingMin).toBe(840);
  expect(after?.minutesSinceBreak).toBe(0);

  expect((await prisma.load.findUnique({ where: { id: load.id } }))?.status).toBe("open");
  expect(await prisma.assignment.findUnique({ where: { id: assignmentId } })).toBeNull();
  expect(await prisma.rate.findUnique({ where: { loadId: load.id } })).toBeNull();
});

it("unassign refuses cross-org, unknown, and in-progress assignments", async () => {
  const { auth, assignmentId } = await seedCommitted();

  const other = await prisma.org.create({ data: { name: "Other" } });
  const foreign = await prisma.dispatcher.create({ data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: other.id } });
  const cross = await request(app).delete(`/api/dispatcher/assignments/${assignmentId}`)
    .set("authorization", `Bearer ${signDispatcherAccess(foreign.id)}`);
  expect(cross.status).toBe(404);

  const unknown = await request(app).delete(`/api/dispatcher/assignments/nope`).set("authorization", auth);
  expect(unknown.status).toBe(404);

  await prisma.assignment.update({ where: { id: assignmentId }, data: { status: "in_progress" } });
  const started = await request(app).delete(`/api/dispatcher/assignments/${assignmentId}`).set("authorization", auth);
  expect(started.status).toBe(409);
});
