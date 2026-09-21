import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentPolicyRow, LoadForBrief } from "../../src/live/platformLoads.js";
import { buildBrief, buildContext, policyFor } from "../../src/live/platformLoads.js";
import type { RouteAnswer } from "../../src/core/types.js";
import type { RouterPort } from "../../src/ports/index.js";
import { Registry } from "../../src/live/registry.js";

const PU_END = Date.parse("2026-09-20T12:00:00Z");
const DEL_END = Date.parse("2026-09-20T20:00:00Z");

const geocodedStops = (overrides: Partial<{ carrierPhone: string | null; carrierContactName: string | null; driverCell: string | null; assignment: LoadForBrief["assignment"] }> = {}): LoadForBrief => ({
  id: "load-1",
  boardLoadNo: "T-1001",
  orderRef: null,
  requiredEquip: "DryVan",
  carrierPhone: "carrierPhone" in overrides ? overrides.carrierPhone! : "+15550001111",
  carrierContactName: "carrierContactName" in overrides ? overrides.carrierContactName! : "Milan",
  driverCell: "driverCell" in overrides ? overrides.driverCell! : null,
  agentPolicyId: null,
  assignment: overrides.assignment ?? null,
  stops: [
    { type: "pickup", address: "Kansas City, MO", lat: 39.1, lng: -94.58, geocodeStatus: "ok", appointment: { windowStart: null, windowEnd: new Date(PU_END) } },
    { type: "delivery", address: "Des Moines, IA", lat: 41.59, lng: -93.62, geocodeStatus: "ok", appointment: { windowStart: null, windowEnd: new Date(DEL_END) } },
  ],
});

describe("buildBrief", () => {
  it("a switched-on load with parsed appointments and geocoded stops becomes a brief", () => {
    const result = buildBrief(geocodedStops());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.loadRef).toBe("T-1001");
    expect(result.brief.origin).toEqual({ name: "Kansas City, MO", lat: 39.1, lng: -94.58 });
    expect(result.brief.destination).toEqual({ name: "Des Moines, IA", lat: 41.59, lng: -93.62 });
    expect(result.brief.departAtMs).toBe(PU_END);
    expect(result.brief.deadlineAtMs).toBe(DEL_END);
    expect(result.brief.driverName).toBe("Milan");
    expect(result.brief.driverPhone).toBe("+15550001111");
    expect(result.brief.customerEmail).toBeNull();
    expect(result.brief.minutesSinceBreakAtDepart).toBeNull();
  });

  it("prefers the driver on the Assignment over the carrier contact", () => {
    const load = geocodedStops({ assignment: { driver: { name: "Jake", phone: "+15559998888", hos: { minutesSinceBreak: 42 } } } });
    const result = buildBrief(load);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.driverName).toBe("Jake");
    expect(result.brief.driverPhone).toBe("+15559998888");
    expect(result.brief.minutesSinceBreakAtDepart).toBe(42);
  });

  it("an Assignment driver with hours never on file gets null, NOT zero", () => {
    const load = geocodedStops({ assignment: { driver: { name: "Jake", phone: "+15559998888", hos: null } } });
    const result = buildBrief(load);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.minutesSinceBreakAtDepart).toBeNull();
  });

  it("a load missing a phone becomes unresolvable — no brief", () => {
    const result = buildBrief(geocodedStops({ carrierPhone: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no driver or carrier phone/);
  });

  // Final fix wave, C3: a sheet row's DRIVER PHONE lands on Load.driverCell
  // (rowToPatch.ts) — the agent must dial THAT before the carrier's office.
  it("a sheet load's driverCell is the phone the agent dials, ahead of the carrier phone", () => {
    const withBoth = buildBrief(geocodedStops({ driverCell: "+15557778888", carrierPhone: "+15550001111" }));
    expect(withBoth.ok).toBe(true);
    if (!withBoth.ok) return;
    expect(withBoth.brief.driverPhone).toBe("+15557778888");
    expect(withBoth.brief.driverName).toBe("Milan");

    const noCarrier = buildBrief(geocodedStops({ driverCell: "+15557778888", carrierPhone: null }));
    expect(noCarrier.ok).toBe(true);
    if (!noCarrier.ok) return;
    expect(noCarrier.brief.driverPhone).toBe("+15557778888");
  });

  it("an Assignment driver with no phone on file falls back to the load's driverCell, then the carrier phone", () => {
    const load = geocodedStops({ driverCell: "+15557778888", assignment: { driver: { name: "Jake", phone: null, hos: null } } });
    const result = buildBrief(load);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.driverName).toBe("Jake");
    expect(result.brief.driverPhone).toBe("+15557778888");

    const nothing = buildBrief(geocodedStops({ carrierPhone: null, assignment: { driver: { name: "Jake", phone: null, hos: null } } }));
    expect(nothing.ok).toBe(false);
    if (nothing.ok) return;
    expect(nothing.reason).toMatch(/no driver or carrier phone/);
  });

  it("an un-geocoded stop is unresolvable", () => {
    const load = geocodedStops();
    load.stops[1] = { ...load.stops[1], lat: null, lng: null };
    const result = buildBrief(load);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/delivery stop not geocoded/);
  });

  it("a failed geocode is unresolvable even if lat/lng happen to be set", () => {
    const load = geocodedStops();
    load.stops[0] = { ...load.stops[0], geocodeStatus: "failed" };
    const result = buildBrief(load);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/pickup stop not geocoded/);
  });

  it("an unparsed (missing) appointment is unresolvable", () => {
    const load = geocodedStops();
    load.stops[1] = { ...load.stops[1], appointment: null };
    const result = buildBrief(load);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/can't read DEL appointment/);
  });

  it("a missing pickup or delivery stop entirely is unresolvable", () => {
    const load = geocodedStops();
    load.stops = [load.stops[0]];
    const result = buildBrief(load);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing a pickup or delivery stop/);
  });
});

