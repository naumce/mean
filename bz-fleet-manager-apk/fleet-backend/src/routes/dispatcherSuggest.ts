import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { rankOrgDrivers } from "../lib/rankDrivers.js";
import { toLoadInput, toTractorInput, toTrailerInput } from "../domain/dispatch/mapper.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The ⚡Suggest panel (Control Tower §4E). Given a load, rank the org's drivers
// by feasibility + economics. Equipment auto-pick: since drivers aren't linked
// to specific power units in the schema, we pick one representative available
// tractor and one available trailer of the load's required type from the org
// pool, and score every driver against that pairing. The UI uses the returned
// tractorId/trailerId to pre-fill the commit. Mounted under dispatcherRouter —
// auth + role already enforced.
export const dispatcherSuggestRouter = Router();

const querySchema = z.object({ loadId: z.string().min(1) });

dispatcherSuggestRouter.get("/suggest", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "loadId is required" });

  const load = await prisma.load.findUnique({
    where: { id: parsed.data.loadId },
    include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } },
  });
  // Cross-tenant ids read as "not found" — never reveal another org's data.
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });

  const loadInput = toLoadInput(load);

  // Representative available equipment from the org pool.
  const [tractor, trailer] = await Promise.all([
    prisma.tractor.findFirst({ where: { orgId: load.orgId, status: "active" } }),
    prisma.trailer.findFirst({
      where: { orgId: load.orgId, type: load.requiredEquip, status: { in: ["active", "idle"] } },
    }),
  ]);
  if (!tractor) return res.json({ loadId: load.id, requiredEquip: load.requiredEquip, tractorId: null, trailerId: null, candidates: [], note: "No available tractor in the pool" });
  if (!trailer) return res.json({ loadId: load.id, requiredEquip: load.requiredEquip, tractorId: null, trailerId: null, candidates: [], note: `No available ${load.requiredEquip} trailer in the pool` });

  // Ranking core shared with the commit-time empty-miles-saved metric.
  // rankOrgDrivers now resolves EACH candidate's own cost model INSIDE the
  // ranking (carrier, falling back field-by-field to the org — the same
  // rateConfig.ts resolution the commit path uses, batched via
  // rateConfigsForDrivers), not one shared RateConfig applied to every row
  // (T1 Task 3b, closing the divergence flagged after Task 3 / T1 Ruling 4).
  // So this panel's marginCents for a given driver now matches what
  // committing to that driver actually prices, and the ranking order itself
  // reflects each candidate's real carrier economics rather than treating a
  // driver on an expensive carrier as if they cost the org's own rate.
  const ranking = await rankOrgDrivers(
    load.orgId,
    loadInput,
    toTractorInput(tractor),
    toTrailerInput(trailer),
    Date.now(),
  );

  // Drivers we can't even map (no position) become infeasible rows directly.
  const unmappableRows = ranking.unmappable.map((u) => ({
    driverId: u.driverId,
    driverName: u.driverName,
    feasible: false,
    score: null,
    deadheadMi: 0,
    loadedMi: 0,
    etaMs: 0,
    marginCents: 0,
    marginPct: 0,
    blockedReason: u.reason,
    warnings: [] as string[],
  }));

  res.json({
    loadId: load.id,
    requiredEquip: load.requiredEquip,
    tractorId: tractor.id,
    trailerId: trailer.id,
    candidates: [...ranking.ranked, ...unmappableRows],
  });
}));
