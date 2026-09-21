import { Router } from "express";
import { prisma } from "../db.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { suggest } from "../domain/dispatch/suggest.js";
import {
  toDriverInput,
  toLoadInput,
  toTractorInput,
  toTrailerInput,
} from "../domain/dispatch/mapper.js";
import type { TractorInput, TrailerInput } from "../domain/dispatch/types.js";
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Driver detail + "what's next" (Control Tower screen 6): the suggest engine
// inverted — rank the org's OPEN loads for one driver. Planning-aware: if the
// driver has a current assignment, the deadhead origin is that load's LAST
// DROP and availability starts at its planned end; their HosState already
// reflects the committed plan (decremented at commit). Mounted under
// dispatcherRouter with attachOrgScope.
export const dispatcherDriverNextRouter = Router();

dispatcherDriverNextRouter.get("/drivers/:id/next", asyncRoute(async (req, res) => {
  const driver = await prisma.driver.findUnique({
    where: { id: req.params.id as string },
    include: {
      hos: true,
      assignments: {
        where: { status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { plannedEnd: "desc" },
        take: 1,
        include: {
          load: {
            select: {
              id: true, externalId: true,
              stops: { orderBy: { sequence: "asc" }, select: { type: true, address: true, lat: true, lng: true } },
            },
          },
        },
      },
    },
  });
  if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
    return res.status(404).json({ error: "Driver not found" });
  }

  const current = driver.assignments[0] ?? null;
  // Future position: the last drop of the current load beats the last ping.
  const lastDrop = current
    ? [...current.load.stops].reverse().find((s) => s.type === "delivery" && s.lat != null && s.lng != null)
    : null;
  const originLat = lastDrop?.lat ?? driver.lastLat;
  const originLng = lastDrop?.lng ?? driver.lastLng;
  const availableAt = current ? current.plannedEnd.getTime() : Date.now();

  const openLoads = await prisma.load.findMany({
    where: { orgId: driver.orgId, status: "open" },
    include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } },
  });

  // Pool-pick equipment once per trailer type this batch of loads needs.
  const equipCache = new Map<string, { tractor: TractorInput; trailer: TrailerInput; tractorId: string; trailerId: string } | null>();
  async function equipmentFor(type: string) {
    if (equipCache.has(type)) return equipCache.get(type)!;
    const [tractor, trailer] = await Promise.all([
      prisma.tractor.findFirst({ where: { orgId: driver!.orgId!, status: "active" } }),
      prisma.trailer.findFirst({ where: { orgId: driver!.orgId!, type, status: { in: ["active", "idle"] } } }),
    ]);
    const value = tractor && trailer
      ? { tractor: toTractorInput(tractor), trailer: toTrailerInput(trailer), tractorId: tractor.id, trailerId: trailer.id }
      : null;
    equipCache.set(type, value);
    return value;
  }

  const driverRow = { ...driver, lastLat: originLat, lastLng: originLng };
  // The header flag comes from the driver's own HosState row — never from
  // whatever the last-iterated load happened to set.
  const hosKnown = driver.hos != null;
  const nextLoads: unknown[] = [];

  for (const load of openLoads) {
    try {
      const equipment = await equipmentFor(load.requiredEquip);
      if (!equipment) {
        nextLoads.push({
          loadId: load.id, reference: load.externalId ?? load.id, requiredEquip: load.requiredEquip,
          origin: load.stops[0]?.address ?? "", destination: load.stops[load.stops.length - 1]?.address ?? "",
          revenueCents: load.revenueCents + load.fscCents,
          feasible: false, score: null, deadheadMi: 0, marginCents: 0, marginPct: 0, etaMs: 0,
          blockedReason: `no available ${load.requiredEquip} in the pool`, warnings: [],
        });
        continue;
      }
      const mapped = toDriverInput(driverRow, { availableAt });
      const [row] = suggest(toLoadInput(load), [{
        driverId: driver.id, driver: mapped.input, tractor: equipment.tractor, trailer: equipment.trailer,
      }]);
      nextLoads.push({
        loadId: load.id, reference: load.externalId ?? load.id, requiredEquip: load.requiredEquip,
        origin: load.stops[0]?.address ?? "", destination: load.stops[load.stops.length - 1]?.address ?? "",
        revenueCents: load.revenueCents + load.fscCents,
        tractorId: equipment.tractorId, trailerId: equipment.trailerId,
        feasible: row.feasible, score: row.score, deadheadMi: row.deadheadMi,
        marginCents: row.marginCents, marginPct: row.marginPct, etaMs: row.etaMs,
        blockedReason: row.blockedReason,
        warnings: mapped.hosKnown ? row.warnings : [...row.warnings, "HOS not imported; assumes full hours"],
      });
    } catch (err) {
      nextLoads.push({
        loadId: load.id, reference: load.externalId ?? load.id, requiredEquip: load.requiredEquip,
        origin: load.stops[0]?.address ?? "", destination: load.stops[load.stops.length - 1]?.address ?? "",
        revenueCents: load.revenueCents + load.fscCents,
        feasible: false, score: null, deadheadMi: 0, marginCents: 0, marginPct: 0, etaMs: 0,
        blockedReason: err instanceof Error ? err.message : "not evaluable", warnings: [],
      });
    }
  }

  type Row = { feasible: boolean; score: number | null; deadheadMi: number };
  (nextLoads as Row[]).sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (a.feasible) return (b.score ?? 0) - (a.score ?? 0);
    return a.deadheadMi - b.deadheadMi;
  });

  res.json({
    driver: {
      id: driver.id, name: driver.name, status: driver.status,
      hazmatEndorsed: driver.hazmatEndorsed, hosKnown,
      hos: driver.hos
        ? {
            driveRemainingMin: driver.hos.driveRemainingMin,
            windowRemainingMin: driver.hos.windowRemainingMin,
            cycleRemainingMin: driver.hos.cycleRemainingMin,
            minutesSinceBreak: driver.hos.minutesSinceBreak,
            importedAt: driver.hos.importedAt,
          }
        : null,
      currentAssignment: current
        ? {
            id: current.id, loadId: current.load.id,
            loadReference: current.load.externalId ?? current.load.id,
            plannedStart: current.plannedStart, plannedEnd: current.plannedEnd,
            destination: lastDrop?.address ?? null,
          }
        : null,
      availableAt: new Date(availableAt),
    },
    nextLoads,
  });
}));