// Slice "platform GPS + rich brief" (2026-09-19): everything else the
// platform knows rides along in `brief.context`.
describe("buildContext", () => {
  const driver = { id: "drv-1", name: "Rico Alvarez", phone: "+15550100200", hos: { minutesSinceBreak: 30, driveRemainingMin: 600, windowRemainingMin: 800, cycleRemainingMin: 3000 } };

  it("carries every geocoded stop in sequence, with windows and dwell, typed pickup/intermediate/delivery", () => {
    const load: LoadForBrief = {
      ...geocodedStops({ assignment: { driver } }),
      stops: [
        { type: "pickup", address: "Kansas City, MO", lat: 39.1, lng: -94.58, geocodeStatus: "ok", dwellMin: 60, appointment: { windowStart: new Date(PU_END - 3_600_000), windowEnd: new Date(PU_END) } },
        { type: "intermediate", address: "Ames, IA", lat: 42.03, lng: -93.63, geocodeStatus: "ok", dwellMin: null, appointment: null },
        { type: "delivery", address: "Des Moines, IA", lat: 41.59, lng: -93.62, geocodeStatus: "ok", dwellMin: 30, appointment: { windowStart: null, windowEnd: new Date(DEL_END) } },
      ],
      hazmatClass: "8", commodity: "Palletized freight", customerName: "Kroger", brokerName: "Landstar",
      notes: "gate closes 22:00", apptText: "FCFS 06-14", updateText: "",
    };
    const ctx = buildContext(load, driver);
    expect(ctx.driverId).toBe("drv-1");
    expect(ctx.stops.map((s) => s.type)).toEqual(["pickup", "intermediate", "delivery"]);
    expect(ctx.stops[0]).toMatchObject({ name: "Kansas City, MO", windowStartMs: PU_END - 3_600_000, windowEndMs: PU_END, dwellMin: 60 });
    expect(ctx.stops[1]).toMatchObject({ windowStartMs: null, windowEndMs: null, dwellMin: null });
    expect(ctx.hos).toEqual({ minutesSinceBreak: 30, driveRemainingMin: 600, windowRemainingMin: 800, cycleRemainingMin: 3000 });
    expect(ctx).toMatchObject({ hazmatClass: "8", commodity: "Palletized freight", customerName: "Kroger", brokerName: "Landstar", notes: "gate closes 22:00", apptText: "FCFS 06-14" });
    // An empty cell is "not known", not an empty fact.
    expect(ctx.updateText).toBeNull();
  });

  it("drops an un-geocoded stop from the planned list, and a carrier-contact load has no driverId and no HOS", () => {
    const load: LoadForBrief = {
      ...geocodedStops(),
      stops: [
        ...geocodedStops().stops,
        { type: "intermediate", address: "somewhere", lat: null, lng: null, geocodeStatus: "failed", appointment: null },
      ],
    };
    const ctx = buildContext(load, null);
    expect(ctx.stops).toHaveLength(2);
    expect(ctx.driverId).toBeNull();
    expect(ctx.hos).toBeNull();
    expect(ctx.hazmatClass).toBeNull();
  });

  it("buildBrief attaches the context", () => {
    const r = buildBrief(geocodedStops({ assignment: { driver } }));
    expect(r.ok && r.brief.context?.driverId).toBe("drv-1");
  });
});

