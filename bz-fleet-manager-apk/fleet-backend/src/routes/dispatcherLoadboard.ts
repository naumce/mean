import { resolveRoutes, routeKey, type LatLng } from "../lib/routing.js";
import { truckProfileFor } from "../lib/truckProfile.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { nearestCity } from "../lib/usCities.js";
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js";
import { COVERED_LOAD_STATUSES } from "../lib/loadStatuses.js";
import { parseIdList } from "../lib/idList.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Read model for the Control Tower boards (LoadboardView + the cockpit):
// driver lanes with clocks/pairing/position, the org's tractors and trailers,
// and every load that overlaps the window or is still uncovered. Every value
// is real: clocks from HosState, positions from the last ELD/app ping,
// equipment from the live assignment (else the driver's default pairing).
// Mounted under dispatcherRouter with attachOrgScope.
export const dispatcherLoadboardRouter = Router();

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  // Optional carrier filter (T1 Carrier Layer, Task 5). Applied as a plain
  // equality condition on Driver.carrierId below — never resolved via a
  // separate "does this carrier exist" lookup first. That matters: an
  // existence check invites the tempting-but-wrong shape of "if not found,
  // fall back to unfiltered", which would show a dispatcher another
  // carrier's trucks while the UI claims it's showing one. An unknown id, or
  // one belonging to another org, simply matches zero drivers and the lane
  // list comes back empty — fails closed by construction, not by a guard.
  carrierId: z.string().min(1).optional(),
  // Plan A4: re-read exactly these loads. Every other filter — the window,
  // the carrier, the coverage rules of spec §8.2 — still applies, so an id
  // that is asked for but is not in view comes back absent, and the client
  // drops it. That is deliberate: `ids` narrows the answer, it never widens
  // it past what the board would have shown anyway.
  ids: z.string().optional(),
});

/** Runs `fn` only when no id list narrowed this request, else resolves to an
 *  empty array without a query. Plan A4: an `ids` read is answered `{ loads }`
 *  only, so the lane/tractor/trailer queries — otherwise unused by that
 *  response — are skipped outright, not just left out of the JSON. */
function skipWhenNarrowed<T>(ids: string[] | undefined, fn: () => Promise<T[]>): Promise<T[]> {
  return ids ? Promise.resolve([]) : fn();
}

const OPEN_STATUSES = ["open", "tendered"];
// LoadStop.dwellMin is nullable in the schema; the cockpit's stop contract is
// non-null, so unset dwell falls back to the engine's default.
const DEFAULT_DWELL_MIN = 60;

function cityOf(address: string | undefined): string {
  return address?.split(",")[0]?.trim() ?? "";
}

