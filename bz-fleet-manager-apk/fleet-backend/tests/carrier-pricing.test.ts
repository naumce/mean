import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

// T1 Carrier Layer, Task 3 — THE POINT OF THE WHOLE SLICE: two carriers in one
// org, with genuinely different driverPayCentsPerMi, must produce genuinely
// different marginCents for the same load spec committed to a driver of each.
// src/routes/dispatcherAssignments.ts now resolves the cost model from the
// driver in hand (rateConfigForDriver, Task 2's src/lib/rateConfig.ts) instead
// of the org alone, on both the commit path and the replan path — the only
// two call sites in that file with a single driver in hand. dispatcherSuggest
// (ranks EVERY driver against one shared rate) and dispatcherSettlements
// (rolls up a whole org/date-range, no single driver) are deliberately
// untouched — see the deliberate-asymmetry note in the task report.
//
// Fixture shape copied from tests/dispatcher-assignments.test.ts's seed() —
// same geometry (driver parked on the pickup, so deadhead ~0), not
// reinvented; extended here to seed more than one driver per org, which that
// helper doesn't support.

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

async function dispatcherAuth(email = "d@x.com") {
  const disp = await prisma.dispatcher.create({ data: { email, passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

/** A driver (optionally on a carrier) + dedicated tractor/trailer + an open
 *  load, all with the SAME spec every call uses (KC -> Omaha, $300 revenue,
 *  $40 FSC, driver parked on the pickup). Two calls in the same org therefore
 *  commit two economically-identical loads that differ only in which driver —
 *  and therefore which carrier — picks them up. Dedicated equipment per call
 *  so two commits in the same window never collide on a shared tractor/trailer. */
async function seedCommitTarget(orgId: string, tag: string, carrierId?: string) {
  const driver = await prisma.driver.create({
    data: {
      email: `drv-${tag}@x.com`, passwordHash: "x", name: `Driver ${tag}`, orgId,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      carrierId: carrierId ?? null,
      hos: { create: FRESH_HOS },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId, unit: `T-${tag}`, status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId, unit: `RF-${tag}`, type: "Reefer", status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { driver, tractor, trailer, load };
}

type CommitTarget = Awaited<ReturnType<typeof seedCommitTarget>>;

async function commit(auth: string, t: CommitTarget) {
  return request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: t.load.id, driverId: t.driver.id, tractorId: t.tractor.id, trailerId: t.trailer.id });
}

it("prices two carriers' drivers differently for the identical load spec — by the exact driver-pay delta over the plan's miles", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const carrierA = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier A", driverPayCentsPerMi: 60 },
  });
  const carrierB = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier B", driverPayCentsPerMi: 90 },
  });

  const a = await seedCommitTarget(org.id, "a", carrierA.id);
  const b = await seedCommitTarget(org.id, "b", carrierB.id);

  const resA = await commit(auth, a);
  const resB = await commit(auth, b);
  expect(resA.status).toBe(201);
  expect(resB.status).toBe(201);

  const rateA = await prisma.rate.findUniqueOrThrow({ where: { loadId: a.load.id } });
  const rateB = await prisma.rate.findUniqueOrThrow({ where: { loadId: b.load.id } });

  // Both drivers are parked exactly on the pickup and the load spec is
  // identical, so geometry is identical too (deadhead ~0, same loaded miles).
  // That isolates driverPayCentsPerMi as the ONLY thing that can move margin.
  expect(rateA.deadheadMi).toBeCloseTo(0, 1);
  expect(rateB.totalMi).toBe(rateA.totalMi);

  // "They differ" is not the assertion — the EXACT delta is: driver pay is
  // Math.round(totalMi * driverPayCentsPerMi) (src/domain/dispatch/economics.ts),
  // mpg/diesel/fixed are untouched (both carriers inherit the same org for
  // those), so the whole margin gap collapses to the driver-pay gap.
  const expectedDelta = Math.round(rateA.totalMi * 90) - Math.round(rateA.totalMi * 60);
  expect(expectedDelta).toBeGreaterThan(0); // sanity: the route has non-zero miles
  expect(rateA.marginCents - rateB.marginCents).toBe(expectedDelta);
});