describe("policyFor", () => {
  const standard: AgentPolicyRow = {
    id: "p-std", name: "Standard", stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60,
    offRouteMi: 3.1, offRouteMin: 10, rungGapMin: 5, maxCalls: 2, dispatcherEmail: "ops@org.example",
    dispatcherPhone: null, customerEmailOn: false, shadow: true, bossCallOn: true, quietFrom: null, quietTo: null,
  };
  const highTouch: AgentPolicyRow = { ...standard, id: "p-ht", name: "High Touch", stopMin: 5, shadow: false };

  it("prefers the load's own policy over Standard", () => {
    const policy = policyFor({ agentPolicyId: "p-ht" }, [standard, highTouch]);
    expect(policy.name).toBe("High Touch");
    expect(policy.stopMin).toBe(5);
    expect(policy.shadow).toBe(false);
  });

  it("falls back to Standard when the load has no policy of its own", () => {
    const policy = policyFor({ agentPolicyId: null }, [standard, highTouch]);
    expect(policy.name).toBe("Standard");
  });

  it("throws when the org has no Standard policy at all — never silently guesses", () => {
    expect(() => policyFor({ agentPolicyId: null }, [highTouch])).toThrow(/Standard/);
  });

  it("maps every field, name for name", () => {
    const policy = policyFor({ agentPolicyId: null }, [standard]);
    expect(policy).toEqual({
      name: "Standard", stopMin: 15, delayMin: 30, darkMin: 20, darkAtStopMin: 60,
      offRouteMi: 3.1, offRouteMin: 10, rungGapMin: 5, maxCalls: 2, dispatcherEmail: "ops@org.example",
      dispatcherPhone: null, customerEmailOn: false, shadow: true, bossCallOn: true, quietFrom: null, quietTo: null,
    });
  });
});

// The full loop against the real database named by DATABASE_URL — the same
// convention tests/live/prismaEvents.test.ts uses. Skipped, with a printed
// reason, when it is not set.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn("platformLoads.test: DATABASE_URL not set — sync-loop tests skipped");
const mod = url ? await import("../../src/live/platformLoads.js") : null;
const db = url ? await import("../../../fleet-backend/src/db.js") : null;

class FakeRouter implements RouterPort {
  async route(): Promise<RouteAnswer> {
    return { geometry: [[-94.58, 39.1], [-93.62, 41.59]], distanceMi: 179.5, driveMin: 179 };
  }
}

