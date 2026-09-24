import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere, outsideOrg } from "../middleware/orgScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { customerHistory } from "../lib/customers.js";

// Customer CRUD + history for the dispatcher portal (AI Dispatch Foundation,
// Task 3). Mounted (without its own prefix) at /api/dispatcher behind
// requireAuth + requireDispatcher + attachOrgScope — see app.ts's single
// structural gate. Every handler below is tenant-scoped: the list filters
// by orgWhere(req), and a single customer outside the caller's org reads as
// 404 (never 403 — a 403 confirms the row exists, the same leak by another
// name) — the same conventions dispatcherCarriers.ts and
// dispatcherDriverSupply.ts already use.
//
// Customer.orgId is NOT nullable (prisma/schema.prisma), same as Carrier's —
// there is no "unscoped/pool" customer convention to preserve, so creating
// one requires an org-scoped dispatcher account, same as POST /carriers.
export const dispatcherCustomersRouter = Router();

const CHANNELS = ["email", "sms", "phone"] as const;
const PRIORITIES = ["standard", "high"] as const;

// *Minutes fields: null = no threshold set for this customer, never a
// coerced 0 — the same "absent must never render as measured" contract
// dispatcherCarriers.ts's cost fields keep (see that file's comment on
// mpg/dieselCentsPerGal for why `??` semantics matter for a real 0).
const minutesField = z.number().int().nonnegative({ message: "must not be negative" }).nullable();

const customerFields = {
  primaryContactName: z.string().max(120).nullable().optional(),
  primaryEmail: z.string().email().nullable().optional(),
  primaryPhone: z.string().max(40).nullable().optional(),
  preferredCommunicationChannel: z.enum(CHANNELS).optional(),
  timezone: z.string().max(64).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  updateCadenceMinutes: minutesField.optional(),
  lateNotificationThresholdMinutes: minutesField.optional(),
  detentionFreeMinutes: minutesField.optional(),
  requiresArrivalNotification: z.boolean().optional(),
  requiresDelayNotification: z.boolean().optional(),
};

const createCustomerSchema = z.object({ name: z.string().trim().min(1).max(120), ...customerFields });

// `.partial()` is not used here, for the same reason dispatcherCarriers.ts's
// updateCarrierSchema doesn't use it: `name` stays required-IF-present (its
// min/max still enforced), not nullable, and passing the parsed `body`
// straight through to Prisma unchanged is what makes an OMITTED key leave a
// column untouched while an explicit `null` clears it — see that file's own
// comment on the identical technique.
const updateCustomerSchema = z
  .object({ name: z.string().trim().min(1).max(120).optional(), ...customerFields })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string }).code === "P2002";

dispatcherCustomersRouter.get("/customers", asyncRoute(async (req, res) => {
  const customers = await prisma.customer.findMany({
    where: orgWhere(req),
    include: { _count: { select: { loads: true } } },
    orderBy: { name: "asc" },
  });
  res.json(customers);
}));

dispatcherCustomersRouter.post("/customers", validateBody(createCustomerSchema), asyncRoute(async (req, res) => {
  // Customer.orgId is required (not nullable), so — unlike POST /drivers,
  // which lets an unscoped dispatcher create an orgless row — an unscoped
  // (legacy/dev) dispatcher account cannot create a customer at all.
  if (!req.orgScope) {
    return res.status(400).json({ error: "Customers require an org-scoped dispatcher account" });
  }
  const body = req.body as z.infer<typeof createCustomerSchema>;
  try {
    const customer = await prisma.customer.create({ data: { ...body, orgId: req.orgScope } });
    res.status(201).json(customer);
  } catch (e) {
    // Customer is unique on (orgId, name) (prisma/schema.prisma) — a name
    // this org already has is a conflict, not a server error. Same P2002
    // shape as dispatcherNightShift.ts's policy-name conflict (AgentPolicy
    // carries the identical (orgId, name) uniqueness); dispatcherCarriers.ts
    // has no equivalent check to mirror instead because Carrier.name carries
    // no uniqueness constraint at all.
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A customer with that name already exists" });
    throw e;
  }
}));

/** Fetches a customer and applies the cross-tenant 404 in one place, so all
 *  four `:id` routes below read identically to a caller outside the org. */
async function ownedCustomer(req: { orgScope?: string | null }, id: string) {
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing || outsideOrg(req, existing.orgId)) return null;
  return existing;
}

dispatcherCustomersRouter.get("/customers/:id", asyncRoute(async (req, res) => {
  const customer = await ownedCustomer(req, req.params.id as string);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(customer);
}));

dispatcherCustomersRouter.patch("/customers/:id", validateBody(updateCustomerSchema), asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const existing = await ownedCustomer(req, id);
  if (!existing) return res.status(404).json({ error: "Customer not found" });
  const body = req.body as z.infer<typeof updateCustomerSchema>;
  try {
    const updated = await prisma.customer.update({ where: { id }, data: body });
    res.json(updated);
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A customer with that name already exists" });
    throw e;
  }
}));

dispatcherCustomersRouter.get("/customers/:id/history", asyncRoute(async (req, res) => {
  const customer = await ownedCustomer(req, req.params.id as string);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(await customerHistory(customer.orgId, customer.id));
}));

const CUSTOMER_LOADS_LIMIT = 200;

dispatcherCustomersRouter.get("/customers/:id/loads", asyncRoute(async (req, res) => {
  const customer = await ownedCustomer(req, req.params.id as string);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  const loads = await prisma.load.findMany({
    where: { orgId: customer.orgId, customerId: customer.id },
    orderBy: { createdAt: "desc" },
    take: CUSTOMER_LOADS_LIMIT,
    select: {
      id: true, externalId: true, orderRef: true, boardLoadNo: true, status: true, revenueCents: true, shipDate: true,
      stops: { orderBy: { sequence: "asc" }, select: { address: true } },
    },
  });
  res.json(loads.map(({ stops, ...load }) => ({
    ...load,
    firstStopAddress: stops[0]?.address ?? null,
    lastStopAddress: stops[stops.length - 1]?.address ?? null,
  })));
}));
