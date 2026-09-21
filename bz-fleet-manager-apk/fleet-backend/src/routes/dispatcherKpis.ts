import { Router } from "express";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Fleet KPIs (Control Tower screen 10). The headline is the empty-miles story:
// how much of the fleet's committed mileage is deadhead, and what the committed
// loads earn. Aggregated from Rate snapshots (written at commit) and load
// statuses. Mounted under dispatcherRouter with attachOrgScope.
export const dispatcherKpisRouter = Router();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface TrendBucket {
  loads: number;
  revenueCents: number;
  marginCents: number;
  loadedMi: number;
  deadheadMi: number;
  totalMi: number;
  deadheadPct: number;
}

const emptyBucket = (): TrendBucket => ({
  loads: 0, revenueCents: 0, marginCents: 0, loadedMi: 0, deadheadMi: 0, totalMi: 0, deadheadPct: 0,
});

dispatcherKpisRouter.get("/kpis", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);
  const now = Date.now();
  const weekAgo = new Date(now - WEEK_MS);
  const twoWeeksAgo = new Date(now - 2 * WEEK_MS);

  const [statusGroups, driverCount, hosKnownCount, rates, deadheadAgg, savedAgg, recentCompleted] = await Promise.all([
    prisma.load.groupBy({ by: ["status"], where: { ...scope }, _count: { _all: true } }),
    prisma.driver.count({ where: { ...scope } }),
    prisma.hosState.count(
      "orgId" in scope
        ? { where: { driver: { orgId: scope.orgId } } }
        : undefined,
    ),
    prisma.rate.findMany({
      where: "orgId" in scope ? { load: { orgId: scope.orgId } } : {},
      select: {
        linehaulCents: true, fscCents: true, estCostCents: true, marginCents: true,
        totalMi: true, loadedMi: true, deadheadMi: true,
      },
    }),
    // Live commitments only — a canceled assignment must not keep inflating
    // the deadhead or empty-miles-saved story forever.
    prisma.deadheadLeg.aggregate({
      where: {
        assignment: {
          status: { in: [...ACTIVE_STATUSES, "completed"] },
          ...("orgId" in scope ? { orgId: scope.orgId } : {}),
        },
      },
      _sum: { miles: true, costCents: true },
    }),
    prisma.assignment.aggregate({
      where: { ...scope, status: { in: [...ACTIVE_STATUSES, "completed"] } },
      _sum: { savedMi: true },
    }),
    // Direction, not just totals: completed work over the trailing fortnight,
    // bucketed into this week vs last so the bar can show trend arrows.
    prisma.assignment.findMany({
      where: { ...scope, status: "completed", completedAt: { gte: twoWeeksAgo } },
      select: {
        completedAt: true,
        load: { select: { rate: { select: { linehaulCents: true, fscCents: true, marginCents: true, loadedMi: true, deadheadMi: true, totalMi: true } } } },
      },
    }),
  ]);

  const loads: Record<string, number> = {};
  for (const g of statusGroups) loads[g.status] = g._count._all;

  const thisWeek = emptyBucket();
  const lastWeek = emptyBucket();
  for (const a of recentCompleted) {
    const rate = a.load.rate;
    if (!rate || !a.completedAt) continue;
    const bucket = a.completedAt >= weekAgo ? thisWeek : lastWeek;
    bucket.loads += 1;
    bucket.revenueCents += rate.linehaulCents + rate.fscCents;
    bucket.marginCents += rate.marginCents;
    bucket.loadedMi += rate.loadedMi;
    bucket.deadheadMi += rate.deadheadMi;
    bucket.totalMi += rate.totalMi;
  }
  for (const b of [thisWeek, lastWeek]) b.deadheadPct = b.totalMi > 0 ? b.deadheadMi / b.totalMi : 0;

  const sum = rates.reduce(
    (acc, r) => ({
      revenueCents: acc.revenueCents + r.linehaulCents + r.fscCents,
      estCostCents: acc.estCostCents + r.estCostCents,
      marginCents: acc.marginCents + r.marginCents,
      totalMi: acc.totalMi + r.totalMi,
      loadedMi: acc.loadedMi + r.loadedMi,
      deadheadMi: acc.deadheadMi + r.deadheadMi,
    }),
    { revenueCents: 0, estCostCents: 0, marginCents: 0, totalMi: 0, loadedMi: 0, deadheadMi: 0 },
  );

  res.json({
    loads,
    drivers: { total: driverCount, hosKnown: hosKnownCount },
    economics: {
      committedLoads: rates.length,
      revenueCents: sum.revenueCents,
      estCostCents: sum.estCostCents,
      marginCents: sum.marginCents,
      avgMarginPct: sum.revenueCents > 0 ? sum.marginCents / sum.revenueCents : 0,
      loadedMi: sum.loadedMi,
      deadheadMi: sum.deadheadMi,
      deadheadPct: sum.totalMi > 0 ? sum.deadheadMi / sum.totalMi : 0,
      ratePerLoadedMiCents: sum.loadedMi > 0 ? Math.round(sum.revenueCents / sum.loadedMi) : 0,
      deadheadCostCents: deadheadAgg._sum.costCents ?? 0,
      // The retention headline: deadhead avoided vs. the median alternative,
      // summed over every commit.
      emptyMilesSavedMi: savedAgg._sum.savedMi ?? 0,
    },
    trend: { thisWeek, lastWeek },
  });
}));
