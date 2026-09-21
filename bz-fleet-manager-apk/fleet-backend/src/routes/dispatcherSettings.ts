import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { allInCentsPerMi } from "../lib/rateConfig.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Org cost-model settings (Money screen): the four knobs that price every
// commit's estCost/margin. Committed Rate rows are snapshots, so edits here
// only change how FUTURE dispatches are priced. Mounted under
// dispatcherRouter with attachOrgScope.
export const dispatcherSettingsRouter = Router();

const COST_MODEL_SELECT = {
  mpg: true,
  dieselCentsPerGal: true,
  driverPayCentsPerMi: true,
  fixedCentsPerMi: true,
} as const;

// Bounds are sanity rails, not policy: a semi does 3–12 mpg, diesel has never
// been outside $1–$12/gal, and per-mile pay/overhead beyond $3/mi is a typo.
const patchSchema = z
  .object({
    mpg: z.number().min(3).max(12),
    dieselCentsPerGal: z.number().int().min(100).max(1200),
    driverPayCentsPerMi: z.number().int().min(0).max(300),
    fixedCentsPerMi: z.number().int().min(0).max(300),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "No cost-model fields to update" });

function toResponse(config: { mpg: number; dieselCentsPerGal: number; driverPayCentsPerMi: number; fixedCentsPerMi: number }) {
  return { ...config, allInCentsPerMi: allInCentsPerMi(config) };
}

dispatcherSettingsRouter.get("/settings/cost-model", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Cost model requires an org-scoped dispatcher account" });
  const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId }, select: COST_MODEL_SELECT });
  res.json(toResponse(org));
}));

dispatcherSettingsRouter.patch(
  "/settings/cost-model",
  validateBody(patchSchema),
  asyncRoute(async (req, res) => {
    const orgId = req.orgScope;
    if (!orgId) return res.status(400).json({ error: "Cost model requires an org-scoped dispatcher account" });
    const body = req.body as z.infer<typeof patchSchema>;
    const org = await prisma.org.update({ where: { id: orgId }, data: body, select: COST_MODEL_SELECT });
    res.json(toResponse(org));
  }),
);
