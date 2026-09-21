import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const MEMPHIS = { lat: 35.1495, lng: -90.049 };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

async function seed() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const disp = await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id } });
  const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
  const driver = await prisma.driver.create({
    data: {
      email: "jake@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      lastLat: KC.lat, lastLng: KC.lng, hos: { create: FRESH },
    },
  });
  await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "DryVan", status: "active" } });

  const mkLoad = (ref: string, from: { lat: number; lng: number }, to: { lat: number; lng: number }, equip = "DryVan") =>
    prisma.load.create({
      data: {
        orgId: org.id, externalId: ref, requiredEquip: equip, revenueCents: 50000, status: "open",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: `${ref} pickup`, lat: from.lat, lng: from.lng, appointment: { create: { windowEnd: FAR } } },
            { sequence: 2, type: "delivery", address: `${ref} drop`, lat: to.lat, lng: to.lng, appointment: { create: { windowEnd: FAR } } },
          ],
        },
      },
    });

  return { org, auth, driver, mkLoad };
}

it("ranks open loads for the driver, nearest pickup best", async () => {
  const { auth, driver, mkLoad } = await seed();
  await mkLoad("L-NEAR", KC, OMAHA);       // pickup at driver's position
  await mkLoad("L-FAR", MEMPHIS, OMAHA);   // pickup ~370mi away

  const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/next`).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.driver.name).toBe("Jake");
  expect(res.body.driver.hos.driveRemainingMin).toBe(660);
  expect(res.body.driver.currentAssignment).toBeNull();

  const rows = res.body.nextLoads as Array<{ reference: string; feasible: boolean; score: number | null; blockedReason?: string }>;
  expect(rows).toHaveLength(2);
  expect(rows[0].reference).toBe("L-NEAR");
  expect(rows[0].feasible).toBe(true);
  expect(rows[0].score).toBeGreaterThan(0);
  // Memphis pickup = ~17h total drive: correctly HOS-blocked, ranked last, never hidden.
  expect(rows[1].reference).toBe("L-FAR");
  expect(rows[1].feasible).toBe(false);
  expect(rows[1].blockedReason).toContain("drive");
});

it("uses the current assignment's drop as origin and its end as availability", async () => {
  const { org, auth, driver, mkLoad } = await seed();
  // Current load delivers to OMAHA.
  const current = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-CUR", requiredEquip: "DryVan", status: "assigned",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng },
          { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng },
        ],
      },
    },
  });
  await prisma.assignment.create({
    data: {
      orgId: org.id, loadId: current.id, driverId: driver.id,
      plannedStart: new Date("2026-08-21T08:00:00.000Z"), plannedEnd: new Date("2026-08-21T15:00:00.000Z"),
      status: "assigned",
    },
  });
  await mkLoad("L-FROM-OMAHA", OMAHA, KC);   // pickup at the FUTURE position
  await mkLoad("L-FROM-KC", KC, OMAHA);      // pickup at the CURRENT ping

  const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/next`).set("authorization", auth);
  expect(res.body.driver.currentAssignment.loadReference).toBe("L-CUR");
  expect(res.body.driver.currentAssignment.destination).toBe("Omaha dock");
  expect(res.body.driver.availableAt).toBe("2026-08-21T15:00:00.000Z");

  const rows = res.body.nextLoads as Array<{ reference: string; deadheadMi: number }>;
  const fromOmaha = rows.find((r) => r.reference === "L-FROM-OMAHA")!;
  const fromKc = rows.find((r) => r.reference === "L-FROM-KC")!;
  // Deadhead is measured from the future drop (Omaha), so the Omaha pickup wins.
  expect(fromOmaha.deadheadMi).toBeLessThan(fromKc.deadheadMi);
  expect(rows[0].reference).toBe("L-FROM-OMAHA");
});

it("includes a pool-gap load as infeasible with the reason, and 404s cross-org", async () => {
  const { auth, driver, mkLoad } = await seed();
  await mkLoad("L-REEFER", KC, OMAHA, "Reefer"); // no reefer in pool

  const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/next`).set("authorization", auth);
  const row = (res.body.nextLoads as Array<{ reference: string; feasible: boolean; blockedReason?: string }>)
    .find((r) => r.reference === "L-REEFER")!;
  expect(row.feasible).toBe(false);
  expect(row.blockedReason).toContain("Reefer");

  const other = await prisma.org.create({ data: { name: "Other" } });
  const foreign = await prisma.dispatcher.create({ data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: other.id } });
  const cross = await request(app).get(`/api/dispatcher/drivers/${driver.id}/next`)
    .set("authorization", `Bearer ${signDispatcherAccess(foreign.id)}`);
  expect(cross.status).toBe(404);
});
