import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { customerHistory } from "../src/lib/customers.js";
import { isLateAssignment, lateMinutes } from "../src/lib/onTime.js";
import { confirmImport } from "../src/lib/brokerImport.js";
import { BROKER_ROWS, brokerWorkbook } from "./fixtures/brokerBoard.js";

// AI Dispatch Foundation, Task 3 — the customer service (onTime.ts's table,
// customerHistory) and the dispatcher-portal routes on top of it
// (dispatcherCustomers.ts), plus proof that the writer's deriveCustomer
// (load-writer-customer.test.ts covers it directly) makes the EXISTING
// write paths — broker import, the board cell route — link customers with
// zero changes to either.

beforeEach(resetDb);

async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({
    data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

describe("isLateAssignment / lateMinutes", () => {
  const windowEnd = new Date("2026-07-15T18:00:00Z");

  it("is not evaluable (null) when either fact is missing", () => {
    expect(isLateAssignment(null, windowEnd)).toBeNull();
    expect(isLateAssignment(new Date("2026-07-15T17:00:00Z"), null)).toBeNull();
    expect(isLateAssignment(null, null)).toBeNull();
    expect(lateMinutes(null, windowEnd)).toBeNull();
    expect(lateMinutes(new Date("2026-07-15T17:00:00Z"), null)).toBeNull();
  });

  it("is false, and lateMinutes is null, for on-time or early", () => {
    expect(isLateAssignment(new Date("2026-07-15T17:00:00Z"), windowEnd)).toBe(false);
    expect(isLateAssignment(windowEnd, windowEnd)).toBe(false); // exactly on time
    expect(lateMinutes(new Date("2026-07-15T17:00:00Z"), windowEnd)).toBeNull();
  });

  it("is true, with the exact minute count, when completed after the window", () => {
    const completedAt = new Date("2026-07-15T18:45:00Z");
    expect(isLateAssignment(completedAt, windowEnd)).toBe(true);
    expect(lateMinutes(completedAt, windowEnd)).toBe(45);
  });

  it("floors a sub-minute lateness to 0, not null", () => {
    const completedAt = new Date(windowEnd.getTime() + 30_000); // 30s late
    expect(isLateAssignment(completedAt, windowEnd)).toBe(true);
    expect(lateMinutes(completedAt, windowEnd)).toBe(0);
  });
});

// Coordinates round (toFixed(1)) into two clearly distinct lane buckets.
const KC = { lat: 39.0997, lng: -94.5786, address: "Kansas City, MO 64120" };
const DALLAS = { lat: 32.7767, lng: -96.797, address: "Dallas, TX 75236" };
const TULSA = { lat: 36.154, lng: -95.9928, address: "Tulsa, OK 74101" };
const AMARILLO = { lat: 35.222, lng: -101.8313, address: "Amarillo, TX 79101" };

async function seedCompletedLoad(
  orgId: string,
  customerId: string,
  opts: { pickup: typeof KC; delivery: typeof DALLAS; windowEnd?: Date; completedAt: Date },
) {
  const load = await prisma.load.create({
    data: {
      orgId, customerId, requiredEquip: "DryVan", revenueCents: 100000,
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: opts.pickup.address, lat: opts.pickup.lat, lng: opts.pickup.lng, geocodeStatus: "ok" },
          {
            sequence: 2, type: "delivery", address: opts.delivery.address, lat: opts.delivery.lat, lng: opts.delivery.lng, geocodeStatus: "ok",
            ...(opts.windowEnd ? { appointment: { create: { windowEnd: opts.windowEnd, type: "delivery" } } } : {}),
          },
        ],
      },
    },
  });
  const driver = await prisma.driver.create({ data: { email: `d-${load.id}@x.com`, passwordHash: "x", name: "Driver", orgId } });
  await prisma.assignment.create({
    data: {
      orgId, loadId: load.id, driverId: driver.id, status: "completed",
      plannedStart: new Date(opts.completedAt.getTime() - 3_600_000), plannedEnd: opts.completedAt, completedAt: opts.completedAt,
    },
  });
  return load;
}

