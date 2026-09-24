import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { availabilityFor } from "../lib/driverAvailability.js";
import { driverMetrics, laneOfAssignmentStops } from "../lib/driverMetrics.js";
import { deliveryWindowEndOf, isLateAssignment, lateMinutes } from "../lib/onTime.js";

// Driver Supply (AI Dispatch Foundation, Task 2): the explicit-availability
// read/write API on top of lib/driverAvailability.ts's shared projection.
// Dispatcher-only, org-scoped — mounted under /api/dispatcher behind
// requireAuth + requireDispatcher + attachOrgScope (see app.ts). A driver
// outside the caller's org reads as 404, never 403, same as
// dispatcherDriverNext.ts (a 403 would confirm the row exists).
//
// MOUNT ORDER: this router must be mounted BEFORE dispatcherDriversRouter in
// app.ts. dispatcherDriversRouter has `GET /drivers/:id`, a two-segment
// route exactly like this file's `GET /drivers/availability` — if that
// router were mounted first, Express would match "availability" as :id and
// answer 404 (Driver not found) before this router is ever reached. The two
// `/drivers/:id/availability` routes below don't have this problem: they're
// three segments, one literal segment longer than dispatcherDriversRouter's
// `/drivers/:id/pairing`-style routes, so there's no overlap either way.
export const dispatcherDriverSupplyRouter = Router();

const AVAILABILITY_STATUS_VALUES = ["AVAILABLE", "AVAILABLE_SOON", "ON_LOAD", "OFF_DUTY", "UNAVAILABLE"] as const;

const MAX_LOCATION_LABEL_LEN = 80;

const patchAvailabilitySchema = z
  .object({
    acceptingLoads: z.boolean().optional(),
    availabilityStatus: z.enum(AVAILABILITY_STATUS_VALUES).optional(),
    availableAt: z.string().datetime().optional(),
    availableCity: z.string().max(MAX_LOCATION_LABEL_LEN).optional(),
    availableState: z.string().max(MAX_LOCATION_LABEL_LEN).optional(),
    availableLat: z.number().min(-90).max(90).optional(),
    availableLng: z.number().min(-180).max(180).optional(),
  })
  // At least one key must be PRESENT (checked with `in`, like
  // dispatcherDrivers.ts's pairingSchema) — an empty body is a 400.
  .refine(
    (data) =>
      "acceptingLoads" in data ||
      "availabilityStatus" in data ||
      "availableAt" in data ||
      "availableCity" in data ||
      "availableState" in data ||
      "availableLat" in data ||
      "availableLng" in data,
    { message: "at least one field is required" },
  );

type PatchAvailabilityBody = z.infer<typeof patchAvailabilitySchema>;

/** The plain scalar fields DriverAvailability.upsert() needs for both its
 *  `create` and `update` branches — a literal value is valid Prisma input
 *  for either (unlike Prisma's own generated Update-input type, whose
 *  fields also accept a `{set: ...}` wrapper that Create-input rejects).
 *  `availabilityStatus`/`source` are deliberately NOT here — see the PATCH
 *  handler's own comment for why they need different create/update logic. */
interface AvailabilityPatch {
  acceptingLoads?: boolean;
  availableAt?: Date;
  availableCity?: string;
  availableState?: string;
  availableLat?: number;
  availableLng?: number;
}

function toPatch(body: PatchAvailabilityBody): AvailabilityPatch {
  const patch: AvailabilityPatch = {};
  if ("acceptingLoads" in body) patch.acceptingLoads = body.acceptingLoads;
  if ("availableAt" in body && body.availableAt) patch.availableAt = new Date(body.availableAt);
  if ("availableCity" in body) patch.availableCity = body.availableCity;
  if ("availableState" in body) patch.availableState = body.availableState;
  if ("availableLat" in body) patch.availableLat = body.availableLat;
  if ("availableLng" in body) patch.availableLng = body.availableLng;
  return patch;
}

// GET /drivers/availability — every driver in the caller's org, one batched
// call (availabilityFor already does the single findMany internally).
dispatcherDriverSupplyRouter.get(
  "/drivers/availability",
  asyncRoute(async (req, res) => {
    if (req.orgScope != null) {
      return res.json(await availabilityFor(req.orgScope));
    }
    // Unscoped (legacy/dev) dispatcher: the same "sees everything" bypass
    // orgWhere() gives every other list route. availabilityFor takes one
    // concrete orgId (Task 6 depends on that exact signature — SDD ledger),
    // so an unscoped caller is served with one batched call per distinct org
    // among all drivers, not one call per driver.
    const orgs = await prisma.driver.findMany({
      where: { orgId: { not: null } },
      select: { orgId: true },
      distinct: ["orgId"],
    });
    const batches = await Promise.all(orgs.map((o) => availabilityFor(o.orgId as string)));
    res.json(batches.flat());
  }),
);

dispatcherDriverSupplyRouter.get(
  "/drivers/:id/availability",
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }
    const [view] = await availabilityFor(driver.orgId, [id]);
    if (!view) return res.status(404).json({ error: "Driver not found" });
    res.json(view);
  }),
);