it("a driver with no carrier still prices at the org's own cost model, not the planning default", async () => {
  const auth = await dispatcherAuth();
  // Deliberately NOT the planning defaults (mpg 6.5 / $4.00 / 60c / 45c) — if
  // rateConfigForDriver silently fell back to DEFAULT_RATE_CONFIG instead of
  // reading the org, the numbers below would coincidentally still match and
  // this test would lie green. They must NOT match by construction.
  const org = await prisma.org.create({
    data: { name: "Acme Fleet", mpg: 5, dieselCentsPerGal: 1000, driverPayCentsPerMi: 200, fixedCentsPerMi: 300 },
  });
  const t = await seedCommitTarget(org.id, "none"); // carrierId left null

  const res = await commit(auth, t);
  expect(res.status).toBe(201);

  const rate = await prisma.rate.findUniqueOrThrow({ where: { loadId: t.load.id } });
  const expectedCost =
    Math.round((rate.totalMi / 5) * 1000) +
    Math.round(rate.totalMi * 200) +
    Math.round(rate.totalMi * 300);
  expect(rate.estCostCents).toBe(expectedCost);
  // Revenue priced against is linehaul + FSC (mapper.ts's toLoadInput: $300 + $40).
  expect(rate.marginCents).toBe(34000 - expectedCost);
});

it("editing a carrier's cost model after a commit does not change the margin a dispatcher reads back", async () => {
  // The previous version of this test wrote to Carrier and re-read the Rate
  // row directly with Prisma. There is no relation, trigger, or Prisma
  // middleware connecting Carrier to Rate, so nothing this slice could do
  // would ever move that row — the test could not fail even against an
  // implementation that priced every load at zero. The real invariant this
  // guards is that a READ PATH a dispatcher actually uses (§5.2's snapshot
  // rule) keeps showing the committed numbers, not a live recomputation from
  // the carrier's current cost model. So this version reads back through
  // GET /dispatcher/economics — the exact route that would leak a live
  // recompute if src/routes/dispatcherEconomics.ts ever stopped reading
  // Rate.marginCents/estCostCents and started calling rateConfigForDriver
  // itself.
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const carrier = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier B", driverPayCentsPerMi: 90 },
  });
  const t = await seedCommitTarget(org.id, "snap", carrier.id);

  const res = await commit(auth, t);
  expect(res.status).toBe(201);
  const committed = await prisma.rate.findUniqueOrThrow({ where: { loadId: t.load.id } });

  const before = await request(app).get("/api/dispatcher/economics").set("authorization", auth);
  expect(before.status).toBe(200);
  type EconomicsRow = { loadId: string; marginCents: number; estCostCents: number };
  const beforeRow = (before.body.loads as EconomicsRow[]).find((l) => l.loadId === t.load.id);
  expect(beforeRow?.marginCents).toBe(committed.marginCents);
  expect(beforeRow?.estCostCents).toBe(committed.estCostCents);

  // A dramatic edit — if the read path re-derived economics live from the
  // carrier's CURRENT cost model instead of the committed Rate snapshot,
  // this would be impossible to miss (90c/mi -> 500c/mi on a real leg).
  await prisma.carrier.update({ where: { id: carrier.id }, data: { driverPayCentsPerMi: 500 } });

  const after = await request(app).get("/api/dispatcher/economics").set("authorization", auth);
  const afterRow = (after.body.loads as EconomicsRow[]).find((l) => l.loadId === t.load.id);
  expect(afterRow?.marginCents).toBe(committed.marginCents);
  expect(afterRow?.estCostCents).toBe(committed.estCostCents);

  // Sanity: prove the edit WOULD have moved the numbers if anything recomputed
  // live, so an unchanged reading above is meaningful and not coincidental.
  const wouldBeCost =
    committed.estCostCents + Math.round(committed.totalMi * 500) - Math.round(committed.totalMi * 90);
  expect(wouldBeCost).not.toBe(committed.estCostCents);
});