describe("customerHistory", () => {
  it("exact numbers: 5 loads (4 completed — 1 late 45min, 1 not evaluable) across 2 lanes", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });

    // Lane A (Kansas City -> Dallas): on-time, late-by-45, not-evaluable — 3 runs.
    await seedCompletedLoad(org.id, customer.id, {
      pickup: KC, delivery: DALLAS, windowEnd: new Date("2026-07-15T18:00:00Z"), completedAt: new Date("2026-07-15T17:00:00Z"),
    });
    await seedCompletedLoad(org.id, customer.id, {
      pickup: KC, delivery: DALLAS, windowEnd: new Date("2026-07-15T18:00:00Z"), completedAt: new Date("2026-07-15T18:45:00Z"),
    });
    await seedCompletedLoad(org.id, customer.id, {
      pickup: KC, delivery: DALLAS, completedAt: new Date("2026-07-16T12:00:00Z"), // no windowEnd at all -> not evaluable
    });
    // Lane B (Tulsa -> Amarillo): on-time — 1 run.
    await seedCompletedLoad(org.id, customer.id, {
      pickup: TULSA, delivery: AMARILLO, windowEnd: new Date("2026-07-17T18:00:00Z"), completedAt: new Date("2026-07-17T17:30:00Z"),
    });
    // A 5th load with no assignment at all: real volume, never completed.
    const open = await prisma.load.create({ data: { orgId: org.id, customerId: customer.id, requiredEquip: "DryVan", revenueCents: 1 } });

    const history = await customerHistory(org.id, customer.id);

    expect(history.totalLoads).toBe(5);
    expect(history.completedLoads).toBe(4);
    expect(history.lateLoads).toBe(1);
    // evaluable = 3 (lane A's on-time + late, lane B's on-time); the
    // no-appointment lane-A load is excluded from both halves of the ratio.
    expect(history.onTimeRate).toBeCloseTo(2 / 3, 10);
    expect(history.detentionEvents).toBe(0);
    expect(history.lastLoadAt).toEqual(open.createdAt);

    expect(history.commonLanes).toHaveLength(2);
    expect(history.commonLanes[0]).toMatchObject({ originCity: "Kansas City", destCity: "Dallas", runs: 3 });
    expect(history.commonLanes[1]).toMatchObject({ originCity: "Tulsa", destCity: "Amarillo", runs: 1 });
  });

  it("onTimeRate is null when nothing is evaluable", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    await seedCompletedLoad(org.id, customer.id, { pickup: KC, delivery: DALLAS, completedAt: new Date("2026-07-16T12:00:00Z") });
    const history = await customerHistory(org.id, customer.id);
    expect(history.completedLoads).toBe(1);
    expect(history.lateLoads).toBe(0);
    expect(history.onTimeRate).toBeNull();
  });

  it("counts only THIS customer's detention events, not the org's other customer's", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const quiet = await prisma.customer.create({ data: { orgId: org.id, name: "QUIET CO" } });
    const detained = await prisma.customer.create({ data: { orgId: org.id, name: "DETAINED CO" } });
    await seedCompletedLoad(org.id, quiet.id, { pickup: KC, delivery: DALLAS, completedAt: new Date("2026-07-16T12:00:00Z") });

    // The exact minimal shape detention-scan.test.ts uses for a real claim:
    // a geocoded, appointment-bearing stop plus enough in-fence pings to
    // exceed free time.
    const now = Date.now();
    const HOUR = 3_600_000;
    const load = await prisma.load.create({
      data: {
        orgId: org.id, customerId: detained.id, requiredEquip: "DryVan", revenueCents: 1,
        stops: {
          create: [{
            sequence: 1, type: "delivery", address: "123 Elm St Dock", lat: KC.lat, lng: KC.lng, geocodeStatus: "ok",
            appointment: { create: { windowStart: new Date(now - 5 * HOUR), windowEnd: new Date(now + HOUR), type: "delivery" } },
          }],
        },
      },
    });
    const driver = await prisma.driver.create({ data: { email: "detain-driver@x.com", passwordHash: "x", name: "D", orgId: org.id } });
    await prisma.assignment.create({
      data: { orgId: org.id, loadId: load.id, driverId: driver.id, plannedStart: new Date(now - 8 * HOUR), plannedEnd: new Date(now + HOUR) },
    });
    for (const t of [now - 4 * HOUR, now - 3.5 * HOUR, now - 3 * HOUR, now - 2.5 * HOUR, now - 2 * HOUR, now - 1 * HOUR]) {
      await prisma.driverLocation.create({ data: { driverId: driver.id, latitude: KC.lat, longitude: KC.lng, createdAt: new Date(t) } });
    }

    // A SECOND load for the SAME "detained" customer: a real, well-evidenced
    // dwell (2+ pings, a genuine segment) that never leaves free time —
    // rawMin (60) - freeMin (DEFAULT_FREE_MIN 120) <= 0, so detentionClaim
    // returns null. scanDetention still reports this stop (observedMin > 0,
    // not skipped) with `claim: null` — proving the count is OWED detention,
    // not merely observed dwell.
    const withinFreeTimeLoad = await prisma.load.create({
      data: {
        orgId: org.id, customerId: detained.id, requiredEquip: "DryVan", revenueCents: 1,
        stops: {
          create: [{
            sequence: 1, type: "delivery", address: "456 Oak St Dock", lat: KC.lat, lng: KC.lng, geocodeStatus: "ok",
            appointment: { create: { windowStart: new Date(now - 5 * HOUR), windowEnd: new Date(now + HOUR), type: "delivery" } },
          }],
        },
      },
    });
    const quietDriver = await prisma.driver.create({ data: { email: "within-free-driver@x.com", passwordHash: "x", name: "D2", orgId: org.id } });
    await prisma.assignment.create({
      data: { orgId: org.id, loadId: withinFreeTimeLoad.id, driverId: quietDriver.id, plannedStart: new Date(now - 8 * HOUR), plannedEnd: new Date(now + HOUR) },
    });
    for (const t of [now - 2 * HOUR, now - 1.5 * HOUR, now - 1 * HOUR]) {
      await prisma.driverLocation.create({ data: { driverId: quietDriver.id, latitude: KC.lat, longitude: KC.lng, createdAt: new Date(t) } });
    }

    expect((await customerHistory(org.id, quiet.id)).detentionEvents).toBe(0);
    // Still 1, not 2: the within-free-time dwell on the second load is a real,
    // observed fact (scanDetention does not skip it) but never an owed one.
    expect((await customerHistory(org.id, detained.id)).detentionEvents).toBe(1);
  });
});

