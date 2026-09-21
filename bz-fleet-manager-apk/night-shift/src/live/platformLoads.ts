// Loads in (spec §7.1, amended by §17.1: the switch is the only gate — no
// auto-start). Every 60 s the worker asks this module to bring the registry
// in line with the board: start a trip for every switched-on load that does
// not have one yet, and stop every running trip whose load was switched off
// or delivered.
import { prisma } from "../../../fleet-backend/src/db.js";
import type { Policy } from "../core/policy.js";
import type { Brief, BriefContext, BriefStop, LngLat, Place, RestStop } from "../core/types.js";
import type { RouterPort } from "../ports/index.js";
import { log } from "./log.js";
import { loadMemory } from "./memoryLoader.js";
import { PrismaEvents } from "./prismaEvents.js";
import type { Registry } from "./registry.js";
import { newDriverToken, newTripId } from "./tokens.js";

/** Only Standard-policy field parity matters here — see `policyFor` below,
 *  which re-implements fleet-backend's `policyFor` locally rather than
 *  importing backend TypeScript beyond the shared Prisma client. */
const STANDARD_POLICY_NAME = "Standard";

interface AppointmentRow {
  windowStart: Date | null;
  windowEnd: Date;
}

interface StopRow {
  type: string;
  address: string;
  lat: number | null;
  lng: number | null;
  geocodeStatus: string | null;
  dwellMin?: number | null;
  appointment: AppointmentRow | null;
}

interface HosRow {
  minutesSinceBreak: number;
  driveRemainingMin?: number;
  windowRemainingMin?: number;
  cycleRemainingMin?: number;
}

interface DriverRow {
  id?: string;
  name: string;
  phone: string | null;
  hos: HosRow | null;
}

interface AssignmentRow {
  driver: DriverRow;
}

/** The columns and relations `buildBrief` and `policyFor` need. A row from
 *  `prisma.load.findMany` is a structural superset of this — extra fields
 *  (orgId, createdAt, …) are simply ignored — which is what lets these two
 *  functions be tested with plain object literals, no database. */
export interface LoadForBrief {
  id: string;
  boardLoadNo: string | null;
  orderRef: string | null;
  requiredEquip: string;
  carrierPhone: string | null;
  carrierContactName: string | null;
  /** The driver's own cell, when the load knows it — a sheet row's DRIVER
   *  PHONE column lands here (fleet-backend rowToPatch.ts). Optional so the
   *  older fixtures still type-check; a missing column reads as "unknown". */
  driverCell?: string | null;
  agentPolicyId: string | null;
  stops: StopRow[];
  assignment: AssignmentRow | null;
  // The rich-brief columns. All optional on the input type so the existing
  // fixtures (and a caller that only has the old columns) still build a
  // brief — a missing column reads as "not known" in the context.
  hazmatClass?: string | null;
  commodity?: string | null;
  customerName?: string | null;
  brokerName?: string | null;
  notes?: string | null;
  apptText?: string | null;
  updateText?: string | null;
  /** Night Shift sheet slices: the customer's email off the connected sheet
   *  row, when known. */
  customerEmail?: string | null;
}

export interface AgentPolicyRow {
  id: string;
  name: string;
  stopMin: number;
  delayMin: number;
  darkMin: number;
  darkAtStopMin: number;
  offRouteMi: number;
  offRouteMin: number;
  rungGapMin: number;
  maxCalls: number;
  dispatcherEmail: string;
  dispatcherPhone: string | null;
  customerEmailOn: boolean;
  shadow: boolean;
  bossCallOn: boolean;
  quietFrom: string | null;
  quietTo: string | null;
}

export type BriefResult = { ok: true; brief: Brief } | { ok: false; reason: string };

/** Brief building (§7.1/§6.3, as this task's brief restates them):
 *  `loadRef` = the board's LOAD# (falling back to the TMS order ref, then
 *  the row id, for a load that never carried a board number); origin/
 *  destination from the pickup/delivery `LoadStop`; `departAtMs`/
 *  `deadlineAtMs` from the PU/DEL appointment's `windowEnd` (board
 *  appointments are single instants); the driver's own name/phone when the
 *  load has an `Assignment`, else the carrier contact. Anything that does
 *  not resolve returns a reason instead of a brief — the caller turns that
 *  into the load's Attention pill and tries again next poll. */
