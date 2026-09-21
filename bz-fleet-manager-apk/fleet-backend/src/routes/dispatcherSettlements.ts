import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { DEFAULT_RATE_CONFIG } from "../domain/dispatch/economics.js";
import { rateConfigsForDrivers } from "../lib/rateConfig.js";
import { centsToUsd, sendCsv, toCsv } from "../lib/csvOut.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Driver settlements: per-driver rollup of COMPLETED work in a date range —
// the Friday-payroll view. Only delivered loads count (a plan isn't work),
// bucketed by when the trip actually completed. estPay = total miles × EACH
// DRIVER'S OWN resolved cost model (their carrier's, falling back field-by-
// field to the org's — same rateConfigForDriver resolution the commit path
// uses, batched here via rateConfigsForDrivers to avoid an N+1) — an
// estimate at that driver's configured rate, not a payroll ledger.
//
// Before the carrier layer (T1) this rolled up at ONE org-wide rate, so
// estPayCents and the marginCents summed from the committed Rate snapshot
// always agreed by construction. Task 3 made the Rate snapshot carrier-
// priced but left this route computing estPayCents from the org's rate
// alone — for a driver on a carrier with a different rate, that put a
// margin implying carrier pay right next to an estPayCents computed at the
// org's pay, contradicting each other inside one JSON object. There is no
// longer one "the" driver-pay rate for the whole response (per-carrier
// drivers can differ), so there is no meaningful top-level
// driverPayCentsPerMi to report — dropped rather than kept as a number that
// would only be true for org-only drivers. Each row now carries its OWN
// driverPayCentsPerMi instead. (fleet-portal's BrokersView shows the old
// top-level value as a "@ $X.XX/mi" label next to the Est. pay column
// header; with it gone that label simply stops rendering — a portal-side
// follow-up, out of scope for this backend fix.)
// Mounted under dispatcherRouter with attachOrgScope.
export const dispatcherSettlementsRouter = Router();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(["csv"]).optional(),
});

dispatcherSettlementsRouter.get("/settlements", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "from/to must be ISO datetimes" });
  const scope = orgWhere(req);

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(to.getTime() - WEEK_MS);
  if (from.getTime() >= to.getTime()) return res.status(400).json({ error: "from must be before to" });

  const assignments = await prisma.assignment.findMany({
    where: { ...scope, status: "completed", completedAt: { gte: from, lt: to } },
    select: {
      driverId: true,
      driver: { select: { name: true } },
      load: { select: { rate: { select: { linehaulCents: true, fscCents: true, totalMi: true, loadedMi: true, deadheadMi: true, marginCents: true } } } },
    },
  });

  const byDriver = new Map<string, {
    driverId: string; driverName: string; loads: number;
    loadedMi: number; deadheadMi: number; totalMi: number;
    revenueCents: number; marginCents: number;
  }>();

  for (const a of assignments) {
    const rate = a.load.rate;
    if (!rate) continue; // no committed economics snapshot — nothing to settle
    const row = byDriver.get(a.driverId) ?? {
      driverId: a.driverId, driverName: a.driver.name, loads: 0,
      loadedMi: 0, deadheadMi: 0, totalMi: 0, revenueCents: 0, marginCents: 0,
    };
    row.loads += 1;
    row.loadedMi += rate.loadedMi;
    row.deadheadMi += rate.deadheadMi;
    row.totalMi += rate.totalMi;
    row.revenueCents += rate.linehaulCents + rate.fscCents;
    row.marginCents += rate.marginCents;
    byDriver.set(a.driverId, row);
  }

  // Each driver's OWN resolved rate (their carrier's, falling back to the
  // org's) — not one org-wide rate for every row. Keyed on driverId, which
  // is already in hand from the select above; batched into one query rather
  // than N (see rateConfigsForDrivers's doc comment).
  const rateCfgByDriver = await rateConfigsForDrivers([...byDriver.keys()]);

  const drivers = [...byDriver.values()]
    .map((d) => {
      const rateCfg = rateCfgByDriver.get(d.driverId) ?? DEFAULT_RATE_CONFIG;
      return {
        ...d,
        driverPayCentsPerMi: rateCfg.driverPayCentsPerMi,
        estPayCents: Math.round(d.totalMi * rateCfg.driverPayCentsPerMi),
        rpmLoadedCents: d.loadedMi > 0 ? Math.round(d.revenueCents / d.loadedMi) : 0,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);

  const totals = drivers.reduce(
    (acc, d) => ({
      loads: acc.loads + d.loads,
      loadedMi: acc.loadedMi + d.loadedMi,
      deadheadMi: acc.deadheadMi + d.deadheadMi,
      totalMi: acc.totalMi + d.totalMi,
      revenueCents: acc.revenueCents + d.revenueCents,
      marginCents: acc.marginCents + d.marginCents,
      estPayCents: acc.estPayCents + d.estPayCents,
    }),
    { loads: 0, loadedMi: 0, deadheadMi: 0, totalMi: 0, revenueCents: 0, marginCents: 0, estPayCents: 0 },
  );

  if (parsed.data.format === "csv") {
    const header = [
      "driver", "loads", "loaded_mi", "deadhead_mi", "total_mi",
      "revenue_usd", "margin_usd", "est_pay_usd", "rpm_loaded_usd",
    ];
    const rows = drivers.map((d) => [
      d.driverName, d.loads, d.loadedMi.toFixed(1), d.deadheadMi.toFixed(1), d.totalMi.toFixed(1),
      centsToUsd(d.revenueCents), centsToUsd(d.marginCents), centsToUsd(d.estPayCents), centsToUsd(d.rpmLoadedCents),
    ]);
    const totalRow = [
      "TOTAL", totals.loads, totals.loadedMi.toFixed(1), totals.deadheadMi.toFixed(1), totals.totalMi.toFixed(1),
      centsToUsd(totals.revenueCents), centsToUsd(totals.marginCents), centsToUsd(totals.estPayCents), null,
    ];
    return sendCsv(res, "driver-settlements.csv", toCsv(header, [...rows, totalRow]));
  }

  // No top-level driverPayCentsPerMi: with per-carrier rates there is no
  // longer one number that describes the whole response (see file-header
  // comment). Each row in `drivers` carries its own driverPayCentsPerMi.
  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    drivers,
    totals,
  });
}));
