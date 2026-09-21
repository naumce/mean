// Fetches the rows `core/memory.ts` folds (slice 4, 2026-09-19). Called
// once per trip start, so a few queries per switched-on load. Every lookup
// is bounded (newest N) so an org with years of history does not make the
// agent read it all before the first ping.
import { prisma } from "../../../fleet-backend/src/db.js";
import { driverMemory, laneMemory, placeMemory, type DriverTripRows, type LaneRunRows, type PlaceVisitRows, type TripMemory } from "../core/memory.js";
import type { Brief } from "../core/types.js";
import { log } from "./log.js";

const MAX_VISITS = 10;
const MAX_TRIPS = 20;
const MAX_RUNS = 20;

export const cityOf = (address: string): string => address.split(",")[0]?.trim() ?? "";

/** Past completed visits to a stop with the same address in the same org:
 *  the assigned driver's pings from planned start to completion. */
async function visitsTo(orgId: string, loadId: string, address: string, at: { lat: number; lng: number }): Promise<PlaceVisitRows[]> {
  const stops = await prisma.loadStop.findMany({
    where: { address, load: { orgId, id: { not: loadId }, assignment: { status: "completed" } } },
    select: { load: { select: { assignment: { select: { driverId: true, plannedStart: true, completedAt: true } } } } },
    orderBy: { load: { createdAt: "desc" } },
    take: MAX_VISITS,
  });
  const out: PlaceVisitRows[] = [];
  for (const s of stops) {
    const a = s.load.assignment;
    if (!a || !a.completedAt) continue;
    const rows = await prisma.driverLocation.findMany({
      where: { driverId: a.driverId, createdAt: { gte: a.plannedStart, lte: a.completedAt } },
      select: { latitude: true, longitude: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    out.push({ address, at, pings: rows.map((r) => ({ atMs: r.createdAt.getTime(), lat: r.latitude, lng: r.longitude })) });
  }
  return out;
}

async function tripsOf(driverId: string, excludingLoadId: string): Promise<DriverTripRows[]> {
  const trips = await prisma.agentTrip.findMany({
    where: { loadId: { not: excludingLoadId }, brief: { path: ["context", "driverId"], equals: driverId } },
    select: { events: { select: { kind: true, evidence: true }, orderBy: { atMs: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: MAX_TRIPS,
  });
  return trips.map((t) => ({ events: t.events.map((e) => ({ kind: e.kind, evidence: (e.evidence ?? {}) as Record<string, unknown> })) }));
}

async function runsOn(orgId: string, loadId: string, from: string, to: string): Promise<LaneRunRows[]> {
  // Same first city on the pickup and the delivery, in this org, run before.
  const loads = await prisma.load.findMany({
    where: { orgId, id: { not: loadId }, assignment: { isNot: null } },
    select: {
      stops: { select: { type: true, address: true, appointment: { select: { windowEnd: true } } }, orderBy: { sequence: "asc" } },
      assignment: { select: { completedAt: true } },
      agentTrips: { select: { events: { where: { kind: "anomaly" }, select: { evidence: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_RUNS * 5,
  });
  const runs: LaneRunRows[] = [];
  for (const l of loads) {
    const pu = l.stops.find((s) => s.type === "pickup") ?? l.stops[0];
    const del = [...l.stops].reverse().find((s) => s.type === "delivery") ?? l.stops[l.stops.length - 1];
    if (!pu || !del || cityOf(pu.address) !== from || cityOf(del.address) !== to) continue;
    const deadline = del.appointment?.windowEnd?.getTime();
    if (deadline == null) continue;
    const anomalyKinds = l.agentTrips.flatMap((t) => t.events.map((e) => String((e.evidence as Record<string, unknown>).kind ?? ""))).filter(Boolean);
    runs.push({ deadlineMs: deadline, completedMs: l.assignment?.completedAt?.getTime() ?? null, anomalyKinds });
    if (runs.length >= MAX_RUNS) break;
  }
  return runs;
}

/** Everything the platform remembers that bears on this run. A lookup that
 *  fails leaves that part of the memory empty and is logged — a memory
 *  that cannot be read must never keep a trip from starting. */
export async function loadMemory(orgId: string, loadId: string, brief: Brief): Promise<TripMemory> {
  const memory: TripMemory = { places: {}, driver: null, lane: null };
  const stops = brief.context?.stops ?? [];
  for (const s of stops) {
    try {
      const visits = await visitsTo(orgId, loadId, s.name, s);
      if (visits.length) memory.places = { ...memory.places, [s.name]: placeMemory(s.name, visits) };
    } catch (e) {
      log("warn", "memory: place lookup failed", { address: s.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const driverId = brief.context?.driverId ?? null;
  if (driverId) {
    try {
      memory.driver = driverMemory(await tripsOf(driverId, loadId));
    } catch (e) {
      log("warn", "memory: driver lookup failed", { driverId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  try {
    const from = cityOf(brief.origin.name), to = cityOf(brief.destination.name);
    memory.lane = laneMemory(from, to, await runsOn(orgId, loadId, from, to));
  } catch (e) {
    log("warn", "memory: lane lookup failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return memory;
}