export function buildBrief(load: LoadForBrief): BriefResult {
  const pickup = load.stops.find((s) => s.type === "pickup");
  const delivery = [...load.stops].reverse().find((s) => s.type === "delivery");
  if (!pickup || !delivery) return { ok: false, reason: "missing a pickup or delivery stop" };
  if (pickup.lat == null || pickup.lng == null || pickup.geocodeStatus === "failed") return { ok: false, reason: "pickup stop not geocoded" };
  if (delivery.lat == null || delivery.lng == null || delivery.geocodeStatus === "failed") return { ok: false, reason: "delivery stop not geocoded" };
  if (!pickup.appointment) return { ok: false, reason: "can't read PU appointment" };
  if (!delivery.appointment) return { ok: false, reason: "can't read DEL appointment" };

  const departAtMs = pickup.appointment.windowEnd.getTime();
  const deadlineAtMs = delivery.appointment.windowEnd.getTime();
  if (!(deadlineAtMs > departAtMs)) return { ok: false, reason: "DEL appointment is not after PU appointment" };

  // Final fix wave, C3: the Assignment driver's phone first, then the load's
  // own driverCell (a sheet row's DRIVER PHONE), then the carrier's office —
  // a sheet load has no Assignment, and its driver's cell was never the
  // carrier phone.
  const driver = load.assignment?.driver ?? null;
  const driverPhone = driver?.phone ?? load.driverCell ?? load.carrierPhone;
  if (!driverPhone) return { ok: false, reason: "no driver or carrier phone on file" };
  const driverName = driver?.name ?? load.carrierContactName ?? "Carrier contact";

  const origin: Place = { name: pickup.address, lat: pickup.lat, lng: pickup.lng };
  const destination: Place = { name: delivery.address, lat: delivery.lat, lng: delivery.lng };
  const loadRef = load.boardLoadNo ?? load.orderRef ?? load.id;
  const minutesSinceBreakAtDepart = driver ? (driver.hos?.minutesSinceBreak ?? null) : null;
  const context = buildContext(load, driver);

  return {
    ok: true,
    brief: {
      loadRef, origin, destination, equipment: load.requiredEquip, departAtMs, deadlineAtMs,
      driverName, driverPhone,
      customerEmail: load.customerEmail ?? null,
      minutesSinceBreakAtDepart,
      context,
    },
  };
}

const blank = (s: string | null | undefined): string | null => (s && s.trim() ? s : null);

/** The rest of what the platform knows (see `BriefContext`). Only geocoded
 *  stops make the list — a stop with no coordinates cannot be "planned" in
 *  the geometric sense the stop rule needs — and the full HOS clock is
 *  carried only when every field is present, never partially invented. */
export function buildContext(load: LoadForBrief, driver: DriverRow | null): BriefContext {
  const stops: BriefStop[] = load.stops
    .filter((s) => s.lat != null && s.lng != null && s.geocodeStatus !== "failed")
    .map((s) => ({
      type: s.type === "pickup" || s.type === "delivery" ? s.type : "intermediate",
      name: s.address, lat: s.lat as number, lng: s.lng as number,
      windowStartMs: s.appointment?.windowStart?.getTime() ?? null,
      windowEndMs: s.appointment?.windowEnd.getTime() ?? null,
      dwellMin: s.dwellMin ?? null,
    }));
  const h = driver?.hos ?? null;
  const hos = h && h.driveRemainingMin != null && h.windowRemainingMin != null && h.cycleRemainingMin != null
    ? { driveRemainingMin: h.driveRemainingMin, windowRemainingMin: h.windowRemainingMin, cycleRemainingMin: h.cycleRemainingMin, minutesSinceBreak: h.minutesSinceBreak }
    : null;
  return {
    driverId: driver?.id ?? null,
    stops,
    hazmatClass: blank(load.hazmatClass), commodity: blank(load.commodity),
    customerName: blank(load.customerName), brokerName: blank(load.brokerName),
    notes: blank(load.notes), apptText: blank(load.apptText), updateText: blank(load.updateText),
    hos,
  };
}

/** The load's own policy, else the org's Standard, else throw — re-implemented
 *  locally per this task's brief rather than importing fleet-backend's
 *  `policyFor` (TypeScript beyond `db.js` is off limits). Field names match
 *  `AgentPolicy` and `Policy` exactly by design; this is the one place that
 *  maps a database row onto the core's `Policy` shape. */
export function policyFor(load: { agentPolicyId: string | null }, policies: readonly AgentPolicyRow[]): Policy {
  const own = load.agentPolicyId ? policies.find((p) => p.id === load.agentPolicyId) : undefined;
  const std = policies.find((p) => p.name === STANDARD_POLICY_NAME);
  const row = own ?? std;
  if (!row) throw new Error("org has no Standard agent policy — seed it");
  return {
    name: row.name, stopMin: row.stopMin, delayMin: row.delayMin, darkMin: row.darkMin, darkAtStopMin: row.darkAtStopMin,
    offRouteMi: row.offRouteMi, offRouteMin: row.offRouteMin, rungGapMin: row.rungGapMin, maxCalls: row.maxCalls,
    dispatcherEmail: row.dispatcherEmail, dispatcherPhone: row.dispatcherPhone, customerEmailOn: row.customerEmailOn,
    shadow: row.shadow, bossCallOn: row.bossCallOn, quietFrom: row.quietFrom, quietTo: row.quietTo,
  };
}

async function markAttention(loadId: string, reason: string): Promise<void> {
  await prisma.$transaction([
    prisma.load.update({ where: { id: loadId }, data: { agentPill: "attention", version: { increment: 1 } } }),
    prisma.agentUpdate.create({ data: { loadId, atMs: BigInt(Date.now()), kind: "attention", text: "ATTENTION — " + reason } }),
  ]);
  log("warn", "platform loads: load unresolvable, will retry next poll", { loadId, reason });
}

