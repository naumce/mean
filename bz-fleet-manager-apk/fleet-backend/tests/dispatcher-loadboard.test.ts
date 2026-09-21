import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

async function dispatcherAuth() {
  const disp = await prisma.dispatcher.create({ data: { email: "d@x.com", passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

const WINDOW = { from: "2026-08-21T00:00:00.000Z", to: "2026-08-22T00:00:00.000Z" };

async function makeLoad(orgId: string, ref: string, status = "open") {
  return prisma.load.create({
    data: {
      orgId, externalId: ref, requiredEquip: "Reefer", revenueCents: 50000, fscCents: 2000, status,
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "Kansas City, MO" },
          { sequence: 2, type: "delivery", address: "Omaha, NE" },
        ],
      },
    },
  });
}

it("returns lanes and open loads with origin/destination + revenue", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.driver.create({ data: { email: "a@x.com", passwordHash: "x", name: "Ann", orgId: org.id } });
  await makeLoad(org.id, "L-1");

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.lanes).toHaveLength(1);
  expect(res.body.loads).toHaveLength(1);
  const load = res.body.loads[0];
  expect(load.reference).toBe("L-1");
  expect(load.origin).toBe("Kansas City");
  expect(load.destination).toBe("Omaha");
  expect(load.revenueCents).toBe(52000);
  expect(load.assignment).toBeNull();
});

it("carries the first pickup's appointment window as the cover-by clock", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  await prisma.load.create({ data: {
    orgId: org.id, externalId: "L-APPT", requiredEquip: "DryVan", status: "open",
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO",
        appointment: { create: { windowStart: new Date("2026-08-21T14:00:00.000Z"), windowEnd: new Date("2026-08-21T16:00:00.000Z"), type: "pickup" } } },
      { sequence: 2, type: "delivery", address: "Omaha, NE" },
    ] },
  } });
  await makeLoad(org.id, "L-NOAPPT"); // no appointment -> nulls, never a guess

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  const withAppt = res.body.loads.find((l: { reference: string }) => l.reference === "L-APPT");
  expect(withAppt.pickupWindowEnd).toBe("2026-08-21T16:00:00.000Z");
  expect(withAppt.pickupWindowStart).toBe("2026-08-21T14:00:00.000Z");
  const without = res.body.loads.find((l: { reference: string }) => l.reference === "L-NOAPPT");
  expect(without.pickupWindowEnd).toBeNull();
});

it("shows an assigned load with its planned window when in range, and hides it out of range", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({ data: { email: "b@x.com", passwordHash: "x", name: "Bob", orgId: org.id } });
  const inRange = await makeLoad(org.id, "L-IN", "assigned");
  await prisma.assignment.create({
    data: { orgId: org.id, loadId: inRange.id, driverId: driver.id,
      plannedStart: new Date("2026-08-21T09:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"), status: "assigned" },
  });
  const outRange = await makeLoad(org.id, "L-OUT", "assigned");
  await prisma.assignment.create({
    data: { orgId: org.id, loadId: outRange.id, driverId: driver.id,
      plannedStart: new Date("2026-09-01T09:00:00.000Z"), plannedEnd: new Date("2026-09-01T14:00:00.000Z"), status: "assigned" },
  });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  const refs = (res.body.loads as Array<{ reference: string; assignment: unknown }>).map((l) => l.reference);
  expect(refs).toContain("L-IN");
  expect(refs).not.toContain("L-OUT");
  const assigned = (res.body.loads as Array<{ reference: string; assignment: { driverId: string } | null }>).find((l) => l.reference === "L-IN");
  expect(assigned?.assignment?.driverId).toBe(driver.id);
});

