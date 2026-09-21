import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { buildFuelPlan } from "../src/lib/fuelPlan.js";

// T4 Fuel and Stops, Task 7 — wiring fuelBurn + fuelAdvice + attributeGallons
// into the assignment verdict (POST /assignments and PATCH /:id/plan, both
// dry-run and commit). Mirrors tests/dispatcher-break-plan.test.ts's shape:
// that file is the one place breakPlan/breakPlanKnown's CONTRACT is asserted
// against the HTTP surface; this one is the equivalent for `fuel`.

beforeEach(resetDb);

async function dispatcherAuth(email = "d@x.com") {
  const disp = await prisma.dispatcher.create({ data: { email, passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

// Exact gazetteer coordinates (src/lib/usCities.ts) so stateOf resolves them
// via EITHER the address suffix or the lat/lng fallback — belt and suspenders
// against a test relying on only one of stateOf's two paths.
const KC = { lat: 39.0997, lng: -94.5786 }; // Kansas City, MO
const MEMPHIS = { lat: 35.1495, lng: -90.049 }; // Memphis, TN
// The whole gazetteer sits inside lat 25.76..47.66, lng -123.09..-70.26
// (checked directly against src/lib/usCities.ts) — Anchorage is thousands of
// miles outside that box, so stateOf's lat/lng path is guaranteed to find no
// gazetteer city within STATE_MATCH_MAX_MI (25mi) of it, regardless of which
// cities the gazetteer happens to contain.
const UNRESOLVABLE = { lat: 61.2181, lng: -149.9003 }; // Anchorage, AK
const FAR = new Date("2027-01-01T00:00:00.000Z");
const PRICE_DAY = new Date(Date.UTC(2020, 0, 1)); // always <= "today"

async function seed(opts: {
  driverHos?: boolean;
  deliveryLoc?: { lat: number; lng: number };
  deliveryAddress?: string;
} = {}) {
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const delivery = opts.deliveryLoc ?? MEMPHIS;
  const driver = await prisma.driver.create({
    data: {
      email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: false, lastLat: KC.lat, lastLng: KC.lng,
      ...(opts.driverHos === false
        ? {}
        : {
            hos: {
              create: {
                driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200,
                minutesSinceBreak: 0,
              },
            },
          }),
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-1", type: "DryVan", status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "DryVan", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "500 Dock Rd, Kansas City, MO", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: opts.deliveryAddress ?? "200 Warehouse Dr, Memphis, TN",
            lat: delivery.lat, lng: delivery.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load };
}

it("priced stops produce buy-here advice, sized to the fuel still ahead of the buy point", async () => {
  const auth = await dispatcherAuth();
  const { org, load, driver, tractor, trailer } = await seed();
  await prisma.fuelPrice.create({ data: { orgId: org.id, state: "MO", centsPerGal: 350, effectiveOn: PRICE_DAY } });
  await prisma.fuelPrice.create({ data: { orgId: org.id, state: "TN", centsPerGal: 450, effectiveOn: PRICE_DAY } });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.fuel.known).toBe(true);
  expect(res.body.fuel.burn.mpgUsed).not.toBeNull();
  const advice = res.body.fuel.advice;
  expect(advice).not.toBeNull();
  // The pickup (MO, cheaper) is the buy point; the delivery (TN, pricier) is
  // the price avoided. The last stop is never eligible as a buy point
  // (fuelAdvice.ts) even though it is priced.
  expect(advice.state).toBe("MO");
  expect(advice.centsPerGal).toBe(350);
  expect(advice.vsCentsPerGal).toBe(450);
  expect(advice.savingCents).toBeGreaterThan(0);
});

it("an org with no fuel prices returns known: false, advice: null, and leaves feasible unchanged", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  // Deliberately no FuelPrice rows for this org anywhere.

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.fuel.known).toBe(false);
  expect(res.body.fuel.advice).toBeNull();
  // Absent must never render as measured (Global Constraint 1): with no
  // price data at all, fuel adds nothing to the verdict — feasibility is
  // exactly what it was before this task existed.
  expect(res.body.feasible).toBe(true);
});

it("a carrier with mpg: 0 resolves known: false without throwing", async () => {
  // mpg <= 0 is refused earlier in the route by priceOrRefuse/computeEconomics
  // (a stated 422, never a bare crash — see dispatcherAssignments.ts), so an
  // HTTP request never reaches fuel assembly with mpg: 0 at all. This exercises
  // fuelPlan.ts's OWN defense against the hazardous input directly: fuelBurn
  // must refuse to divide by an unusable mpg (fuel.ts), and buildFuelPlan must
  // propagate that as known: false rather than throwing or dividing by zero
  // anywhere in its own gallonsFromHere/attribution arithmetic.
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  await prisma.fuelPrice.create({ data: { orgId: org.id, state: "MO", centsPerGal: 350, effectiveOn: PRICE_DAY } });
  await prisma.fuelPrice.create({ data: { orgId: org.id, state: "TN", centsPerGal: 450, effectiveOn: PRICE_DAY } });

  const result = await buildFuelPlan(
    org.id,
    KC,
    { deadheadMi: 0, loadedMi: 380, legs: [{ index: -1, miles: 0, milesRemaining: 380 }, { index: 0, miles: 380, milesRemaining: 380 }] },
    [
      { sequence: 1, address: "500 Dock Rd, Kansas City, MO", lat: KC.lat, lng: KC.lng },
      { sequence: 2, address: "200 Warehouse Dr, Memphis, TN", lat: MEMPHIS.lat, lng: MEMPHIS.lng },
    ],
    0,
  );

  expect(result.known).toBe(false);
  expect(result.advice).toBeNull();
  expect(result.burn.mpgUsed).toBeNull();
  expect(result.ifta.complete).toBe(false);
});

it("ifta.complete is false when any stop's state cannot be resolved", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({
    deliveryLoc: UNRESOLVABLE,
    deliveryAddress: "1 Unmapped Way", // no state suffix
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.fuel.ifta.complete).toBe(false);
  expect(res.body.fuel.ifta.unattributedGal).toBeGreaterThan(0);
});

it("fuel raises no conflicts: the conflicts array is identical with and without fuel prices loaded", async () => {
  const auth = await dispatcherAuth();
  // No HOS import -> guarantees a non-empty, deterministic conflicts array
  // (a standing "hos" warn) so this comparison is not vacuously comparing
  // two empty arrays.
  const { org, load, driver, tractor, trailer } = await seed({ driverHos: false });

  const before = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });
  expect(before.status).toBe(200);
  expect(before.body.conflicts.length).toBeGreaterThan(0);
  expect(before.body.fuel.known).toBe(false);

  await prisma.fuelPrice.create({ data: { orgId: org.id, state: "MO", centsPerGal: 350, effectiveOn: PRICE_DAY } });
  await prisma.fuelPrice.create({ data: { orgId: org.id, state: "TN", centsPerGal: 450, effectiveOn: PRICE_DAY } });

  const after = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });
  expect(after.status).toBe(200);
  // Fuel prices now loaded, and the response's fuel data genuinely changed —
  // proving the two calls are not identical for an unrelated reason (e.g. a
  // dry-run bug that ignores the DB).
  expect(after.body.fuel.known).toBe(true);

  // ...but the conflicts array itself — the thing fuel must never touch — is
  // byte-for-byte the same.
  expect(after.body.conflicts).toEqual(before.body.conflicts);
});
