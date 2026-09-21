import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The exceptions feed (Control Tower spec screen 8). DispatchConflict rows are
// persisted whenever an assignment commits with warnings (or is forced past
// blocks); this surfaces them newest-first with enough context to jump to the
// load. Mounted under dispatcherRouter with attachOrgScope.
export const dispatcherAlertsRouter = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

dispatcherAlertsRouter.get("/alerts", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "limit must be 1..200" });

  const conflicts = await prisma.dispatchConflict.findMany({
    where: { ...orgWhere(req) },
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit ?? 50,
    include: { load: { select: { externalId: true, orderRef: true, status: true } } },
  });

  const driverIds = [...new Set(conflicts.map((c) => c.driverId))];
  const drivers = await prisma.driver.findMany({
    where: { id: { in: driverIds } },
    select: { id: true, name: true },
  });
  const driverName = new Map(drivers.map((d) => [d.id, d.name]));

  res.json({
    alerts: conflicts.map((c) => ({
      id: c.id,
      kind: c.kind,
      severity: c.severity,
      detail: c.detail,
      createdAt: c.createdAt,
      loadId: c.loadId,
      loadReference: c.load.externalId ?? c.load.orderRef ?? c.loadId,
      loadStatus: c.load.status,
      driverId: c.driverId,
      driverName: driverName.get(c.driverId) ?? null,
    })),
  });
}));
