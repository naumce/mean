// GET /dispatcher/carrier-statements?from=&to=  — what this dispatch service
// invoices each client carrier for the period.
// PATCH /dispatcher/carriers/:id/commission     — agree terms with a carrier.
//
// Mounted under dispatcherRouter; auth and role already enforced.

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { buildStatements } from "../lib/carrierStatements.js";
import { asyncRoute } from "../lib/asyncRoute.js";

export const dispatcherCarrierStatementsRouter = Router();

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

dispatcherCarrierStatementsRouter.get("/carrier-statements", asyncRoute(async (req, res, next) => {
  try {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "from and to (ISO datetimes) are required" });
    }
    const fromMs = Date.parse(parsed.data.from);
    const toMs = Date.parse(parsed.data.to);
    if (!(toMs > fromMs)) return res.status(400).json({ error: "to must be after from" });

    const scope = orgWhere(req) as { orgId?: string };
    if (!scope.orgId) return res.status(400).json({ error: "Dispatcher is not scoped to an org" });

    res.json(await buildStatements(scope.orgId, fromMs, toMs));
  } catch (err) {
    // Express 4 does not await handlers; without this the request hangs.
    next(err);
  }
}));

const commissionSchema = z
  .object({
    // null clears the terms back to "not agreed" — a real state, and the only
    // way to undo a mistake without inventing a 0% agreement.
    commissionModel: z.enum(["percent_linehaul", "per_load", "per_truck_week"]).nullable(),
    commissionPctBps: z.number().int().min(0).max(10_000).nullable().optional(),
    commissionFlatCents: z.number().int().min(0).max(10_000_00).nullable().optional(),
  })
  .refine(
    (v) => v.commissionModel !== "percent_linehaul" || v.commissionPctBps != null,
    { message: "percent_linehaul requires commissionPctBps" },
  )
  .refine(
    (v) =>
      (v.commissionModel !== "per_load" && v.commissionModel !== "per_truck_week") ||
      v.commissionFlatCents != null,
    { message: "a flat model requires commissionFlatCents" },
  );

dispatcherCarrierStatementsRouter.patch("/carriers/:id/commission", asyncRoute(async (req, res, next) => {
  try {
    const parsed = commissionSchema.safeParse(req.body);
    if (!parsed.success) {
      // Saving a model without its rate would produce a carrier that looks
      // configured and bills nothing. Refused at the boundary instead.
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid commission terms" });
    }
    // 404, never 403, for a carrier outside this org.
    const carrier = await prisma.carrier.findFirst({
      where: { id: String(req.params.id), ...orgWhere(req) },
      select: { id: true },
    });
    if (!carrier) return res.status(404).json({ error: "Carrier not found" });

    const updated = await prisma.carrier.update({
      where: { id: carrier.id },
      data: {
        commissionModel: parsed.data.commissionModel,
        commissionPctBps: parsed.data.commissionPctBps ?? null,
        commissionFlatCents: parsed.data.commissionFlatCents ?? null,
      },
      select: { id: true, name: true, commissionModel: true, commissionPctBps: true, commissionFlatCents: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}));