it("PATCH /assignments/:id/plan re-prices at the NEW carrier's model when the leg moves to a driver of a different carrier", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const carrierA = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier A", driverPayCentsPerMi: 60 },
  });
  const carrierB = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier B", driverPayCentsPerMi: 90 },
  });

  const a = await seedCommitTarget(org.id, "replan-a", carrierA.id);
  const commitRes = await commit(auth, a);
  expect(commitRes.status).toBe(201);
  const assignmentId = commitRes.body.assignment.id as string;
  const before = await prisma.rate.findUniqueOrThrow({ where: { loadId: a.load.id } });

  // A driver of a DIFFERENT carrier, parked at the exact same spot as `a` —
  // same geometry, so the new margin can only have moved because of the
  // carrier switch, not because the trip itself changed.
  const driverB = await prisma.driver.create({
    data: {
      email: "drv-replan-b@x.com", passwordHash: "x", name: "Driver B", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng, carrierId: carrierB.id,
      hos: { create: FRESH_HOS },
    },
  });

  const plan = await request(app).patch(`/api/dispatcher/assignments/${assignmentId}/plan`)
    .set("authorization", auth).send({ driverId: driverB.id });
  expect(plan.status).toBe(200);

  const after = await prisma.rate.findUniqueOrThrow({ where: { loadId: a.load.id } });
  expect(after.totalMi).toBe(before.totalMi);
  const expectedDelta = Math.round(before.totalMi * 90) - Math.round(before.totalMi * 60);
  expect(expectedDelta).toBeGreaterThan(0);
  expect(before.marginCents - after.marginCents).toBe(expectedDelta);
});

// T1 combined review, Minor: resolveRateConfig passes a carrier's mpg: 0
// through faithfully (correct — 0 is a deliberate value per I1), but
// computeEconomics then throws "mpg must be positive" trying to divide by
// it. Uncaught, that isn't even a bare 500 here: these are async (req, res)
// Express 4 handlers, so an uncaught throw becomes an unhandled rejection
// and the caller gets NO response at all (see priceOrRefuse's doc comment
// in dispatcherAssignments.ts). This product's rule is a stated refusal,
// never that — for both the commit and replan boundaries.
it("refuses to commit a load for a driver whose carrier has mpg: 0, with a clear reason instead of a bare 500", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const carrier = await prisma.carrier.create({
    data: { orgId: org.id, name: "Broken Carrier", mpg: 0 },
  });
  const t = await seedCommitTarget(org.id, "mpg0", carrier.id);

  const res = await commit(auth, t);
  expect(res.status).toBe(422);
  expect(typeof res.body.error).toBe("string");
  expect(res.body.error).toMatch(/mpg/i);

  // Refused before any write — no Rate row, no Assignment.
  const rate = await prisma.rate.findUnique({ where: { loadId: t.load.id } });
  expect(rate).toBeNull();
});