it("lane headers carry real HOS, utilization, and window revenue", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const jake = await prisma.driver.create({ data: {
    email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
    hos: { create: { driveRemainingMin: 330, windowRemainingMin: 500, cycleRemainingMin: 3000, minutesSinceBreak: 100, importedAt: new Date("2026-08-21T06:00:00.000Z") } },
  } });
  const noHos = await prisma.driver.create({ data: { email: "n@x.com", passwordHash: "x", name: "NoHos", orgId: org.id } });
  const load = await makeLoad(org.id, "L-U", "assigned");
  // A 6h commitment inside the 24h window -> utilization 0.25.
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: jake.id, status: "assigned",
    plannedStart: new Date("2026-08-21T08:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"),
  } });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  const jakeLane = res.body.lanes.find((l: { id: string }) => l.id === jake.id);
  expect(jakeLane.hosKnown).toBe(true);
  expect(jakeLane.driveRemainingMin).toBe(330);
  expect(jakeLane.utilizationPct).toBeCloseTo(0.25, 3);
  expect(jakeLane.revenueCents).toBe(52000);
  expect(jakeLane.hosImportedAt).toBe("2026-08-21T06:00:00.000Z");

  const emptyLane = res.body.lanes.find((l: { id: string }) => l.id === noHos.id);
  expect(emptyLane.hosKnown).toBe(false);
  expect(emptyLane.driveRemainingMin).toBeNull();
  expect(emptyLane.utilizationPct).toBe(0);
  expect(emptyLane.revenueCents).toBe(0);
});

it("trailers expose lastLat/lastLng/lastSeenAt (T2 Task 6 position fields), null for one never hauled", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const seenAt = new Date("2026-08-21T05:00:00.000Z");
  const positioned = await prisma.trailer.create({
    data: { orgId: org.id, unit: "RF-3310", type: "Reefer", lastLat: 41.2565, lastLng: -95.9345, lastSeenAt: seenAt },
  });
  const neverHauled = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-9999", type: "Reefer" } });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  expect(res.status).toBe(200);
  const trailers = res.body.trailers as Array<{ id: string; lastLat: number | null; lastLng: number | null; lastSeenAt: string | null }>;

  const p = trailers.find((t) => t.id === positioned.id)!;
  expect(p.lastLat).toBe(41.2565);
  expect(p.lastLng).toBe(-95.9345);
  expect(p.lastSeenAt).toBe("2026-08-21T05:00:00.000Z");

  const n = trailers.find((t) => t.id === neverHauled.id)!;
  expect(n.lastLat).toBeNull();
  expect(n.lastLng).toBeNull();
  expect(n.lastSeenAt).toBeNull();
});

it("400s an invalid window", async () => {
  const auth = await dispatcherAuth();
  const res = await request(app).get(`/api/dispatcher/loadboard`).query({ from: "nope", to: "nope" }).set("authorization", auth);
  expect(res.status).toBe(400);
});

it("lanes carry pairing, current equipment (live assignment wins) and the last-known city; units carry their driver", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const t1 = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", make: "Peterbilt 579" } });
  const t2 = await prisma.tractor.create({ data: { orgId: org.id, unit: "1212", make: "Kenworth T680" } });
  const r1 = await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-4450", type: "DryVan", length: "53'" } });
  const jake = await prisma.driver.create({ data: {
    email: "j@x.com", passwordHash: "x", name: "Jake", orgId: org.id, hazmatEndorsed: true,
    defaultTractorId: t1.id, defaultTrailerId: r1.id,
    lastLat: 39.1, lastLng: -94.58, lastLocationAt: new Date("2026-08-21T07:00:00.000Z"),
    hos: { create: { driveRemainingMin: 495, windowRemainingMin: 700, cycleRemainingMin: 2760, minutesSinceBreak: 90 } },
  } });
  const load = await makeLoad(org.id, "L-LIVE", "in_progress");
  // In progress on tractor 1212 (not the default): the live unit is what the lane shows.
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: jake.id, tractorId: t2.id, trailerId: null, status: "in_progress",
    plannedStart: new Date("2026-08-21T08:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"),
    deadheadMi: 12, loadedMi: 180, savedMi: 40,
  } });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  expect(res.status).toBe(200);
  const lane = res.body.lanes.find((l: { id: string }) => l.id === jake.id);
  expect(lane.defaultTractorId).toBe(t1.id);
  expect(lane.defaultTrailerId).toBe(r1.id);
  expect(lane.currentTractorId).toBe(t2.id);   // live assignment wins
  expect(lane.currentTrailerId).toBe(r1.id);   // assignment has no trailer -> default pairing
  expect(lane.hazmatEndorsed).toBe(true);
  expect(lane.cycleRemainingMin).toBe(2760);
  expect(lane.minutesSinceBreak).toBe(90);
  expect(lane.lastLat).toBe(39.1);
  expect(lane.lastCity).toBe("Kansas City, MO");
  expect(lane.lastLocationAt).toBe("2026-08-21T07:00:00.000Z");

  const tractors = res.body.tractors as Array<{ id: string; unit: string; currentDriverId: string | null }>;
  expect(tractors.map((t) => t.unit)).toEqual(["1207", "1212"]);
  expect(tractors.find((t) => t.id === t2.id)?.currentDriverId).toBe(jake.id);
  expect(tractors.find((t) => t.id === t1.id)?.currentDriverId).toBeNull();
  const trailers = res.body.trailers as Array<{ id: string; currentDriverId: string | null; activeDriverId: string | null }>;
  expect(trailers.find((t) => t.id === r1.id)?.currentDriverId).toBe(jake.id);
  // r1 is only jake's DEFAULT pairing here — his live assignment has no
  // trailerId — so currentDriverId folds in the fallback but activeDriverId
  // (no active assignment actually holds this trailer) must stay null.
  expect(trailers.find((t) => t.id === r1.id)?.activeDriverId).toBeNull();
});

