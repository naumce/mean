import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { centsToUsd, fractionToPct, sendCsv, toCsv } from "../lib/csvOut.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Per-load money table (Money screen): every committed load's revenue, miles,
// rate-per-mile, and margin — the numbers a dispatcher uses to decide which
// freight to keep hauling. Source of truth is the Rate snapshot written at
// commit (deleted on unassign), scoped away from canceled loads. Worst margin
// first so the money-losers surface immediately. Mounted under
// dispatcherRouter with attachOrgScope.
export const dispatcherEconomicsRouter = Router();

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(["csv"]).optional(),
});

dispatcherEconomicsRouter.get("/economics", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "from/to must be ISO datetimes" });
  const scope = orgWhere(req);

  // Optional dispatch-date window (by the assignment's planned start) —
  // "what did we book this week", same picker semantics as settlements.
  const from = parsed.data.from ? new Date(parsed.data.from) : null;
  const to = parsed.data.to ? new Date(parsed.data.to) : null;
  if (from && to && from.getTime() >= to.getTime()) {
    return res.status(400).json({ error: "from must be before to" });
  }

  const rates = await prisma.rate.findMany({
    where: {
      load: {
        ...("orgId" in scope ? { orgId: scope.orgId } : {}),
        status: { notIn: ["canceled"] },
        ...(from || to
          ? {
              assignment: {
                plannedStart: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) },
              },
            }
          : {}),
      },
    },
    select: {
      loadId: true,
      linehaulCents: true, fscCents: true, estCostCents: true, marginCents: true,
      totalMi: true, loadedMi: true, deadheadMi: true, ratePerLoadedMiCents: true,
      load: {
        select: {
          orderRef: true, brokerName: true, commodity: true, status: true,
          assignment: {
            select: { plannedStart: true, driver: { select: { name: true } } },
          },
        },
      },
    },
  });

  const loads = rates
    .map((r) => {
      const revenueCents = r.linehaulCents + r.fscCents;
      return {
        loadId: r.loadId,
        ref: r.load.orderRef ?? r.loadId.slice(0, 8),
        broker: r.load.brokerName,
        commodity: r.load.commodity,
        status: r.load.status,
        driverName: r.load.assignment?.driver.name ?? null,
        plannedStart: r.load.assignment?.plannedStart.toISOString() ?? null,
        revenueCents,
        loadedMi: r.loadedMi,
        deadheadMi: r.deadheadMi,
        totalMi: r.totalMi,
        rpmLoadedCents: r.ratePerLoadedMiCents,
        rpmAllCents: r.totalMi > 0 ? Math.round(revenueCents / r.totalMi) : 0,
        estCostCents: r.estCostCents,
        marginCents: r.marginCents,
        marginPct: revenueCents > 0 ? r.marginCents / revenueCents : 0,
      };
    })
    .sort((a, b) => a.marginPct - b.marginPct || a.marginCents - b.marginCents);

  const sum = loads.reduce(
    (acc, l) => ({
      revenueCents: acc.revenueCents + l.revenueCents,
      estCostCents: acc.estCostCents + l.estCostCents,
      marginCents: acc.marginCents + l.marginCents,
      loadedMi: acc.loadedMi + l.loadedMi,
      deadheadMi: acc.deadheadMi + l.deadheadMi,
      totalMi: acc.totalMi + l.totalMi,
    }),
    { revenueCents: 0, estCostCents: 0, marginCents: 0, loadedMi: 0, deadheadMi: 0, totalMi: 0 },
  );

  const totals = {
    loads: loads.length,
    ...sum,
    marginPct: sum.revenueCents > 0 ? sum.marginCents / sum.revenueCents : 0,
    deadheadPct: sum.totalMi > 0 ? sum.deadheadMi / sum.totalMi : 0,
    rpmLoadedCents: sum.loadedMi > 0 ? Math.round(sum.revenueCents / sum.loadedMi) : 0,
  };

  // ?format=csv — same rows, spreadsheet-ready (dollars as decimals, TOTAL
  // row last so the numbers land in accounting without re-typing).
  if (parsed.data.format === "csv") {
    const header = [
      "load", "broker", "driver", "status", "planned_start",
      "revenue_usd", "loaded_mi", "deadhead_mi", "total_mi",
      "rpm_loaded_usd", "rpm_all_usd", "est_cost_usd", "margin_usd", "margin_pct",
    ];
    const dataRows = loads.map((l) => [
      l.ref, l.broker, l.driverName, l.status, l.plannedStart,
      centsToUsd(l.revenueCents), l.loadedMi.toFixed(1), l.deadheadMi.toFixed(1), l.totalMi.toFixed(1),
      centsToUsd(l.rpmLoadedCents), centsToUsd(l.rpmAllCents),
      centsToUsd(l.estCostCents), centsToUsd(l.marginCents), fractionToPct(l.marginPct),
    ]);
    const totalRow = [
      "TOTAL", null, null, null, null,
      centsToUsd(totals.revenueCents), totals.loadedMi.toFixed(1), totals.deadheadMi.toFixed(1), totals.totalMi.toFixed(1),
      centsToUsd(totals.rpmLoadedCents), null,
      centsToUsd(totals.estCostCents), centsToUsd(totals.marginCents), fractionToPct(totals.marginPct),
    ];
    return sendCsv(res, "money-per-load.csv", toCsv(header, [...dataRows, totalRow]));
  }

  res.json({ loads, totals });
}));
