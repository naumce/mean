import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";
import { scanDetention } from "../src/lib/detentionScan.js";

// T5 Dwell and Detention, Task 4 — scanDetention assembles claims from real
// DB rows by calling the two pure functions (dwellSegments, detentionClaim);
// this file proves the assembly, not the domain math (already covered by
// dwell-segments.test.ts / dwell-detention.test.ts).

beforeEach(resetDb);

const MIN = 60_000;
const HOUR = 60 * MIN;

const DOCK_A = { lat: 39.0997, lng: -94.5786 }; // Kansas City
const DOCK_B = { lat: 41.8781, lng: -87.6298 }; // Chicago — far enough from DOCK_A
// that a driver's pings at one never fall inside the other's 0.5mi fence.

async function seedOrg(name = "Acme") {
  return prisma.org.create({ data: { name } });
}

async function seedDriver(orgId: string, name: string) {
  return prisma.driver.create({
    data: { email: `${name.replace(/\s+/g, ".").toLowerCase()}@x.com`, passwordHash: "x", name, orgId },
  });
}

async function seedAssignedLoad(
  orgId: string,
  driverId: string,
  stops: Array<{
    sequence: number;
    type?: string;
    address?: string;
    lat?: number | null;
    lng?: number | null;
    geocodeStatus?: string | null;
    detentionFreeMin?: number | null;
    windowStartMs?: number | null;
  }>,
) {
  const load = await prisma.load.create({
    data: {
      orgId,
      requiredEquip: "DryVan",
      orderRef: `REF-${Math.random().toString(36).slice(2, 8)}`,
      stops: {
        create: stops.map((s) => ({
          sequence: s.sequence,
          type: s.type ?? "delivery",
          address: s.address ?? `Stop ${s.sequence}`,
          lat: s.lat === undefined ? DOCK_A.lat : s.lat,
          lng: s.lng === undefined ? DOCK_A.lng : s.lng,
          geocodeStatus: s.geocodeStatus === undefined ? "ok" : s.geocodeStatus,
          detentionFreeMin: s.detentionFreeMin ?? null,
          ...(s.windowStartMs !== undefined
            ? {
                appointment: {
                  create: {
                    windowStart: s.windowStartMs === null ? null : new Date(s.windowStartMs),
                    windowEnd: new Date((s.windowStartMs ?? Date.now()) + 6 * HOUR),
                    type: "delivery",
                  },
                },
              }
            : {}),
        })),
      },
    },
    include: { stops: { orderBy: { sequence: "asc" } } },
  });
  await prisma.assignment.create({
    data: {
      orgId,
      loadId: load.id,
      driverId,
      plannedStart: new Date(Date.now() - 8 * HOUR),
      plannedEnd: new Date(Date.now() + HOUR),
    },
  });
  return load;
}

async function seedPings(driverId: string, center: { lat: number; lng: number }, timestampsMs: number[]) {
  for (const t of timestampsMs) {
    await prisma.driverLocation.create({
      data: { driverId, latitude: center.lat, longitude: center.lng, createdAt: new Date(t) },
    });
  }
}