run("syncPlatformLoads (real database)", () => {
  const syncPlatformLoads = mod?.syncPlatformLoads as NonNullable<typeof mod>["syncPlatformLoads"];
  const prisma = db?.prisma as NonNullable<typeof db>["prisma"];
  const suffix = "plt_" + Date.now();
  const orgId = "org_" + suffix;
  let goodLoadId = "";
  let attentionLoadId = "";
  let offLoadId = "";
  let offButWatchingLoadId = "";

  async function makeStops(loadId: string): Promise<void> {
    const pu = await prisma.loadStop.create({ data: { loadId, sequence: 1, type: "pickup", address: "Kansas City, MO", lat: 39.1, lng: -94.58, geocodeStatus: "ok" } });
    await prisma.appointment.create({ data: { stopId: pu.id, windowEnd: new Date(PU_END), type: "pickup" } });
    const del = await prisma.loadStop.create({ data: { loadId, sequence: 2, type: "delivery", address: "Des Moines, IA", lat: 41.59, lng: -93.62, geocodeStatus: "ok" } });
    await prisma.appointment.create({ data: { stopId: del.id, windowEnd: new Date(DEL_END), type: "delivery" } });
  }

  beforeAll(async () => {
    await prisma.org.create({ data: { id: orgId, name: "Platform Loads Test " + suffix } });
    await prisma.agentPolicy.create({ data: { orgId, name: "Standard", dispatcherEmail: "ops+" + suffix + "@example.com", stopMin: 15 } });

    const good = await prisma.load.create({ data: { orgId, requiredEquip: "DryVan", agentEnabled: true, agentPill: "watching", boardLoadNo: "GOOD-" + suffix, carrierPhone: "+15550001111", carrierContactName: "Milan" } });
    goodLoadId = good.id;
    await makeStops(goodLoadId);

    const attention = await prisma.load.create({ data: { orgId, requiredEquip: "DryVan", agentEnabled: true, agentPill: "watching", boardLoadNo: "ATTN-" + suffix, carrierPhone: null, carrierContactName: null } });
    attentionLoadId = attention.id;
    await makeStops(attentionLoadId);

    const off = await prisma.load.create({ data: { orgId, requiredEquip: "DryVan", agentEnabled: false, agentPill: "off", boardLoadNo: "OFF-" + suffix, carrierPhone: "+15550002222", carrierContactName: "Someone" } });
    offLoadId = off.id;
    await makeStops(offLoadId);

    // Switched OFF but pill still "watching" — the shape a row has the instant
    // after a dispatcher flips the switch off and before the worker's own
    // stop lands. Only the agentEnabled WHERE clause can exclude it; the pill
    // guard alone would let it through. This isolates the switch as the gate.
    const offWatching = await prisma.load.create({ data: { orgId, requiredEquip: "DryVan", agentEnabled: false, agentPill: "watching", boardLoadNo: "OFFW-" + suffix, carrierPhone: "+15550003333", carrierContactName: "Nobody" } });
    offButWatchingLoadId = offWatching.id;
    await makeStops(offButWatchingLoadId);
  });

  afterAll(async () => {
    for (const loadId of [goodLoadId, attentionLoadId, offLoadId, offButWatchingLoadId]) {
      await prisma.agentTrip.updateMany({ where: { loadId }, data: { loadId: null } });
      await prisma.appointment.deleteMany({ where: { stop: { loadId } } });
      await prisma.loadStop.deleteMany({ where: { loadId } });
    }
    await prisma.load.deleteMany({ where: { orgId } });
    await prisma.agentPolicy.deleteMany({ where: { orgId } });
    // A DB trigger gives every Org a Plan the instant it's inserted (see
    // fleet-backend's org_default_plan() migration) — unrelated to this
    // task, but the FK it adds means the Plan has to go before the Org can.
    await prisma.plan.deleteMany({ where: { orgId } });
    await prisma.org.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("starts a trip for a resolvable switched-on load, marks an unresolvable one Attention, and never reads the switched-off one", async () => {
    const registry = new Registry(() => ({ start: async () => {}, tick: async () => {}, state: { status: "invited" } }) as never);
    await syncPlatformLoads(registry, { router: new FakeRouter(), restStopsNear: async () => [], telephonyFor: async () => ({ fromNumber: "+15550000000", callerId: "+15550000000" }) });

    const goodTrip = registry.byLoadId(goodLoadId);
    expect(goodTrip).not.toBeNull();
    expect(goodTrip?.brief.loadRef).toBe("GOOD-" + suffix);
    expect(goodTrip?.brief.driverPhone).toBe("+15550001111");
    expect(goodTrip?.policy.stopMin).toBe(15);

    const startedAgentTrip = await prisma.agentTrip.findFirst({ where: { loadId: goodLoadId } });
    expect(startedAgentTrip).not.toBeNull();

    // The switch, not the pill, is the gate (spec §17.1).
    expect(registry.byLoadId(offButWatchingLoadId)).toBeNull();
    const offWatching = await prisma.load.findUniqueOrThrow({ where: { id: offButWatchingLoadId } });
    expect(offWatching.version).toBe(0); // never touched
    expect(await prisma.agentTrip.findFirst({ where: { loadId: offButWatchingLoadId } })).toBeNull();

    expect(registry.byLoadId(attentionLoadId)).toBeNull();
    const attentionLoad = await prisma.load.findUniqueOrThrow({ where: { id: attentionLoadId } });
    expect(attentionLoad.agentPill).toBe("attention");
    expect(attentionLoad.version).toBeGreaterThan(0);
    const attentionUpdate = await prisma.agentUpdate.findFirst({ where: { loadId: attentionLoadId }, orderBy: { atMs: "desc" } });
    expect(attentionUpdate?.kind).toBe("attention");
    expect(attentionUpdate?.text).toMatch(/carrier phone/);

    expect(registry.byLoadId(offLoadId)).toBeNull();
    const offLoad = await prisma.load.findUniqueOrThrow({ where: { id: offLoadId } });
    expect(offLoad.agentPill).toBe("off"); // untouched — the query never read it
    expect(offLoad.version).toBe(0);
  });
});