dispatcherDriverSupplyRouter.patch(
  "/drivers/:id/availability",
  validateBody(patchAvailabilitySchema),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const body = req.body as PatchAvailabilityBody;
    const patch = toPatch(body);

    // Fix round 1: a row counts as a manual STATUS override (deriveStatus's
    // rule 1) ONLY when the dispatcher explicitly chose a status in THIS
    // patch — never as a side effect of toggling acceptingLoads/location
    // fields alone. Previously every PATCH wrote source:"manual"
    // unconditionally, so a driver's very first PATCH — even one that only
    // ever touched acceptingLoads — created a row that sat at the schema's
    // own "UNAVAILABLE" availabilityStatus default and read as a hard
    // override, silently masking acceptingLoads (task-2-report.md, Concern 1).
    //
    //  - availabilityStatus IN the body: upsert source:"manual" with that
    //    status, same as any other field.
    //  - availabilityStatus NOT in the body, no row yet (CREATE): write
    //    source:"derived" and leave availabilityStatus at the schema
    //    default — deriveStatus ignores both on a non-manual row, so the
    //    default can never override anything.
    //  - availabilityStatus NOT in the body, row already exists (UPDATE):
    //    leave source/availabilityStatus completely untouched. An existing
    //    manual override survives a patch that only changes
    //    acceptingLoads/location fields; it is cleared only by explicitly
    //    PATCHing a non-override status (e.g. "AVAILABLE"), never by omission.
    const createData = "availabilityStatus" in body
      ? { driverId: id, source: "manual", availabilityStatus: body.availabilityStatus, ...patch }
      : { driverId: id, source: "derived", ...patch };
    const updateData = "availabilityStatus" in body
      ? { source: "manual", availabilityStatus: body.availabilityStatus, ...patch }
      : { ...patch };

    await prisma.driverAvailability.upsert({
      where: { driverId: id },
      create: createData,
      update: updateData,
    });

    const [view] = await availabilityFor(driver.orgId, [id]);
    if (!view) return res.status(404).json({ error: "Driver not found" });
    res.json(view);
  }),
);

// GET /drivers/:id/metrics — evidence-derived driver metrics (AI Dispatch
// Foundation, Task 4): every number replays real rows (completed
// assignments, scanDetention's claims, the Night Shift agent's own event
// trail) — see lib/driverMetrics.ts's own header. Same 404-not-403
// cross-tenant shape as every other :id route in this file.
dispatcherDriverSupplyRouter.get(
  "/drivers/:id/metrics",
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }
    res.json(await driverMetrics(driver.orgId, id));
  }),
);

const DEFAULT_HISTORY_LIMIT = 50;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 200;

/** `?limit=` clamped to [MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT], defaulting to
 *  DEFAULT_HISTORY_LIMIT for anything absent or unparsable. Unlike
 *  dispatcherDetention.ts's `sinceHours` (a 400 on out-of-range, because a
 *  wide window means an expensive per-driver ping scan), a history PAGE is
 *  cheap either way — a caller who asks for too many/too few rows gets the
 *  nearest valid page instead of an error. */
function historyLimit(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, parsed));
}

// GET /drivers/:id/history — this driver's completed assignments, newest
// (most recently completed) first. late/lateMinutes reuse onTime.ts exactly
// as driverMetrics.ts does, and originCity/destCity/laneKey reuse
// driverMetrics.ts's own laneOfAssignmentStops — three call sites, one rule.
dispatcherDriverSupplyRouter.get(
  "/drivers/:id/history",
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const assignments = await prisma.assignment.findMany({
      where: { orgId: driver.orgId, driverId: id, status: "completed" },
      orderBy: { completedAt: "desc" },
      take: historyLimit(req.query.limit),
      select: {
        id: true,
        loadId: true,
        plannedStart: true,
        plannedEnd: true,
        completedAt: true,
        load: {
          select: {
            externalId: true,
            customerId: true,
            customer: { select: { name: true } },
            stops: {
              orderBy: { sequence: "asc" },
              select: { type: true, address: true, lat: true, lng: true, appointment: { select: { windowEnd: true } } },
            },
          },
        },
      },
    });

    res.json(
      assignments.map((a) => {
        const windowEnd = deliveryWindowEndOf(a.load.stops);
        const lane = laneOfAssignmentStops(a.load.stops);
        return {
          assignmentId: a.id,
          loadId: a.loadId,
          loadRef: a.load.externalId ?? a.loadId,
          customerName: a.load.customer?.name ?? null,
          customerId: a.load.customerId,
          originCity: lane?.originCity ?? null,
          destCity: lane?.destCity ?? null,
          laneKey: lane?.key ?? null,
          plannedStart: a.plannedStart,
          plannedEnd: a.plannedEnd,
          completedAt: a.completedAt,
          deliveryWindowEnd: windowEnd,
          late: isLateAssignment(a.completedAt, windowEnd),
          lateMinutes: lateMinutes(a.completedAt, windowEnd),
        };
      }),
    );
  }),
);