describe("scanDetention", () => {
  it("a driver sitting past free time at a geocoded stop with an appointment produces a claim", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver Claim");
    const now = Date.now();
    const windowStartMs = now - 5 * HOUR;

    const load = await seedAssignedLoad(org.id, driver.id, [
      {
        sequence: 1,
        type: "delivery",
        address: "123 Elm St Dock",
        geocodeStatus: "ok",
        windowStartMs,
      },
    ]);
    const stop = load.stops[0];

    // firstSeen = now-4h, lastSeen = now-1h -> observedMin = 180.
    // clockStart = max(firstSeen, windowStart) = firstSeen (arrival after window open).
    // freeMin = org default 120 -> billableMin = 180 - 120 = 60.
    await seedPings(driver.id, DOCK_A, [
      now - 4 * HOUR,
      now - 3.5 * HOUR,
      now - 3 * HOUR,
      now - 2.5 * HOUR,
      now - 2 * HOUR,
      now - 1 * HOUR,
    ]);

    const result = await scanDetention(org.id, now - 24 * HOUR);
    const row = result.find((r) => r.stopId === stop.id);

    expect(row).toBeDefined();
    expect(row!.loadId).toBe(load.id);
    expect(row!.loadRef).toBe(load.orderRef);
    expect(row!.stopLabel).toBe("123 Elm St Dock");
    expect(row!.stopType).toBe("delivery");
    expect(row!.driverId).toBe(driver.id);
    expect(row!.driverName).toBe("Driver Claim");
    expect(row!.observedMin).toBe(180);
    expect(row!.noClaimReason).toBeNull();
    expect(row!.claim).not.toBeNull();
    expect(row!.claim!.billableMin).toBe(60);
    expect(row!.claim!.freeMin).toBe(120);
  });

  it("the same stop with geocodeStatus 'pending' produces claim: null with a stated reason, and still reports observedMin", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver Pending");
    const now = Date.now();
    const windowStartMs = now - 5 * HOUR;

    const load = await seedAssignedLoad(org.id, driver.id, [
      {
        sequence: 1,
        type: "delivery",
        address: "456 Oak Ave Dock",
        geocodeStatus: "pending",
        windowStartMs,
      },
    ]);
    const stop = load.stops[0];

    await seedPings(driver.id, DOCK_A, [
      now - 4 * HOUR,
      now - 3.5 * HOUR,
      now - 3 * HOUR,
      now - 2.5 * HOUR,
      now - 2 * HOUR,
      now - 1 * HOUR,
    ]);

    const result = await scanDetention(org.id, now - 24 * HOUR);
    const row = result.find((r) => r.stopId === stop.id);

    expect(row).toBeDefined();
    expect(row!.claim).toBeNull();
    expect(row!.noClaimReason).toBeTruthy();
    expect(row!.noClaimReason).toMatch(/precise|location/i);
    // The honest, useful fact survives even though it can't be billed.
    expect(row!.observedMin).toBe(180);
  });

  it("a second org's loads never appear", async () => {
    const orgA = await seedOrg("Org A");
    const orgB = await seedOrg("Org B");
    const driverA = await seedDriver(orgA.id, "Driver A");
    const driverB = await seedDriver(orgB.id, "Driver B");
    const now = Date.now();

    const loadA = await seedAssignedLoad(orgA.id, driverA.id, [
      { sequence: 1, type: "delivery", address: "A Dock", windowStartMs: now - 5 * HOUR, lat: DOCK_A.lat, lng: DOCK_A.lng },
    ]);
    const loadB = await seedAssignedLoad(orgB.id, driverB.id, [
      { sequence: 1, type: "delivery", address: "B Dock", windowStartMs: now - 5 * HOUR, lat: DOCK_B.lat, lng: DOCK_B.lng },
    ]);
    await seedPings(driverA.id, DOCK_A, [now - 4 * HOUR, now - 1 * HOUR]);
    await seedPings(driverB.id, DOCK_B, [now - 4 * HOUR, now - 1 * HOUR]);

    const result = await scanDetention(orgA.id, now - 24 * HOUR);

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.loadId === loadA.id)).toBe(true);
    expect(result.find((r) => r.stopId === loadB.stops[0].id)).toBeUndefined();
    expect(result.find((r) => r.loadId === loadB.id)).toBeUndefined();
  });

  it("free time resolves stop -> org: a stop's override changes the outcome the org default would not", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver FreeMin");
    const now = Date.now();
    const t0 = now - 3 * HOUR; // stop with no override (inherits org default 120)
    const t1 = now - 6 * HOUR; // stop with a 30-minute override

    const load = await seedAssignedLoad(org.id, driver.id, [
      {
        sequence: 1,
        type: "delivery",
        address: "Org-default stop",
        lat: DOCK_A.lat,
        lng: DOCK_A.lng,
        detentionFreeMin: null,
        windowStartMs: t0,
      },
      {
        sequence: 2,
        type: "delivery",
        address: "Override stop",
        lat: DOCK_B.lat,
        lng: DOCK_B.lng,
        detentionFreeMin: 30,
        windowStartMs: t1,
      },
    ]);
    const [stopDefault, stopOverride] = load.stops;

    // Same 90-minute dwell shape at both stops (span t..t+90m, arrival == window open).
    await seedPings(driver.id, DOCK_A, [t0, t0 + 30 * MIN, t0 + 60 * MIN, t0 + 90 * MIN]);
    await seedPings(driver.id, DOCK_B, [t1, t1 + 30 * MIN, t1 + 60 * MIN, t1 + 90 * MIN]);

    const result = await scanDetention(org.id, now - 24 * HOUR);
    const rowDefault = result.find((r) => r.stopId === stopDefault.id);
    const rowOverride = result.find((r) => r.stopId === stopOverride.id);

    expect(rowDefault).toBeDefined();
    expect(rowOverride).toBeDefined();

    // Org default (120 min free): 90 minutes of dwell never clears free time.
    expect(rowDefault!.observedMin).toBe(90);
    expect(rowDefault!.claim).toBeNull();
    expect(rowDefault!.noClaimReason).toMatch(/free time/i);

    // Stop override (30 min free): the same 90-minute dwell bills 60 minutes.
    expect(rowOverride!.observedMin).toBe(90);
    expect(rowOverride!.claim).not.toBeNull();
    expect(rowOverride!.claim!.freeMin).toBe(30);
    expect(rowOverride!.claim!.billableMin).toBe(60);
  });

  it("a stop's explicit detentionFreeMin: 0 is honored, not silently replaced by the org default", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver ZeroFree");
    const now = Date.now();
    const t0 = now - 2 * HOUR;

    const load = await seedAssignedLoad(org.id, driver.id, [
      {
        sequence: 1,
        type: "delivery",
        address: "No-free-time stop",
        detentionFreeMin: 0,
        windowStartMs: t0,
      },
    ]);
    const stop = load.stops[0];

    // 10 minutes of dwell. Under the (buggy) `||` pattern, freeMin 0 would
    // fall through to the org's 120 and produce no claim. Under `??`, 0 is
    // honored and the full 10 minutes is billable.
    await seedPings(driver.id, DOCK_A, [t0, t0 + 5 * MIN, t0 + 10 * MIN]);

    const result = await scanDetention(org.id, now - 24 * HOUR);
    const row = result.find((r) => r.stopId === stop.id);

    expect(row).toBeDefined();
    expect(row!.claim).not.toBeNull();
    expect(row!.claim!.freeMin).toBe(0);
    expect(row!.claim!.billableMin).toBe(10);
  });
});