describe("customer routes — CRUD", () => {
  it("creates a customer for the caller's org", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).post("/api/dispatcher/customers").set("authorization", auth).send({ name: "  ACME FOODS  " });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("ACME FOODS"); // trimmed
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.preferredCommunicationChannel).toBe("email"); // schema default
    expect(res.body.priority).toBe("standard");
  });

  it("rejects creating a customer without an org-scoped dispatcher account", async () => {
    const disp = await createDispatcher({ email: "legacy@x.com" });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
    const res = await request(app).post("/api/dispatcher/customers").set("authorization", auth).send({ name: "Orgless" });
    expect(res.status).toBe(400);
  });

  it("rejects a blank name, a bad email, and a negative minutes field", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const auth = await scopedAuth(org.id);
    expect((await request(app).post("/api/dispatcher/customers").set("authorization", auth).send({ name: "  " })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/customers").set("authorization", auth).send({ name: "X", primaryEmail: "not-an-email" })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/customers").set("authorization", auth).send({ name: "X", updateCadenceMinutes: -1 })).status).toBe(400);
  });

  it("POST rejects a duplicate name in the org with 409", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    const auth = await scopedAuth(org.id);
    const res = await request(app).post("/api/dispatcher/customers").set("authorization", auth).send({ name: "ACME FOODS" });
    expect(res.status).toBe(409);
  });

  it("two different orgs may each name a customer the same thing", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const resA = await request(app).post("/api/dispatcher/customers").set("authorization", await scopedAuth(orgA.id)).send({ name: "ACME FOODS" });
    const resB = await request(app).post("/api/dispatcher/customers").set("authorization", await scopedAuth(orgB.id)).send({ name: "ACME FOODS" });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.id).not.toBe(resB.body.id);
  });

  it("GET /customers lists the caller's org's customers, with _count.loads, ordered by name", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const zebra = await prisma.customer.create({ data: { orgId: orgA.id, name: "Zebra Co" } });
    const acme = await prisma.customer.create({ data: { orgId: orgA.id, name: "Acme Co" } });
    await prisma.load.create({ data: { orgId: orgA.id, customerId: acme.id, requiredEquip: "DryVan", revenueCents: 1 } });
    await prisma.customer.create({ data: { orgId: orgB.id, name: "Foreign Co" } });

    const res = await request(app).get("/api/dispatcher/customers").set("authorization", await scopedAuth(orgA.id));
    expect(res.status).toBe(200);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(["Acme Co", "Zebra Co"]);
    const acmeRow = res.body.find((c: { id: string }) => c.id === acme.id);
    expect(acmeRow._count.loads).toBe(1);
    const zebraRow = res.body.find((c: { id: string }) => c.id === zebra.id);
    expect(zebraRow._count.loads).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain("Foreign Co");
  });

  it("GET /customers/:id returns the customer, 404s cross-org", async () => {
    const orgA = await prisma.org.create({ data: { name: "Alpha" } });
    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const mine = await prisma.customer.create({ data: { orgId: orgA.id, name: "Mine Co" } });
    const theirs = await prisma.customer.create({ data: { orgId: orgB.id, name: "Theirs Co" } });
    const auth = await scopedAuth(orgA.id);
    const ok = await request(app).get(`/api/dispatcher/customers/${mine.id}`).set("authorization", auth);
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Mine Co");
    const cross = await request(app).get(`/api/dispatcher/customers/${theirs.id}`).set("authorization", auth);
    expect(cross.status).toBe(404);
    const missing = await request(app).get("/api/dispatcher/customers/does-not-exist").set("authorization", auth);
    expect(missing.status).toBe(404);
  });

  it("PATCH updates fields, leaves an omitted field untouched, and clears an explicit null", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS", primaryPhone: "555-0100", priority: "high" } });
    const auth = await scopedAuth(org.id);

    const patch1 = await request(app).patch(`/api/dispatcher/customers/${customer.id}`).set("authorization", auth).send({ primaryContactName: "Jamie" });
    expect(patch1.status).toBe(200);
    expect(patch1.body.primaryContactName).toBe("Jamie");
    expect(patch1.body.primaryPhone).toBe("555-0100"); // untouched
    expect(patch1.body.priority).toBe("high"); // untouched

    const patch2 = await request(app).patch(`/api/dispatcher/customers/${customer.id}`).set("authorization", auth).send({ primaryPhone: null });
    expect(patch2.status).toBe(200);
    expect(patch2.body.primaryPhone).toBeNull();
  });

  it("PATCH rejects a duplicate name with 409, and 404s cross-org without leaking the row", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    await prisma.customer.create({ data: { orgId: org.id, name: "TAKEN" } });
    const mine = await prisma.customer.create({ data: { orgId: org.id, name: "MINE" } });
    const auth = await scopedAuth(org.id);
    const dup = await request(app).patch(`/api/dispatcher/customers/${mine.id}`).set("authorization", auth).send({ name: "TAKEN" });
    expect(dup.status).toBe(409);

    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const theirs = await prisma.customer.create({ data: { orgId: orgB.id, name: "THEIRS", primaryPhone: "555-0199" } });
    const res = await request(app).patch(`/api/dispatcher/customers/${theirs.id}`).set("authorization", auth).send({ primaryPhone: "555-0000" });
    expect(res.status).toBe(404);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: theirs.id } })).primaryPhone).toBe("555-0199");
  });

  it("PATCH with an empty body is a 400", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    const res = await request(app).patch(`/api/dispatcher/customers/${customer.id}`).set("authorization", await scopedAuth(org.id)).send({});
    expect(res.status).toBe(400);
  });
});