export interface PlatformLoadsDeps {
  router: RouterPort;
  restStopsNear: (geometry: LngLat[], orgId: string | null) => Promise<RestStop[]>;
  /** The org's own SMS sender and caller id, or the env fallback — resolved
   *  once per trip start (orgTelephony.ts). The fallback numbers are baked
   *  into this function by the caller (worker.ts), so this module never
   *  imports `config` directly. */
  telephonyFor: (orgId: string) => Promise<{ fromNumber: string; callerId: string }>;
}

async function startTripForLoad(registry: Registry, deps: PlatformLoadsDeps, load: { id: string; orgId: string }, briefIn: Brief, policy: Policy): Promise<void> {
  try {
    // Slice 4: what past runs remember about these stops, this driver and
    // this lane rides on the brief's context. Never fatal — see loadMemory.
    const brief: Brief = briefIn.context ? { ...briefIn, context: { ...briefIn.context, memory: await loadMemory(load.orgId, load.id, briefIn) } } : briefIn;
    const route = await deps.router.route(brief.origin, brief.destination, { equipment: brief.equipment, departAtMs: brief.departAtMs });
    const restStops = await deps.restStopsNear(route.geometry, load.orgId);
    const telephony = await deps.telephonyFor(load.orgId);
    const ids = { tripId: newTripId(), driverToken: newDriverToken() };
    await PrismaEvents.createTrip({ tripId: ids.tripId, loadRef: brief.loadRef, driverToken: ids.driverToken, brief });
    await prisma.agentTrip.update({ where: { id: ids.tripId }, data: { loadId: load.id } });
    await registry.start(brief, ids, { restStops, policy, loadId: load.id, orgId: load.orgId, sender: telephony.fromNumber, callerId: telephony.callerId });
  } catch (e) {
    await markAttention(load.id, "could not start: " + (e instanceof Error ? e.message : String(e)));
  }
}

/** Stops every running trip whose load was switched off or reached
 *  delivered since it started, by re-reading exactly those loads' current
 *  state (never the whole board). */
async function stopFinishedLoads(registry: Registry): Promise<void> {
  const loadIds = registry.watchedLoadIds();
  if (loadIds.length === 0) return;
  const rows = await prisma.load.findMany({ where: { id: { in: loadIds } }, select: { id: true, agentEnabled: true, agentPill: true } });
  const found = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    if (row.agentEnabled && row.agentPill !== "delivered") continue;
    const trip = registry.byLoadId(row.id);
    if (trip) {
      await registry.stop(trip.tripId);
      log("info", "platform loads: trip stopped", { loadId: row.id, reason: row.agentEnabled ? "delivered" : "switched off" });
    }
  }
  // A watched loadId that no longer exists at all (deleted) is stopped too —
  // there is nothing left on the board to keep watching.
  for (const loadId of loadIds) {
    if (found.has(loadId)) continue;
    const trip = registry.byLoadId(loadId);
    if (trip) {
      await registry.stop(trip.tripId);
      log("warn", "platform loads: trip stopped — its load no longer exists", { loadId });
    }
  }
}

async function startEligibleLoads(registry: Registry, deps: PlatformLoadsDeps): Promise<void> {
  const loads = await prisma.load.findMany({
    where: { agentEnabled: true },
    include: {
      stops: { orderBy: { sequence: "asc" }, include: { appointment: true } },
      assignment: { include: { driver: { include: { hos: true } } } },
    },
  });

  const byOrg = new Map<string, typeof loads>();
  for (const load of loads) {
    if (registry.byLoadId(load.id)) continue; // already watched
    if (load.agentPill === "delivered" || load.agentPill === "off") continue; // do not auto-restart a finished or switched-off load
    const list = byOrg.get(load.orgId) ?? [];
    list.push(load);
    byOrg.set(load.orgId, list);
  }

  // Grouped by org so the policy table is read once per org, not once per
  // load — the batching this task's brief asks for.
  for (const [orgId, orgLoads] of byOrg) {
    const policies = await prisma.agentPolicy.findMany({ where: { orgId } });
    for (const load of orgLoads) {
      // One load's failure is that load's problem. Without this, a throw
      // from the brief builder or the attention write abandoned every load
      // after it in the same tick — every other truck on the board waited a
      // full poll for one bad row (Task 4 review).
      try {
        const resolved = buildBrief(load);
        if (!resolved.ok) {
          await markAttention(load.id, resolved.reason);
          continue;
        }
        let policy: Policy;
        try {
          policy = policyFor(load, policies);
        } catch (e) {
          await markAttention(load.id, e instanceof Error ? e.message : String(e));
          continue;
        }
        await startTripForLoad(registry, deps, load, resolved.brief, policy);
      } catch (e) {
        log("error", "platform loads: one load failed this tick; continuing with the rest", {
          loadId: load.id, error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

/** The worker's per-tick sync: bring the registry in line with the board.
 *  Stops run before starts so a load that was switched off and back on in
 *  the same minute ends up watched, not stuck mid-teardown. */
export async function syncPlatformLoads(registry: Registry, deps: PlatformLoadsDeps): Promise<void> {
  await stopFinishedLoads(registry);
  await startEligibleLoads(registry, deps);
}
