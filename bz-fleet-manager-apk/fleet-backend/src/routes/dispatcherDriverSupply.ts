import { Router } from "express";
import { z } from "zod";
import type { DriverPreference } from "@prisma/client";
import { prisma } from "../db.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { availabilityFor } from "../lib/driverAvailability.js";
import { driverMetrics } from "../lib/driverMetrics.js";
import { driverHistory } from "../lib/driverHistory.js";

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
// (most recently completed) first. The query itself now lives in
// lib/driverHistory.ts (AI Dispatch Foundation, Task 5) so
// dispatchTools/drivers.ts's getDriverHistory shares it instead of a second
// copy; this handler keeps the HTTP-specific `?limit=` parsing/clamping.
dispatcherDriverSupplyRouter.get(
  "/drivers/:id/history",
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }

    res.json(await driverHistory(driver.orgId, id, historyLimit(req.query.limit)));
  }),
);

// ---------------------------------------------------------------------------
// GET/PATCH /drivers/:id/preference (AI Dispatch Foundation, Task 9): the
// lanes/regions/equipment a driver wants (schema's own DriverPreference,
// added by Task 1 — matching/scoring never enforces it as a hard
// constraint). Same 404-not-403 cross-tenant shape as every other :id route
// in this file.
// ---------------------------------------------------------------------------

const MAX_PREFERENCE_LIST_ITEMS = 20;
const MAX_PREFERENCE_ITEM_LEN = 60;
const MAX_HOME_TIME_TARGET_LEN = 40;

// Two-letter region codes only (e.g. "TX") — matches Driver.homeBaseState's
// own vocabulary; not validated against geocode.ts's STATE_CODES set because
// a preference is a free-form wish ("avoid the Northeast corridor" states),
// not a resolved address, and a typo here only narrows matching, it never
// corrupts a real record the way a bad address would.
const REGION_RE = /^[A-Za-z]{2}$/;
// "City, ST > City, ST" — the brief's own lane label shape.
const LANE_RE = /^[A-Za-z][A-Za-z .'-]*, [A-Za-z]{2} > [A-Za-z][A-Za-z .'-]*, [A-Za-z]{2}$/;

const regionList = () =>
  z.array(z.string().max(MAX_PREFERENCE_ITEM_LEN).regex(REGION_RE)).max(MAX_PREFERENCE_LIST_ITEMS);
const laneList = () =>
  z.array(z.string().max(MAX_PREFERENCE_ITEM_LEN).regex(LANE_RE)).max(MAX_PREFERENCE_LIST_ITEMS);

const patchPreferenceSchema = z
  .object({
    maxTripMiles: z.number().int().min(0).nullable().optional(),
    preferredRegions: regionList().optional(),
    preferredLanes: laneList().optional(),
    avoidRegions: regionList().optional(),
    avoidLanes: laneList().optional(),
    homeTimeTarget: z.string().max(MAX_HOME_TIME_TARGET_LEN).nullable().optional(),
    willingToDriveNight: z.boolean().optional(),
    willingToRelocateMiles: z.number().int().min(0).nullable().optional(),
    preferredEquipment: z.array(z.string().max(MAX_PREFERENCE_ITEM_LEN)).max(MAX_PREFERENCE_LIST_ITEMS).optional(),
  })
  // Same "at least one key present" rule as patchAvailabilitySchema above.
  .refine((data) => Object.keys(data).length > 0, { message: "at least one field is required" });

type PatchPreferenceBody = z.infer<typeof patchPreferenceSchema>;

export interface DriverPreferenceView {
  maxTripMiles: number | null;
  preferredRegions: string[];
  preferredLanes: string[];
  avoidRegions: string[];
  avoidLanes: string[];
  homeTimeTarget: string | null;
  willingToDriveNight: boolean;
  willingToRelocateMiles: number | null;
  preferredEquipment: string[];
}

/** The documented defaults for a driver with no DriverPreference row yet —
 *  never invented per-driver, always this exact shape. */
const DEFAULT_PREFERENCE: DriverPreferenceView = {
  maxTripMiles: null,
  preferredRegions: [],
  preferredLanes: [],
  avoidRegions: [],
  avoidLanes: [],
  homeTimeTarget: null,
  willingToDriveNight: true,
  willingToRelocateMiles: null,
  preferredEquipment: [],
};

/** Strips driverId/updatedAt so a found row and DEFAULT_PREFERENCE answer
 *  with the identical shape — the portal never needs to special-case which
 *  one it got. */
function toPreferenceView(row: DriverPreference): DriverPreferenceView {
  return {
    maxTripMiles: row.maxTripMiles,
    preferredRegions: row.preferredRegions,
    preferredLanes: row.preferredLanes,
    avoidRegions: row.avoidRegions,
    avoidLanes: row.avoidLanes,
    homeTimeTarget: row.homeTimeTarget,
    willingToDriveNight: row.willingToDriveNight,
    willingToRelocateMiles: row.willingToRelocateMiles,
    preferredEquipment: row.preferredEquipment,
  };
}

dispatcherDriverSupplyRouter.get(
  "/drivers/:id/preference",
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }
    const row = await prisma.driverPreference.findUnique({ where: { driverId: id } });
    res.json(row ? toPreferenceView(row) : DEFAULT_PREFERENCE);
  }),
);

dispatcherDriverSupplyRouter.patch(
  "/drivers/:id/preference",
  validateBody(patchPreferenceSchema),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
    if (!driver || driver.orgId == null || outsideOrg(req, driver.orgId)) {
      return res.status(404).json({ error: "Driver not found" });
    }
    const body = req.body as PatchPreferenceBody;
    const updated = await prisma.driverPreference.upsert({
      where: { driverId: id },
      create: { driverId: id, ...body },
      update: body,
    });
    res.json(toPreferenceView(updated));
  }),
);