it("refuses a replan onto a driver whose carrier has mpg: 0, same as the commit boundary", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const goodCarrier = await prisma.carrier.create({
    data: { orgId: org.id, name: "Carrier A", driverPayCentsPerMi: 60 },
  });
  const brokenCarrier = await prisma.carrier.create({
    data: { orgId: org.id, name: "Broken Carrier", mpg: 0 },
  });

  const a = await seedCommitTarget(org.id, "replan-mpg0", goodCarrier.id);
  const commitRes = await commit(auth, a);
  expect(commitRes.status).toBe(201);
  const assignmentId = commitRes.body.assignment.id as string;
  const before = await prisma.rate.findUniqueOrThrow({ where: { loadId: a.load.id } });

  const driverBroken = await prisma.driver.create({
    data: {
      email: "drv-replan-mpg0-b@x.com", passwordHash: "x", name: "Driver Broken", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng, carrierId: brokenCarrier.id,
      hos: { create: FRESH_HOS },
    },
  });

  const plan = await request(app).patch(`/api/dispatcher/assignments/${assignmentId}/plan`)
    .set("authorization", auth).send({ driverId: driverBroken.id });
  expect(plan.status).toBe(422);
  expect(typeof plan.body.error).toBe("string");
  expect(plan.body.error).toMatch(/mpg/i);

  // Refused before any write — the ORIGINAL Rate snapshot is untouched.
  const after = await prisma.rate.findUniqueOrThrow({ where: { loadId: a.load.id } });
  expect(after.marginCents).toBe(before.marginCents);
  expect(after.estCostCents).toBe(before.estCostCents);
});

// ---------------------------------------------------------------------------
// T1 Task 3b — ⚡Suggest ranks every candidate at THEIR OWN carrier's cost
// model, not one org-wide number. Before this, the panel showed a margin the
// commit would not honour, and worse, ranked a driver on an expensive carrier
// as if they cost the org's rate — recommending the wrong driver, confidently,
// in the feature a dispatcher trusts most.
// ---------------------------------------------------------------------------

it("Suggest prices each candidate at their own carrier, and its margin is the one a commit actually produces", async () => {
  const auth = await dispatcherAuth();
  // Org pays 60c/mi; Carrier B's drivers cost 90c/mi.
  const org = await prisma.org.create({ data: { name: "Suggest Fleet", driverPayCentsPerMi: 60 } });
  const carrierB = await prisma.carrier.create({
    data: { orgId: org.id, name: "Pricey Carrier", driverPayCentsPerMi: 90 },
  });

  // Two drivers, identical position and hours; only the carrier differs.
  const cheap = await seedCommitTarget(org.id, "cheap");             // no carrier -> inherits org 60c
  const pricey = await seedCommitTarget(org.id, "pricey", carrierB.id);

  // Rank BOTH drivers against ONE load (cheap's), so the only variable is cost.
  const res = await request(app)
    .get(`/api/dispatcher/suggest?loadId=${cheap.load.id}`)
    .set("authorization", auth);
  expect(res.status).toBe(200);

  const rowFor = (id: string) =>
    res.body.candidates.find((c: { driverId: string }) => c.driverId === id);
  const cheapRow = rowFor(cheap.driver.id);
  const priceyRow = rowFor(pricey.driver.id);
  expect(cheapRow, "cheap driver missing from candidates").toBeTruthy();
  expect(priceyRow, "pricey driver missing from candidates").toBeTruthy();

  // The pay delta over the plan's own miles — DERIVED from the rates under
  // test, never copied from an observed run.
  const totalMi = cheapRow.loadedMi + cheapRow.deadheadMi;
  const expectedDelta = Math.round(totalMi * 90) - Math.round(totalMi * 60);
  expect(expectedDelta).toBeGreaterThan(0);
  expect(cheapRow.marginCents - priceyRow.marginCents).toBe(expectedDelta);

  // THE ASSERTION THAT PROVES THE BUG IS GONE: what the panel promised for
  // this driver is what committing to them actually prices. Testing the
  // ranking in isolation would pass while the panel still lied.
  const committed = await request(app)
    .post("/api/dispatcher/assignments")
    .set("authorization", auth)
    .send({
      loadId: cheap.load.id,
      driverId: pricey.driver.id,
      tractorId: pricey.tractor.id,
      trailerId: pricey.trailer.id,
    });
  expect(committed.status).toBe(201);
  const rate = await prisma.rate.findUniqueOrThrow({ where: { loadId: cheap.load.id } });
  expect(rate.marginCents).toBe(priceyRow.marginCents);
});