// Controller addition, found by T5's live pass. The first real run returned 41
// rows, 38 of them historical stops with no pings at all, each saying "no
// appointment". Technically honest, practically unusable — the three real
// scenarios were buried. A stop where nothing was ever observed has no
// detention story; a stop with a real dwell we cannot bill still does.
describe("scanDetention omits stops with no observed dwell", () => {
  it("drops a never-seen stop but keeps a real dwell it cannot bill", async () => {
    const org = await seedOrg();
    const driver = await seedDriver(org.id, "Driver Mixed");
    const now = Date.now();

    // Stop 1: pings present, real dwell, but an untrustworthy geocode — this
    // is the bad-geocode case and it MUST survive the filter, stating why it
    // cannot be claimed.
    // Stop 2 (Chicago): the driver was never there, so no pings fall in its
    // fence at all. Nothing to report.
    const load = await seedAssignedLoad(org.id, driver.id, [
      { sequence: 1, type: "pickup", address: "Imprecise KC address", geocodeStatus: "pending", windowStartMs: now - 5 * HOUR },
      { sequence: 2, type: "delivery", address: "Chicago dock", lat: DOCK_B.lat, lng: DOCK_B.lng, geocodeStatus: "ok", windowStartMs: now - 5 * HOUR },
    ]);
    await seedPings(driver.id, DOCK_A, [now - 4 * HOUR, now - 3 * HOUR, now - 2 * HOUR]);

    const rows = await scanDetention(org.id, now - 72 * HOUR);

    const seen = rows.find((r) => r.stopId === load.stops[0].id);
    const unseen = rows.find((r) => r.stopId === load.stops[1].id);

    expect(unseen).toBeUndefined();
    expect(seen).toBeDefined();
    expect(seen!.claim).toBeNull();
    expect(seen!.observedMin).toBeGreaterThan(0);
    expect(seen!.noClaimReason).toMatch(/precise/i);
  });
});