it("a trailer's activeDriverId is set only by an active assignment, never by a driver's default pairing alone (T2 map fix)", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const defaultOnly = await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-1", type: "DryVan" } });
  const hooked = await prisma.trailer.create({ data: { orgId: org.id, unit: "DV-2", type: "DryVan" } });
  // Eve: `defaultOnly` is her default pairing and she has no assignment at
  // all — so it's her "current equipment" purely via the fallback.
  const eve = await prisma.driver.create({
    data: { email: "e@x.com", passwordHash: "x", name: "Eve", orgId: org.id, defaultTrailerId: defaultOnly.id },
  });
  // Frank: `hooked` is on his ACTIVE (in_progress) assignment — no default
  // pairing involved at all.
  const frank = await prisma.driver.create({ data: { email: "f@x.com", passwordHash: "x", name: "Frank", orgId: org.id } });
  const load = await makeLoad(org.id, "L-HOOKED", "in_progress");
  // in_progress: unambiguously "now" regardless of whether plannedEnd has
  // technically elapsed relative to the real wall clock (see the `live`
  // filter's own comment in dispatcherLoadboard.ts) — the same reason the
  // "lanes carry pairing..." test above uses in_progress for its own `cur`.
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: frank.id, trailerId: hooked.id, status: "in_progress",
    plannedStart: new Date("2026-08-21T08:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"),
  } });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  const trailers = res.body.trailers as Array<{ id: string; currentDriverId: string | null; activeDriverId: string | null }>;

  const defaultOnlyWire = trailers.find((t) => t.id === defaultOnly.id)!;
  expect(defaultOnlyWire.currentDriverId).toBe(eve.id); // default pairing -> currentDriverId still set
  expect(defaultOnlyWire.activeDriverId).toBeNull();     // but no active assignment -> activeDriverId null

  const hookedWire = trailers.find((t) => t.id === hooked.id)!;
  expect(hookedWire.currentDriverId).toBe(frank.id);
  expect(hookedWire.activeDriverId).toBe(frank.id);      // on an active assignment -> both set
});

it("loads expose freight + geocoded stops; assignments expose equipment, miles and lifecycle", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({ data: { email: "b@x.com", passwordHash: "x", name: "Bob", orgId: org.id } });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-2201", type: "Reefer" } });
  const load = await prisma.load.create({ data: {
    orgId: org.id, externalId: "L-RICH", requiredEquip: "Reefer", status: "assigned", revenueCents: 289000, fscCents: 0,
    commodity: "Frozen poultry", weightLbs: 42000, brokerName: "Tyson Foods", hazmatClass: null,
    stops: { create: [
      { sequence: 1, type: "pickup", address: "St. Louis, MO", lat: 38.627, lng: -90.1994, dwellMin: 60,
        appointment: { create: { windowStart: new Date("2026-08-21T13:00:00.000Z"), windowEnd: new Date("2026-08-21T15:00:00.000Z"), type: "pickup" } } },
      { sequence: 2, type: "delivery", address: "Atlanta, GA", lat: 33.749, lng: -84.388, dwellMin: 90 },
    ] },
  } });
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, status: "assigned",
    plannedStart: new Date("2026-08-21T16:00:00.000Z"), plannedEnd: new Date("2026-08-22T09:00:00.000Z"),
    deadheadMi: 0, loadedMi: 555, marginCents: 61000, savedMi: 120,
  } });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  const l = res.body.loads.find((x: { reference: string }) => x.reference === "L-RICH");
  expect(l.commodity).toBe("Frozen poultry");
  expect(l.weightLbs).toBe(42000);
  expect(l.brokerName).toBe("Tyson Foods");
  expect(l.stops).toHaveLength(2);
  expect(l.stops[0]).toMatchObject({ sequence: 1, type: "pickup", address: "St. Louis, MO", lat: 38.627, lng: -90.1994, dwellMin: 60,
    windowStart: "2026-08-21T13:00:00.000Z", windowEnd: "2026-08-21T15:00:00.000Z" });
  expect(l.stops[1].windowEnd).toBeNull();
  expect(l.assignment).toMatchObject({ tractorId: tractor.id, trailerId: trailer.id, status: "assigned", loadedMi: 555, savedMi: 120, deadheadMi: 0 });
  expect(l.assignment.startedAt).toBeNull();
});