describe("customer routes — history and loads", () => {
  it("GET /customers/:id/history matches the service, and 404s cross-org", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    await seedCompletedLoad(org.id, customer.id, {
      pickup: KC, delivery: DALLAS, windowEnd: new Date("2026-07-15T18:00:00Z"), completedAt: new Date("2026-07-15T17:00:00Z"),
    });
    const auth = await scopedAuth(org.id);
    const res = await request(app).get(`/api/dispatcher/customers/${customer.id}/history`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalLoads: 1, completedLoads: 1, lateLoads: 0, onTimeRate: 1 });

    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const theirs = await prisma.customer.create({ data: { orgId: orgB.id, name: "THEIRS" } });
    expect((await request(app).get(`/api/dispatcher/customers/${theirs.id}/history`).set("authorization", auth)).status).toBe(404);
  });

  it("GET /customers/:id/loads lists newest first with first/last stop address and status, and 404s cross-org", async () => {
    const org = await prisma.org.create({ data: { name: "Acme" } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: "ACME FOODS" } });
    const older = await seedCompletedLoad(org.id, customer.id, {
      pickup: KC, delivery: DALLAS, windowEnd: new Date("2026-07-15T18:00:00Z"), completedAt: new Date("2026-07-15T17:00:00Z"),
    });
    const newer = await prisma.load.create({
      data: {
        orgId: org.id, customerId: customer.id, requiredEquip: "DryVan", revenueCents: 1, status: "open",
        stops: { create: [{ sequence: 1, type: "pickup", address: TULSA.address }, { sequence: 2, type: "delivery", address: AMARILLO.address }] },
      },
    });
    const auth = await scopedAuth(org.id);
    const res = await request(app).get(`/api/dispatcher/customers/${customer.id}/loads`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.map((l: { id: string }) => l.id)).toEqual([newer.id, older.id]);
    expect(res.body[0]).toMatchObject({ status: "open", firstStopAddress: TULSA.address, lastStopAddress: AMARILLO.address });
    expect(res.body[1]).toMatchObject({ firstStopAddress: KC.address, lastStopAddress: DALLAS.address });

    const orgB = await prisma.org.create({ data: { name: "Beta" } });
    const theirs = await prisma.customer.create({ data: { orgId: orgB.id, name: "THEIRS" } });
    expect((await request(app).get(`/api/dispatcher/customers/${theirs.id}/loads`).set("authorization", auth)).status).toBe(404);
  });
});

