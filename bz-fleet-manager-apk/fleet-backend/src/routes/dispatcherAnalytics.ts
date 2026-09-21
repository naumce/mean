import { Router } from "express";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { laneKey } from "../lib/lanes.js";
import { centsToUsd, fractionToPct, sendCsv, toCsv } from "../lib/csvOut.js";
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Broker/customer profitability (V2 analytics): committed economics rolled up
// per brokerName so a fleet can see which freight relationships make money.
// Source of truth is the Rate snapshot written at commit (deleted on
// unassign), scoped away from canceled loads. Mounted under dispatcherRouter
// with attachOrgScope.
export const dispatcherAnalyticsRouter = Router();

const UNATTRIBUTED = "(no broker)";

dispatcherAnalyticsRouter.get("/analytics/brokers", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);

  const rates = await prisma.rate.findMany({
    where: {
      load: {
        ...("orgId" in scope ? { orgId: scope.orgId } : {}),
        status: { notIn: ["canceled"] },
      },
    },
    select: {
      linehaulCents: true, fscCents: true, estCostCents: true, marginCents: true,
      loadedMi: true, deadheadMi: true, totalMi: true,
      load: { select: { brokerName: true } },
    },
  });

  const byBroker = new Map<string, {
    broker: string; loads: number; revenueCents: number; estCostCents: number;
    marginCents: number; loadedMi: number; deadheadMi: number; totalMi: number;
  }>();

  for (const r of rates) {
    const broker = r.load.brokerName?.trim() || UNATTRIBUTED;
    const row = byBroker.get(broker) ?? {
      broker, loads: 0, revenueCents: 0, estCostCents: 0, marginCents: 0,
      loadedMi: 0, deadheadMi: 0, totalMi: 0,
    };
    row.loads += 1;
    row.revenueCents += r.linehaulCents + r.fscCents;
    row.estCostCents += r.estCostCents;
    row.marginCents += r.marginCents;
    row.loadedMi += r.loadedMi;
    row.deadheadMi += r.deadheadMi;
    row.totalMi += r.totalMi;
    byBroker.set(broker, row);
  }

  const brokers = [...byBroker.values()]
    .map((b) => ({
      ...b,
      avgMarginPct: b.revenueCents > 0 ? b.marginCents / b.revenueCents : 0,
      ratePerLoadedMiCents: b.loadedMi > 0 ? Math.round(b.revenueCents / b.loadedMi) : 0,
      deadheadPct: b.totalMi > 0 ? b.deadheadMi / b.totalMi : 0,
    }))
    .sort((a, b) => b.marginCents - a.marginCents);

  if (req.query.format === "csv") {
    const header = [
      "broker", "loads", "revenue_usd", "est_cost_usd", "margin_usd", "margin_pct",
      "loaded_mi", "deadhead_mi", "deadhead_pct", "rpm_loaded_usd",
    ];
    const rows = brokers.map((b) => [
      b.broker, b.loads, centsToUsd(b.revenueCents), centsToUsd(b.estCostCents),
      centsToUsd(b.marginCents), fractionToPct(b.avgMarginPct),
      b.loadedMi.toFixed(1), b.deadheadMi.toFixed(1), fractionToPct(b.deadheadPct),
      centsToUsd(b.ratePerLoadedMiCents),
    ]);
    return sendCsv(res, "broker-profitability.csv", toCsv(header, rows));
  }

  res.json({ brokers });
}));

// Recurring lanes: committed loads grouped by coordinate-bucketed
// origin->destination. Repeat freight is the fleet's bread and butter — this
// shows which lanes run, what they earn, and who runs them most.
dispatcherAnalyticsRouter.get("/analytics/lanes", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);

  const assignments = await prisma.assignment.findMany({
    where: { ...scope, status: { in: [...ACTIVE_STATUSES, "completed"] } },
    select: {
      driverId: true,
      driver: { select: { name: true } },
      load: {
        select: {
          revenueCents: true, fscCents: true,
          rate: { select: { marginCents: true } },
          stops: { orderBy: { sequence: "asc" }, select: { type: true, address: true, lat: true, lng: true } },
        },
      },
    },
  });

  const byLane = new Map<string, {
    lane: string; origin: string; destination: string; runs: number;
    revenueCents: number; marginCents: number; driverRuns: Map<string, { name: string; runs: number }>;
  }>();

  const cityOf = (address: string | undefined) => address?.split(",").slice(0, 2).join(",").trim() ?? "?";

  for (const a of assignments) {
    const pickup = a.load.stops.find((s) => s.type === "pickup");
    const delivery = [...a.load.stops].reverse().find((s) => s.type === "delivery");
    if (pickup?.lat == null || pickup.lng == null || delivery?.lat == null || delivery.lng == null) continue;
    const key = laneKey({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng });
    const row = byLane.get(key) ?? {
      lane: key, origin: cityOf(pickup.address), destination: cityOf(delivery.address),
      runs: 0, revenueCents: 0, marginCents: 0,
      driverRuns: new Map<string, { name: string; runs: number }>(),
    };
    row.runs += 1;
    row.revenueCents += a.load.revenueCents + a.load.fscCents;
    row.marginCents += a.load.rate?.marginCents ?? 0;
    const d = row.driverRuns.get(a.driverId) ?? { name: a.driver.name, runs: 0 };
    d.runs += 1;
    row.driverRuns.set(a.driverId, d);
    byLane.set(key, row);
  }

  const lanes = [...byLane.values()]
    .map(({ driverRuns, ...row }) => {
      const top = [...driverRuns.values()].sort((a, b) => b.runs - a.runs)[0] ?? null;
      return { ...row, topDriver: top ? `${top.name} (${top.runs})` : null };
    })
    .sort((a, b) => b.runs - a.runs || b.marginCents - a.marginCents);

  if (req.query.format === "csv") {
    const header = ["origin", "destination", "runs", "revenue_usd", "margin_usd", "top_driver"];
    const rows = lanes.map((l) => [
      l.origin, l.destination, l.runs, centsToUsd(l.revenueCents), centsToUsd(l.marginCents), l.topDriver,
    ]);
    return sendCsv(res, "recurring-lanes.csv", toCsv(header, rows));
  }

  res.json({ lanes });
}));