it("a leg that started before the window but is still running is visible (overlap, not start-in-window)", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({ data: { email: "c@x.com", passwordHash: "x", name: "Cy", orgId: org.id } });
  const load = await makeLoad(org.id, "L-SPAN", "in_progress");
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: load.id, driverId: driver.id, status: "in_progress",
    plannedStart: new Date("2026-08-20T20:00:00.000Z"), plannedEnd: new Date("2026-08-21T10:00:00.000Z"),
  } });
  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  expect(res.body.loads.map((x: { reference: string }) => x.reference)).toContain("L-SPAN");
});

it("assignment economics come from the committed Rate snapshot, and are null when the load was never priced", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({ data: { email: "p@x.com", passwordHash: "x", name: "Pat", orgId: org.id } });

  const priced = await makeLoad(org.id, "L-PRICED", "assigned");
  await prisma.rate.create({ data: {
    loadId: priced.id, linehaulCents: 50000, fscCents: 2000, totalMi: 300, loadedMi: 280, deadheadMi: 20,
    ratePerLoadedMiCents: 186, estCostCents: 41000, marginCents: 11000,
  } });
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: priced.id, driverId: driver.id, status: "assigned",
    plannedStart: new Date("2026-08-21T09:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"),
    loadedMi: 280, deadheadMi: 20, marginCents: 11000,
  } });

  // Never priced: no Rate row, and Assignment.marginCents keeps its Int @default(0).
  const unpriced = await makeLoad(org.id, "L-UNPRICED", "assigned");
  await prisma.assignment.create({ data: {
    orgId: org.id, loadId: unpriced.id, driverId: driver.id, status: "assigned",
    plannedStart: new Date("2026-08-21T15:00:00.000Z"), plannedEnd: new Date("2026-08-21T20:00:00.000Z"),
  } });

  const res = await request(app).get(`/api/dispatcher/loadboard`).query(WINDOW).set("authorization", auth);
  expect(res.status).toBe(200);
  const loads = res.body.loads as Array<{ reference: string; assignment: { marginCents: number; economics: { estCostCents: number; marginCents: number } | null } }>;

  const withRate = loads.find((l) => l.reference === "L-PRICED")!;
  expect(withRate.assignment.economics).toEqual({ estCostCents: 41000, marginCents: 11000 });
  expect(withRate.assignment.marginCents).toBe(11000); // legacy field kept for the old board

  const withoutRate = loads.find((l) => l.reference === "L-UNPRICED")!;
  expect(withoutRate.assignment.economics).toBeNull();
  expect(withoutRate.assignment.marginCents).toBe(0); // the default that must never render as measured
});