describe("existing write paths link customers with zero changes to them", () => {
  it("importing a broker workbook creates one Customer per distinct trimmed name per org, and links the loads", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    await confirmImport(org.id, brokerWorkbook());

    // BROKER_ROWS' 5 loads all carry customer "ACME FOODS" — one row, not five.
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(1);
    const customer = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "ACME FOODS" } });
    const loads = await prisma.load.findMany({ where: { orgId: org.id } });
    expect(loads).toHaveLength(5);
    expect(loads.every((l) => l.customerId === customer.id)).toBe(true);

    // Re-importing (an update, not a create) must not duplicate the Customer.
    await confirmImport(org.id, brokerWorkbook());
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(1);
  });

  it("a distinct customer name on one row gets its own Customer row in the same import", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Los_Angeles" } });
    const rows = BROKER_ROWS.map((r) => [...r]);
    rows[5][1] = "WIDGET DISTRIBUTORS"; // load 2's TOP row customer cell (row 6 is its carrier/bottom row)
    await confirmImport(org.id, brokerWorkbook(rows));
    expect(await prisma.customer.count({ where: { orgId: org.id } })).toBe(2);
    const l = await prisma.load.findFirst({ where: { orgId: org.id, externalId: "145219" }, include: { customer: true } });
    expect(l?.customer?.name).toBe("WIDGET DISTRIBUTORS");
  });

  it("writing customerName through the board cell route relinks to an existing customer, or creates one", async () => {
    const org = await prisma.org.create({ data: { name: "Broker", timezone: "America/Chicago" } });
    const existing = await prisma.customer.create({ data: { orgId: org.id, name: "GLOBE FREIGHT" } });
    const disp = await prisma.dispatcher.create({ data: { email: "b@x.com", passwordHash: "x", name: "B", orgId: org.id } });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;
    const load = await prisma.load.create({
      data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 400000, customerName: "ACME FOODS" },
    });

    // Relinks to the existing "GLOBE FREIGHT" row.
    const relink = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set("Authorization", auth)
      .send({ row: "top", key: "customer", value: "GLOBE FREIGHT", baseVersion: 0 });
    expect(relink.status).toBe(200);
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerId).toBe(existing.id);

    // Creates a brand new one for a name nobody has yet.
    const create = await request(app).patch(`/api/dispatcher/broker-board/loads/${load.id}/cell`).set("Authorization", auth)
      .send({ row: "top", key: "customer", value: "NORTHSTAR HAULING", baseVersion: 1 });
    expect(create.status).toBe(200);
    const created = await prisma.customer.findFirstOrThrow({ where: { orgId: org.id, name: "NORTHSTAR HAULING" } });
    expect((await prisma.load.findUnique({ where: { id: load.id } }))?.customerId).toBe(created.id);
  });
});
