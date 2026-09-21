// Slice "platform GPS + rich brief" (2026-09-19): the fleet's own
// `DriverLocation` rows reach the agent, and a status line that has not
// changed is not appended again (NS-D1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Brief, Ping } from "../../src/core/types.js";
import { Registry } from "../../src/live/registry.js";

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn("platformPings.test: DATABASE_URL not set — skipped");
const pings = url ? await import("../../src/live/platformPings.js") : null;
const sheet = url ? await import("../../src/live/platformSheet.js") : null;
const db = url ? await import("../../../fleet-backend/src/db.js") : null;

const T0 = Date.parse("2026-09-20T12:00:00Z");
const briefFor = (driverId: string | null): Brief => ({
  loadRef: "W-1", origin: { name: "KC", lat: 39.1, lng: -94.58 }, destination: { name: "DSM", lat: 41.59, lng: -93.62 },
  equipment: "DryVan", departAtMs: T0, deadlineAtMs: T0 + 8 * 3_600_000, driverName: "Rico", driverPhone: "+15550100200", customerEmail: null,
  minutesSinceBreakAtDepart: 0,
  context: { driverId, stops: [], hazmatClass: null, commodity: null, customerName: null, brokerName: null, notes: null, apptText: null, updateText: null, hos: null },
});

/** A registry whose "agent" only records the pings it was handed. */
function recordingRegistry(): { registry: Registry; seen: Record<string, Ping[]> } {
  const seen: Record<string, Ping[]> = {};
  const registry = new Registry(({ tripId }) => {
    seen[tripId] = [];
    return { start: async () => {}, state: { status: "assigned" }, onPing: async (p: Ping) => { seen[tripId] = [...seen[tripId], p]; }, tick: async () => {} } as never;
  });
  return { registry, seen };
}

run("PlatformPings (real database)", () => {
  const prisma = db?.prisma as NonNullable<typeof db>["prisma"];
  const suffix = "pp_" + Date.now();
  const orgId = "org_" + suffix;
  let driverId = "";
  let loadId = "";

  beforeAll(async () => {
    await prisma.org.create({ data: { id: orgId, name: "Platform Pings Test " + suffix } });
    const d = await prisma.driver.create({ data: { orgId, email: suffix + "@example.com", passwordHash: "x", name: "Rico", phone: "+15550100200" } });
    driverId = d.id;
    const l = await prisma.load.create({ data: { orgId, requiredEquip: "DryVan", agentEnabled: true, agentPill: "watching", boardLoadNo: "PP-" + suffix } });
    loadId = l.id;
  });

  afterAll(async () => {
    await prisma.agentUpdate.deleteMany({ where: { loadId } });
    await prisma.driverLocation.deleteMany({ where: { driverId } });
    await prisma.load.deleteMany({ where: { orgId } });
    await prisma.driver.deleteMany({ where: { orgId } });
    await prisma.org.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("hands the platform's fixes since the trip started to the agent, oldest first, and never the same fix twice", async () => {
    const { registry, seen } = recordingRegistry();
    // A fix from BEFORE the switch was flipped must not be replayed.
    await prisma.driverLocation.create({ data: { driverId, latitude: 38.0, longitude: -95.0, createdAt: new Date(Date.now() - 60_000) } });
    const { tripId } = await registry.start(briefFor(driverId), { tripId: "t_" + suffix, driverToken: "tok_" + suffix }, { restStops: [], policy: { name: "Standard" } as never, loadId, orgId, sender: "+15550001111", callerId: "+15550001111" });

    const feed = new pings!.PlatformPings();
    await feed.feed(registry);
    expect(seen[tripId]).toHaveLength(0);

    const a = await prisma.driverLocation.create({ data: { driverId, latitude: 39.2, longitude: -94.6, createdAt: new Date(Date.now() + 1_000) } });
    const b = await prisma.driverLocation.create({ data: { driverId, latitude: 39.3, longitude: -94.62, createdAt: new Date(Date.now() + 2_000) } });
    await feed.feed(registry);
    expect(seen[tripId].map((p) => [p.lat, p.atMs])).toEqual([[39.2, a.createdAt.getTime()], [39.3, b.createdAt.getTime()]]);

    await feed.feed(registry);
    expect(seen[tripId]).toHaveLength(2);
  });

  it("a trip with no platform driver (carrier contact) is left to its own link", async () => {
    const { registry, seen } = recordingRegistry();
    const { tripId } = await registry.start(briefFor(null), { tripId: "t2_" + suffix, driverToken: "tok2_" + suffix }, { restStops: [], policy: { name: "Standard" } as never, orgId, sender: "+15550001111", callerId: "+15550001111" });
    await new pings!.PlatformPings().feed(registry);
    expect(seen[tripId]).toHaveLength(0);
  });

  it("PlatformSheet.writeStatus moves the pill every time but appends a line only when it changed (NS-D1)", async () => {
    const s = new sheet!.PlatformSheet(loadId, false);
    const cells = { "Agent Status": "Attention — route unusable", "Last Position": "Kansas City, MO" };
    await s.writeStatus("W-1", cells);
    await s.writeStatus("W-1", cells);
    await s.writeStatus("W-1", cells);
    const rows = await prisma.agentUpdate.findMany({ where: { loadId } });
    expect(rows).toHaveLength(1);
    expect((await prisma.load.findUnique({ where: { id: loadId } }))?.agentPill).toBe("attention");

    await s.writeStatus("W-1", { ...cells, "Last Position": "Liberty, MO" });
    expect(await prisma.agentUpdate.count({ where: { loadId } })).toBe(2);
  });
});