it("carries the brokered fields, and a covered brokered load with no assignment rides in the window by its appointments", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC", mcNumber: "1000001" } });
  const covered = await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 250000, customerName: "MEIBORG", status: "assigned", carrierId: carrier.id,
    updateText: "SCHEDULED", apptText: "PU: 07/14 - 12:00\nDEL: 07/16 - 07:00", boardLoadNo: "0563265", shipDate: new Date("2026-07-13T00:00:00Z"), version: 2,
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowStart: new Date("2026-07-14T17:00:00Z"), windowEnd: new Date("2026-07-14T19:00:00Z"), type: "pickup", kind: "appointment" } } },
      { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date("2026-07-16T12:00:00Z"), type: "delivery", kind: "appointment" } } },
    ] },
  } });
  const linedUp = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "open", carrierId: carrier.id, updateText: "PENDING RATE CONFIRMATION" } });
  const res = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-07-14T00:00:00.000Z", to: "2026-07-17T00:00:00.000Z" }).set("authorization", auth);
  expect(res.status).toBe(200);
  const c = res.body.loads.find((l: { id: string }) => l.id === covered.id);
  expect(c).toMatchObject({ brokered: true, carrierId: carrier.id, carrierName: "Blue Road LLC", carrierMc: "1000001", customerName: "MEIBORG", updateText: "SCHEDULED", boardLoadNo: "0563265", version: 2, assignment: null, status: "assigned", deliveryWindowEnd: "2026-07-16T12:00:00.000Z", attention: [] });
  const o = res.body.loads.find((l: { id: string }) => l.id === linedUp.id);
  expect(o).toMatchObject({ status: "open", carrierId: carrier.id, carrierName: "Blue Road LLC" });
  // Outside the window the covered load is not on the board; the open one still is (the backlog is not windowed).
  const later = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }).set("authorization", auth);
  expect(later.body.loads.some((l: { id: string }) => l.id === covered.id)).toBe(false);
  expect(later.body.loads.some((l: { id: string }) => l.id === linedUp.id)).toBe(true);
});

it("a covered brokered load with no appointments rides in every window unplaced, with its Attention; delivered ones without windows stay off", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Fast Lane Inc" } });
  const unplaced = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "in_progress", carrierId: carrier.id, updateText: "PICKED UP" } });
  await prisma.agentUpdate.create({ data: { loadId: unplaced.id, atMs: BigInt(1), kind: "attention", text: 'can\'t read PU appointment: "PU: whenever"' } });
  const done = await prisma.load.create({ data: { orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "delivered", carrierId: carrier.id, updateText: "DELIVERED" } });
  const res = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }).set("authorization", auth);
  const u = res.body.loads.find((l: { id: string }) => l.id === unplaced.id);
  expect(u).toMatchObject({ brokered: true, status: "in_progress", attention: ['can\'t read PU appointment: "PU: whenever"'], pickupWindowStart: null, deliveryWindowEnd: null });
  expect(res.body.loads.some((l: { id: string }) => l.id === done.id)).toBe(false);
});

it("windows a covered brokered load BY ROLE, not by pooling every stop's window: a PU-only load stays visible into a later window (unknown end), a DEL-only load stays visible into an earlier one (open start) but drops out of a later one", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });
  const puOnly = await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "in_progress", carrierId: carrier.id,
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO", appointment: { create: { windowStart: new Date("2026-07-14T17:00:00Z"), windowEnd: new Date("2026-07-14T19:00:00Z"), type: "pickup" } } },
      { sequence: 2, type: "delivery", address: "Dallas, TX" },
    ] },
  } });
  const delOnly = await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "in_progress", carrierId: carrier.id,
    stops: { create: [
      { sequence: 1, type: "pickup", address: "Kansas City, MO" },
      { sequence: 2, type: "delivery", address: "Dallas, TX", appointment: { create: { windowEnd: new Date("2026-07-16T12:00:00Z"), type: "delivery" } } },
    ] },
  } });

  // A window far past the PU date: the PU-only load's end is unknown, not
  // collapsed to its pickup slot, so it must still be on the board.
  const later = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-07-20T00:00:00.000Z", to: "2026-07-21T00:00:00.000Z" }).set("authorization", auth);
  expect(later.body.loads.some((l: { id: string }) => l.id === puOnly.id)).toBe(true);
  // The DEL-only load's start is open (no PU window at all): it is visible
  // in an earlier window that ends before its DEL window...
  const earlier = await request(app).get("/api/dispatcher/loadboard").query({ from: "2026-07-13T00:00:00.000Z", to: "2026-07-14T00:00:00.000Z" }).set("authorization", auth);
  expect(earlier.body.loads.some((l: { id: string }) => l.id === delOnly.id)).toBe(true);
  // ...but not in a window entirely after its DEL window has passed.
  expect(later.body.loads.some((l: { id: string }) => l.id === delOnly.id)).toBe(false);
});

