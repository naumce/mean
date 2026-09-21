// Slice 4 (2026-09-19): the loader against the real database — a past
// completed run on the same lane, same pickup address, same driver, with
// GPS at the pickup and an agent trip with a call, is what tonight's brief
// remembers. The load being started is never its own memory.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Brief } from "../../src/core/types.js";

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn("memoryLoader.test: DATABASE_URL not set — skipped");
const mod = url ? await import("../../src/live/memoryLoader.js") : null;
const db = url ? await import("../../../fleet-backend/src/db.js") : null;

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const MIN = 60_000;

run("loadMemory (real database)", () => {
  const prisma = db?.prisma as NonNullable<typeof db>["prisma"];
  const suffix = "mem_" + Date.now();
  const orgId = "org_" + suffix;
  const PU = "Kroger DC 42 " + suffix + ", Kansas City, MO";
  const DEL = "Hy-Vee " + suffix + ", Des Moines, IA";
  let driverId = "";
  let pastLoadId = "";
  let tonightLoadId = "";
  const ids: string[] = [];

  async function makeLoad(no: string, withAssignment: boolean): Promise<string> {
    const load = await prisma.load.create({ data: { orgId, requiredEquip: "DryVan", boardLoadNo: no + "-" + suffix } });
    const pu = await prisma.loadStop.create({ data: { loadId: load.id, sequence: 1, type: "pickup", address: PU, lat: KC.lat, lng: KC.lng, geocodeStatus: "ok" } });
    await prisma.appointment.create({ data: { stopId: pu.id, windowEnd: new Date(Date.now() - 10 * 3_600_000), type: "pickup" } });
    const del = await prisma.loadStop.create({ data: { loadId: load.id, sequence: 2, type: "delivery", address: DEL, lat: DSM.lat, lng: DSM.lng, geocodeStatus: "ok" } });
    await prisma.appointment.create({ data: { stopId: del.id, windowEnd: new Date(Date.now() - 4 * 3_600_000), type: "delivery" } });
    if (withAssignment) {
      const tractor = await prisma.tractor.create({ data: { orgId, unit: "T-" + suffix + no, cab: "Sleeper" } });
      const trailer = await prisma.trailer.create({ data: { orgId, unit: "TR-" + suffix + no, type: "DryVan" } });
      await prisma.assignment.create({ data: { orgId, loadId: load.id, driverId, tractorId: tractor.id, trailerId: trailer.id, plannedStart: new Date(Date.now() - 12 * 3_600_000), plannedEnd: new Date(Date.now() - 5 * 3_600_000), status: "completed", startedAt: new Date(Date.now() - 12 * 3_600_000), completedAt: new Date(Date.now() - 3 * 3_600_000) } });
    }
    ids.push(load.id);
    return load.id;
  }

  beforeAll(async () => {
    await prisma.org.create({ data: { id: orgId, name: "Memory Test " + suffix } });
    const d = await prisma.driver.create({ data: { orgId, email: suffix + "@example.com", passwordHash: "x", name: "Rico" } });
    driverId = d.id;
    pastLoadId = await makeLoad("PAST", true);
    tonightLoadId = await makeLoad("TONIGHT", false);
    // The past run: 75 minutes sitting at the pickup, then gone.
    const t0 = Date.now() - 11 * 3_600_000;
    await prisma.driverLocation.createMany({ data: [
      ...Array.from({ length: 76 }, (_, i) => ({ driverId, latitude: KC.lat, longitude: KC.lng, createdAt: new Date(t0 + i * MIN) })),
      { driverId, latitude: 40.0, longitude: -94.2, createdAt: new Date(t0 + 77 * MIN) },
    ] });
    // ...and the agent trip that ran it, with one answered call and a text nobody answered.
    const trip = await prisma.agentTrip.create({ data: { id: "t_" + suffix, loadRef: "PAST", loadId: pastLoadId, driverToken: "tok_" + suffix, brief: { loadRef: "PAST", context: { driverId } } } });
    await prisma.agentEvent.createMany({ data: [
      { tripId: trip.id, atMs: BigInt(t0), kind: "action", evidence: { kind: "message" } },
      { tripId: trip.id, atMs: BigInt(t0 + MIN), kind: "anomaly", evidence: { kind: "unplanned_stop" } },
      { tripId: trip.id, atMs: BigInt(t0 + 2 * MIN), kind: "call", evidence: { answered: true } },
      { tripId: trip.id, atMs: BigInt(t0 + 3 * MIN), kind: "reply", evidence: { channel: "call", situationKey: "customer" } },
    ] });
  });

  afterAll(async () => {
    await prisma.agentEvent.deleteMany({ where: { trip: { loadId: { in: ids } } } });
    await prisma.agentTrip.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.driverLocation.deleteMany({ where: { driverId } });
    await prisma.assignment.deleteMany({ where: { orgId } });
    await prisma.appointment.deleteMany({ where: { stop: { loadId: { in: ids } } } });
    await prisma.loadStop.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.load.deleteMany({ where: { orgId } });
    await prisma.tractor.deleteMany({ where: { orgId } });
    await prisma.trailer.deleteMany({ where: { orgId } });
    await prisma.driver.deleteMany({ where: { orgId } });
    await prisma.org.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("remembers the pickup's dwell, the driver's answer rate and the lane's history — from the past run only", async () => {
    const brief: Brief = {
      loadRef: "TONIGHT", origin: { name: PU, ...KC }, destination: { name: DEL, ...DSM }, equipment: "DryVan",
      departAtMs: Date.now(), deadlineAtMs: Date.now() + 6 * 3_600_000, driverName: "Rico", driverPhone: "+15550100200", customerEmail: null, minutesSinceBreakAtDepart: 0,
      context: { driverId, hazmatClass: null, commodity: null, customerName: null, brokerName: null, notes: null, apptText: null, updateText: null, hos: null,
        stops: [
          { type: "pickup", name: PU, ...KC, windowStartMs: null, windowEndMs: Date.now(), dwellMin: null },
          { type: "delivery", name: DEL, ...DSM, windowStartMs: null, windowEndMs: Date.now() + 6 * 3_600_000, dwellMin: null },
        ] },
    };
    const m = await mod!.loadMemory(orgId, tonightLoadId, brief);
    expect(m.places[PU]).toMatchObject({ visits: 1, medianDwellMin: 75, maxDwellMin: 75 });
    expect(m.places[DEL]).toMatchObject({ visits: 1, medianDwellMin: null });
    expect(m.driver).toEqual({ trips: 1, callsPlaced: 1, callsAnswered: 1, textsAsked: 1, textsAnswered: 0, recentSituations: ["customer"] });
    expect(m.lane).toMatchObject({ from: "Kroger DC 42 " + suffix, to: "Hy-Vee " + suffix, runs: 1, lateArrivals: 1, commonAnomalies: [{ kind: "unplanned_stop", count: 1 }] });
  });
});