dispatcherLoadboardRouter.get("/loadboard", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "from and to (ISO datetimes) are required" });
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  const now = new Date();
  const orgFilter = orgWhere(req);
  // Same equality-filter shape orgFilter itself uses: no existence check, no
  // fallback, just a where-clause condition. Combined with orgFilter, a
  // carrierId from another org matches no driver/tractor/trailer in THIS
  // org's result set regardless of whether it's real elsewhere. Applied to
  // drivers (lanes) below, and — T1 Carrier Layer, Task 8 — to tractors and
  // trailers too: without that, a carrier-filtered board still showed every
  // carrier's yard equipment, so a dispatcher could hook a Carrier B
  // trailer onto a Carrier A driver, exactly the mixing this filter exists
  // to prevent.
  // Loads carry their own carrierId now (plan A1): a brokered load is priced
  // by ITS carrier, not by a driver's. The filter narrows covered brokered
  // loads below; the open backlog stays shared by design.
  const carrierFilter = parsed.data.carrierId ? { carrierId: parsed.data.carrierId } : {};
  const ids = parseIdList(parsed.data.ids);

  const [drivers, loads, tractors, trailers] = await Promise.all([
    skipWhenNarrowed(ids, () => prisma.driver.findMany({
      where: { ...orgFilter, ...carrierFilter },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, status: true, hazmatEndorsed: true, medicalCertExpiresAt: true,
        defaultTractorId: true, defaultTrailerId: true,
        lastLat: true, lastLng: true, lastLocationAt: true,
        // Carrier layer (T1): null = dispatched directly by the org, a real
        // state — never coerced to '' or a placeholder label. The portal
        // decides how "no carrier" renders; the wire reports the truth.
        carrierId: true,
        carrier: { select: { name: true } },
        hos: { select: { driveRemainingMin: true, windowRemainingMin: true, cycleRemainingMin: true, minutesSinceBreak: true, importedAt: true } },
        // In-window commitments feed utilization + revenue; live ones feed
        // the "current equipment" shown in the lane header.
        assignments: {
          where: {
            status: { in: [...ACTIVE_STATUSES, "completed"] },
            plannedStart: { lt: to },
            plannedEnd: { gt: from },
          },
          select: {
            plannedStart: true, plannedEnd: true, status: true, tractorId: true, trailerId: true,
            load: { select: { revenueCents: true, fscCents: true } },
          },
        },
      },
    })),
    prisma.load.findMany({
      where: {
        ...orgFilter,
        // Plan A4: narrows, never widens — every other condition below (the
        // window's OR, the carrier filter inside it) still applies, so an id
        // that does not otherwise belong on this board still comes back absent.
        ...(ids ? { id: { in: ids } } : {}),
        OR: [
          // Overlap, not start-in-window: a multi-day leg that began before
          // the window still occupies the lane.
          { assignment: { plannedStart: { lt: to }, plannedEnd: { gt: from } } },
          { status: { in: OPEN_STATUSES } },
          // Plan A3 (spec §8.3): covered brokered loads — no Assignment, a
          // carrier, a covered status. Windowed by their appointments in JS
          // below (Prisma cannot express "overlap OR has no appointments").
          { assignment: null, carrierId: { not: null }, status: { in: [...COVERED_LOAD_STATUSES] }, ...(parsed.data.carrierId ? { carrierId: parsed.data.carrierId } : {}) },
        ],
      },
      orderBy: { createdAt: "asc" },
      include: {
        stops: {
          orderBy: { sequence: "asc" },
          select: {
            sequence: true, type: true, address: true, lat: true, lng: true, dwellMin: true,
            appointment: { select: { windowStart: true, windowEnd: true } },
          },
        },
        assignment: {
          select: {
            id: true, driverId: true, tractorId: true, trailerId: true, status: true,
            plannedStart: true, plannedEnd: true, marginCents: true, deadheadMi: true, loadedMi: true, savedMi: true,
            startedAt: true, completedAt: true,
          },
        },
        // The committed rate snapshot, written only by the commit path. Its
        // absence is the difference between "never priced" and "priced at
        // break-even" — Assignment.marginCents defaults to 0 and cannot tell
        // the two apart, so the board reads economics from here instead.
        rate: { select: { estCostCents: true, marginCents: true } },
        // Plan A3: the brokered half of the record (§8.1) — the carrier a
        // covered load is priced by, and the dispatcher's own Attention
        // lines from the import/agent pipeline.
        carrier: { select: { name: true, mcNumber: true } },
        // Night Shift (spec §17, Task 3): unfiltered (was `where: { kind:
        // "attention" }`) so the newest non-attention line — `agentLine`,
        // the same concept dispatcherBrokerBoard.ts's boardRows() already
        // projects — can be derived below alongside the existing attention
        // list, from one query instead of two.
        agentUpdates: { orderBy: { atMs: "asc" }, select: { text: true, kind: true } },
      },
    }),
    skipWhenNarrowed(ids, () => prisma.tractor.findMany({
      where: { ...orgFilter, ...carrierFilter },
      orderBy: { unit: "asc" },
      select: { id: true, unit: true, make: true, cab: true, status: true, inspectionExpiresAt: true, registrationExpiresAt: true, nextServiceAt: true },
    })),
    skipWhenNarrowed(ids, () => prisma.trailer.findMany({
      where: { ...orgFilter, ...carrierFilter },
      orderBy: { unit: "asc" },
      select: { id: true, unit: true, type: true, length: true, status: true, features: true, inspectionExpiresAt: true, registrationExpiresAt: true, nextServiceAt: true, lastLat: true, lastLng: true, lastSeenAt: true },
    })),
  ]);

  const windowMs = to.getTime() - from.getTime();
  const tractorDriver = new Map<string, string>();
  const trailerDriver = new Map<string, string>();
  // A trailer's ACTIVE driver, as opposed to trailerDriver above (which also
  // folds in a driver's mere default pairing — see currentTrailerId below).
  // Populated only from `cur`, the already-ACTIVE_STATUSES-filtered live
  // assignment, never from defaultTrailerId. This is the signal
  // mapData.ts's `positionedTrailers` (fleet-portal) needs for the live map:
  // a trailer is only safe to pin when NOT on an active assignment right
  // now, because lastLat/lastLng/lastSeenAt are stamped on leg completion,
  // never on pickup — a merely-default-paired trailer that was dropped
  // weeks ago is still honestly positioned, but one actually hooked to a
  // moving truck is not. `currentDriverId` (below) intentionally keeps its
  // broader "current-or-default" meaning for its existing consumers
  // (lib/cockpit/lanes.ts's ASSIGNED/HOOKED pill, GanttBoard.vue's lane
  // driver-name lookup) — this is a separate field, not a redefinition.
  const activeTrailerDriver = new Map<string, string>();

  const lanes = drivers.map((d) => {
    let bookedMs = 0;
    let revenueCents = 0;
    for (const a of d.assignments) {
      const start = Math.max(a.plannedStart.getTime(), from.getTime());
      const end = Math.min(a.plannedEnd.getTime(), to.getTime());
      if (end > start) bookedMs += end - start;
      revenueCents += a.load.revenueCents + a.load.fscCents;
    }
    // Current equipment: the running leg first, else the next live one, else
    // the driver's default pairing. in_progress is unambiguously "now"
    // regardless of whether the plan has technically elapsed (real trips run
    // behind schedule); plannedEnd > now only weeds out stale, never-started
    // assigned/tendered commitments.
    // KNOWN LIMITATION: `d.assignments` is pre-filtered to those overlapping
    // the requested [from,to) window, so a leg running days behind schedule
    // can fall outside a today-anchored window entirely — `live` then comes
    // up empty and this silently falls back to the driver's default pairing
    // even though a real (different) unit is still out on that late leg.
    const live = d.assignments
      .filter((a) => ACTIVE_STATUSES.includes(a.status) && (a.status === "in_progress" || a.plannedEnd > now))
      .sort((a, b) =>
        a.status === "in_progress" ? -1 : b.status === "in_progress" ? 1 : a.plannedStart.getTime() - b.plannedStart.getTime(),
      );
    const cur = live[0];
    const currentTractorId = cur?.tractorId ?? d.defaultTractorId ?? null;
    const currentTrailerId = cur?.trailerId ?? d.defaultTrailerId ?? null;
    if (currentTractorId) tractorDriver.set(currentTractorId, d.id);
    if (currentTrailerId) trailerDriver.set(currentTrailerId, d.id);
    if (cur?.trailerId) activeTrailerDriver.set(cur.trailerId, d.id);
    const lastCity =
      d.lastLat != null && d.lastLng != null ? (nearestCity(d.lastLat, d.lastLng)?.label ?? null) : null;

    return {
      id: d.id,
      name: d.name,
      status: d.status,
      hosKnown: d.hos != null,
      driveRemainingMin: d.hos?.driveRemainingMin ?? null,
      windowRemainingMin: d.hos?.windowRemainingMin ?? null,
      cycleRemainingMin: d.hos?.cycleRemainingMin ?? null,
      minutesSinceBreak: d.hos?.minutesSinceBreak ?? null,
      hosImportedAt: d.hos?.importedAt ?? null,
      // utilizationPct / revenueCents: window-scoped roll-ups still consumed by
      // the legacy board's lane header (fleet-portal components/board/LaneHeader.vue);
      // the cockpit derives its own from the legs in view (lib/cockpit/lanes.ts).
      utilizationPct: windowMs > 0 ? Math.min(1, bookedMs / windowMs) : 0,
      revenueCents,
      hazmatEndorsed: d.hazmatEndorsed,
      medicalCertExpiresAt: d.medicalCertExpiresAt,
      // Null is a real state (dispatched directly by the org, no carrier
      // layer in play) — never dressed up as '' or a placeholder string.
      carrierId: d.carrierId,
      carrierName: d.carrier?.name ?? null,
      defaultTractorId: d.defaultTractorId,
      defaultTrailerId: d.defaultTrailerId,
      currentTractorId,
      currentTrailerId,
      lastLat: d.lastLat,
      lastLng: d.lastLng,
      lastLocationAt: d.lastLocationAt,
      lastCity,
    };
  });

  // Real road geometry for the lines the map draws. Only for ASSIGNED loads —
  // those are the ones rendered as routes — and cache-first, so a warm board
  // costs no provider calls at all. A load with no cached geometry simply
  // arrives with `routeGeometry: null` and the map falls back to an arc,
  // labelled as an estimate. It never blocks or slows the board into failure.
  //
  // Same resolution pass the engine's mileage uses (lib/routing.ts), so the
  // line on the map and the distance a plan is costed on come from ONE provider
  // answer. Drawing a real road while pricing a straight line would be two
  // sources for one fact, which is the defect this codebase keeps paying for.
  const geometryByLoad = new Map<string, [number, number][]>();
  try {
    const routedLoads = loads.filter((l) => l.assignment && l.stops.length >= 2);
    const pairs: [LatLng, LatLng][] = [];
    for (const l of routedLoads) {
      const pts = l.stops.filter((s) => s.lat != null && s.lng != null);
      for (let i = 0; i < pts.length - 1; i++) {
        pairs.push([
          { lat: pts[i].lat as number, lng: pts[i].lng as number },
          { lat: pts[i + 1].lat as number, lng: pts[i + 1].lng as number },
        ]);
      }
    }
    // One profile for the whole board: these loads move on the org's own
    // trailers, and the legal maximum is the safe assumption when a given load's
    // trailer is not resolved here. Under-stating dimensions would draw a line
    // through a bridge the truck cannot pass.
    const boardProfile = truckProfileFor({});
    const routes = await resolveRoutes(pairs, boardProfile);
    for (const l of routedLoads) {
      const pts = l.stops.filter((s) => s.lat != null && s.lng != null);
      const line: [number, number][] = [];
      let complete = pts.length >= 2;
      for (let i = 0; i < pts.length - 1; i++) {
        const leg = routes.get(
          routeKey(
            { lat: pts[i].lat as number, lng: pts[i].lng as number },
            { lat: pts[i + 1].lat as number, lng: pts[i + 1].lng as number },
            boardProfile,
          ),
        );
        if (!leg?.geometry) { complete = false; break; }
        line.push(...(i === 0 ? leg.geometry : leg.geometry.slice(1)));
      }
      // All-or-nothing per load: half a real road spliced to half an arc would
      // look authoritative and be wrong in the middle.
      if (complete && line.length > 1) geometryByLoad.set(l.id, line);
    }
  } catch {
    // A routing outage degrades the map to arcs; it must never 500 the board.
  }

  // Plan A3 (spec §8.3): the OR clause above already applied the carrier
  // filter and the covered-status gate at the database level — what's left
  // is windowing the covered brokered arm by its own appointments, which
  // Prisma cannot express as a single where (overlap OR "has none at all").
  // Assigned/tendered-open loads pass through untouched; they are windowed
  // (or exempted) by the query itself already.
  const inWindow = loads.filter((l) => {
    if (l.assignment || OPEN_STATUSES.includes(l.status)) return true;
    // By ROLE, not pooled across every stop: a load with only a PU
    // appointment (no DEL window yet) has an unknown end, not an end equal
    // to its pickup slot — pooling collapsed it to that slot and made it
    // disappear from every later window while still in_progress.
    const pickupStop = l.stops.find((s) => s.type === "pickup");
    const deliveryStop = [...l.stops].reverse().find((s) => s.type === "delivery");
    const startMs = pickupStop?.appointment?.windowStart?.getTime() ?? pickupStop?.appointment?.windowEnd?.getTime();
    const endMs = deliveryStop?.appointment?.windowEnd?.getTime();
    if (startMs === undefined && endMs === undefined) return l.status !== "delivered"; // unplaced: always on the board until it is done
    return (startMs ?? -Infinity) < to.getTime() && (endMs ?? Infinity) > from.getTime();
  });

  const loadsOut = inWindow.map((l) => {
      const pickup = l.stops.find((s) => s.type === "pickup") ?? l.stops[0];
      const delivery = [...l.stops].reverse().find((s) => s.type === "delivery") ?? l.stops[l.stops.length - 1];
      // Night Shift (spec §17, Task 3): `agentUpdates` is unfiltered and
      // still atMs-ascending (see the query above), so the attention list
      // keeps the exact order it has always had, and `agentLine` is the last
      // (newest) entry that is not one — the same "newest non-attention
      // AgentUpdate" concept dispatcherBrokerBoard.ts's boardRows() already
      // projects under this same field name.
      const nonAttention = l.agentUpdates.filter((a) => a.kind !== "attention");
      return {
        id: l.id,
        // A load with no ref of its own (a blank row started on Their Board)
        // is labelled by its short id, never the full UUID — same rule as
        // dispatcherRisk.ts.
        reference: l.externalId ?? l.orderRef ?? l.boardLoadNo ?? "#" + l.id.slice(0, 8),
        status: l.status,
        requiredEquip: l.requiredEquip,
        hazmatClass: l.hazmatClass,
        unNumber: l.unNumber,
        commodity: l.commodity,
        weightLbs: l.weightLbs,
        brokerName: l.brokerName,
        revenueCents: l.revenueCents + l.fscCents,
        stopCount: l.stops.length,
        /** Provider road geometry as [lng, lat] pairs, or null when none is
         *  cached — the map then draws an arc and says it is an estimate. */
        routeGeometry: geometryByLoad.get(l.id) ?? null,
        origin: cityOf(pickup?.address),
        destination: cityOf(delivery?.address),
        pickupWindowStart: pickup?.appointment?.windowStart ?? null,
        pickupWindowEnd: pickup?.appointment?.windowEnd ?? null,
        // Plan A3 (spec §8.1): the brokered half of the record.
        carrierId: l.carrierId, carrierName: l.carrier?.name ?? null, carrierMc: l.carrier?.mcNumber ?? null,
        customerName: l.customerName, updateText: l.updateText, apptText: l.apptText, shipDate: l.shipDate, boardLoadNo: l.boardLoadNo,
        version: l.version,
        // F3: the plan's own contract for this board (Global Constraints, spec
        // §8.2) — no Assignment of ours, a carrier, a covered status. NOT
        // `isBrokered()` (brokerImport.ts): that is the importer's provenance
        // predicate (true for any bolNumber/customerName/carrierId/phone/
        // contact), which made an own-driver load carrying a mere
        // `customerName` ship as `brokered: true`.
        brokered: !l.assignment && l.carrierId != null && (COVERED_LOAD_STATUSES as readonly string[]).includes(l.status),
        attention: l.agentUpdates.filter((a) => a.kind === "attention").map((a) => a.text),
        agentLine: nonAttention.length ? nonAttention[nonAttention.length - 1]!.text : null,
        agentEnabled: l.agentEnabled, agentPolicyId: l.agentPolicyId, agentPill: l.agentPill,
        deliveryWindowEnd: delivery?.appointment?.windowEnd ?? null,
        stops: l.stops.map((s) => ({
          sequence: s.sequence,
          type: s.type,
          address: s.address,
          lat: s.lat,
          lng: s.lng,
          dwellMin: s.dwellMin ?? DEFAULT_DWELL_MIN,
          windowStart: s.appointment?.windowStart ?? null,
          windowEnd: s.appointment?.windowEnd ?? null,
        })),
        assignment: l.assignment
          ? {
              id: l.assignment.id,
              driverId: l.assignment.driverId,
              tractorId: l.assignment.tractorId,
              trailerId: l.assignment.trailerId,
              status: l.assignment.status,
              plannedStart: l.assignment.plannedStart,
              plannedEnd: l.assignment.plannedEnd,
              // Legacy field, kept for the /loadboard screen which still reads it.
              // New consumers must use `economics` (null = never priced).
              marginCents: l.assignment.marginCents,
              // Null when the load has no committed Rate row: absent money is
              // absent, never a measured $0.
              economics: l.rate
                ? { estCostCents: l.rate.estCostCents, marginCents: l.rate.marginCents }
                : null,
              deadheadMi: l.assignment.deadheadMi,
              // Deadhead drive time leads the trip — drawn as the brick's
              // hatched prefix (planning speed 50 mph).
              deadheadMin: Math.round((l.assignment.deadheadMi / 50) * 60),
              loadedMi: l.assignment.loadedMi,
              savedMi: l.assignment.savedMi,
              startedAt: l.assignment.startedAt,
              completedAt: l.assignment.completedAt,
            }
          : null,
      };
  });

  // Plan A4: an `ids` read answers `loads` only — no `lanes`, `tractors` or
  // `trailers`. The lane list did not change, and sending it back would make
  // a "cheap" re-read cost the same as a full board read.
  if (ids) return res.json({ loads: loadsOut });
  res.json({
    lanes,
    tractors: tractors.map((t) => ({ ...t, currentDriverId: tractorDriver.get(t.id) ?? null })),
    trailers: trailers.map((t) => ({
      ...t,
      currentDriverId: trailerDriver.get(t.id) ?? null,
      // T2 Map fix: ONLY set when this trailer is on an active
      // (assigned/tendered/in_progress) assignment right now — never from a
      // driver's default pairing alone. See activeTrailerDriver above.
      activeDriverId: activeTrailerDriver.get(t.id) ?? null,
    })),
    loads: loadsOut,
  });
}));
