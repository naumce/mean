import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere, outsideCallerOrg } from "../middleware/orgScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Carrier CRUD for the dispatcher portal (T1 Carrier layer, Task 4). Mounted
// (without its own prefix) at /api/dispatcher behind requireAuth +
// requireDispatcher + attachOrgScope — see app.ts's single structural gate.
// Every handler below is tenant-scoped: the list filters by orgWhere(req),
// and a single carrier outside the caller's org reads as 404 (never 403 — a
// 403 confirms the row exists, which is the same leak by another name).
//
// Unlike Driver/Tractor/Trailer/Vehicle, Carrier.orgId is NOT nullable
// (prisma/schema.prisma) — a carrier always belongs to exactly one org, so
// there is no "unscoped/pool" carrier convention to preserve here. Creating
// one therefore requires an org-scoped dispatcher account.
export const dispatcherCarriersRouter = Router();

const CARRIER_STATUSES = ["active", "paused", "archived"] as const;

// Cost-model fields (§5.1/§5.2 of the design spec): null is the explicit
// "inherit the org's value" signal that src/lib/rateConfig.ts's
// resolveRateConfig reads field-by-field, and it must persist exactly as
// null — never stripped, defaulted, or coerced to zero. "Absent must never
// render as measured" is this product's core promise (spec §6, item I1).
//
// mpg must be strictly positive when set. Zero divides by zero in
// computeEconomics (src/domain/dispatch/economics.ts: "mpg must be
// positive"), and because Express 4 does not await async handlers, an
// uncaught throw there does not even become a 500 — the request gets NO
// response at all. dispatcherAssignments.ts's priceOrRefuse already guards
// the commit/replan boundary against a carrier that reached mpg: 0 by some
// other path (direct DB, seed data); this is the second, independent guard
// that stops a bad mpg from ever being written through the API in the first
// place. Belt and suspenders, not redundant — neither guard makes the other
// unnecessary.
const mpgField = z.number().positive({ message: "mpg must be positive" }).nullable();
// Money fields: negative is never valid (a carrier cannot charge negative
// diesel/pay/overhead); 0 is a deliberate, meaningful value (see
// resolveRateConfig's `??` vs `||` note) and must stay distinct from null.
const centsField = z.number().int().nonnegative({ message: "must not be negative" }).nullable();

const carrierFields = {
  mcNumber: z.string().min(1).nullable().optional(),
  dotNumber: z.string().min(1).nullable().optional(),
  status: z.enum(CARRIER_STATUSES).optional(),
  mpg: mpgField.optional(),
  dieselCentsPerGal: centsField.optional(),
  driverPayCentsPerMi: centsField.optional(),
  fixedCentsPerMi: centsField.optional(),
  insuranceExpiresAt: z.coerce.date().nullable().optional(),
  authorityStatus: z.string().nullable().optional(),
};

const createCarrierSchema = z.object({ name: z.string().min(1), ...carrierFields });

// `.partial()` is not used here (name stays required-if-present, not
// nullable) — carrierFields already carries the right optional/nullable
// shape for every other field. Zod distinguishes an OMITTED key from an
// EXPLICIT `null` in its parsed output (omitted stays absent from the result
// object; `null` survives as the key's value), so `"field" in body` after
// parsing is a reliable test for "was this sent at all" — see the pairing
// handler in dispatcherDrivers.ts for the same technique. The update handler
// below relies on that: it hands the parsed body straight to Prisma, and
// Prisma applies the identical rule (an absent key leaves the column
// untouched; an explicit `null` sets it) — so passing `body` through
// unchanged, rather than hand-building an update object, IS what makes the
// omitted-vs-null distinction actually reach the database.
const updateCarrierSchema = z
  .object({ name: z.string().min(1).optional(), ...carrierFields })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

dispatcherCarriersRouter.get("/carriers", asyncRoute(async (req, res) => {
  const carriers = await prisma.carrier.findMany({ where: orgWhere(req), orderBy: { name: "asc" } });
  res.json(carriers);
}));

dispatcherCarriersRouter.post("/carriers", validateBody(createCarrierSchema), asyncRoute(async (req, res) => {
  // Carrier.orgId is required (not nullable), so — unlike POST /drivers,
  // which lets an unscoped dispatcher create an orgless row — an unscoped
  // (legacy/dev) dispatcher account cannot create a carrier at all.
  if (!req.orgScope) {
    return res.status(400).json({ error: "Carriers require an org-scoped dispatcher account" });
  }
  const body = req.body as z.infer<typeof createCarrierSchema>;
  const carrier = await prisma.carrier.create({ data: { ...body, orgId: req.orgScope } });
  res.status(201).json(carrier);
}));

dispatcherCarriersRouter.patch("/carriers/:id", validateBody(updateCarrierSchema), asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.carrier.findUnique({ where: { id }, select: { orgId: true } });
  // outsideCallerOrg 404s a cross-tenant id instead of 403ing it: a 403
  // confirms the row exists (same information leak, different status code).
  if (!existing || outsideCallerOrg(req, existing.orgId)) {
    return res.status(404).json({ error: "Carrier not found" });
  }
  const body = req.body as z.infer<typeof updateCarrierSchema>;
  const updated = await prisma.carrier.update({ where: { id }, data: body });
  res.json(updated);
}));