// F3: `brokered` is the plan's own contract (Global Constraints, spec §8.2) —
// no Assignment of ours, a carrier, a covered status — never `isBrokered()`
// (brokerImport.ts's importer-provenance predicate, true for any load
// carrying a bolNumber/customerName/carrierId/carrierPhone/carrierContactName).
// An own-driver load that merely carries a `customerName` used to ship as
// `brokered: true`; nothing asserted the false case before this.
it("brokered reflects no-Assignment + a carrier + a covered status, not the importer's provenance fields", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const carrier = await prisma.carrier.create({ data: { orgId: org.id, name: "Blue Road LLC" } });

  // Own-driver: no carrier at all, just a customerName a TMS field happened
  // to carry — isBrokered() would have said true; the plan's contract says no.
  const ownDriver = await makeLoad(org.id, "L-OWN");
  await prisma.load.update({ where: { id: ownDriver.id }, data: { customerName: "Acme Shipper" } });

  // Covered brokered: no Assignment, a carrierId, status "assigned" (in
  // COVERED_LOAD_STATUSES) — this IS brokered under the plan's contract.
  const covered = await prisma.load.create({ data: {
    orgId: org.id, requiredEquip: "DryVan", revenueCents: 1, customerName: "MEIBORG", status: "assigned", carrierId: carrier.id,
  } });

  const res = await request(app).get("/api/dispatcher/loadboard").query(WINDOW).set("authorization", auth);
  expect(res.status).toBe(200);
  const own = res.body.loads.find((l: { id: string }) => l.id === ownDriver.id);
  expect(own.brokered).toBe(false);
  const cov = res.body.loads.find((l: { id: string }) => l.id === covered.id);
  expect(cov.brokered).toBe(true);
});

// Plan A4, Task 3: `?ids=` re-reads exactly the loads a client already knows
// moved — narrowing the projection's existing window/coverage rules, never
// widening past what a full read would have shown.
async function scopedAuth(orgId: string) {
  const disp = await prisma.dispatcher.create({ data: { email: `disp-${orgId}@x.com`, passwordHash: "x", name: "D", orgId } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

it("narrows to the ids asked for and answers loads only", async () => {
  const auth = await dispatcherAuth();
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const driver = await prisma.driver.create({ data: { email: "ids@x.com", passwordHash: "x", name: "Ida", orgId: org.id } });
  const inView = await makeLoad(org.id, "L-IDS-IN", "assigned");
  await prisma.assignment.create({
    data: { orgId: org.id, loadId: inView.id, driverId: driver.id,
      plannedStart: new Date("2026-08-21T09:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"), status: "assigned" },
  });
  // Outside [from, to) by the projection's own window rule: asking for it by
  // id must not pull it back into view — absence is the signal a client uses
  // to drop a brick that moved out of view.
  const outOfWindow = await makeLoad(org.id, "L-IDS-OUT", "assigned");
  await prisma.assignment.create({
    data: { orgId: org.id, loadId: outOfWindow.id, driverId: driver.id,
      plannedStart: new Date("2026-09-01T09:00:00.000Z"), plannedEnd: new Date("2026-09-01T14:00:00.000Z"), status: "assigned" },
  });

  const res = await request(app)
    .get(`/api/dispatcher/loadboard`)
    .query({ ...WINDOW, ids: `${inView.id},${outOfWindow.id}` })
    .set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.loads.map((l: { id: string }) => l.id)).toEqual([inView.id]);
  // A patch response carries no lanes: the lane list did not change, and
  // sending it would make a "cheap" patch as expensive as a full read.
  expect(res.body.lanes).toBeUndefined();
  expect(res.body.tractors).toBeUndefined();
  expect(res.body.trailers).toBeUndefined();
});

it("does not hand back another org's load by id", async () => {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const auth = await scopedAuth(org.id);
  const other = await prisma.org.create({ data: { name: "Other" } });
  const otherOrgLoad = await makeLoad(other.id, "L-OTHER");
  const res = await request(app)
    .get(`/api/dispatcher/loadboard`)
    .query({ ...WINDOW, ids: otherOrgLoad.id })
    .set("authorization", auth);
  expect(res.status).toBe(200);
  expect(res.body.loads).toEqual([]);
});
