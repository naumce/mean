import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Driver, DriverLocation } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { emitToDispatchers } from "../realtime.js";
import {
  acceptTender,
  declineTender,
  TENDER_ACCEPT_GONE,
  TENDER_DECLINE_GONE,
} from "../lib/assignmentActions.js";
import { respondToWriteConflict } from "../lib/writeConflict.js";
import { SYSTEM_ACTOR } from "../lib/actor.js";
import { LoadLocked } from "../lib/loadLocks.js";
import { asyncRoute } from "../lib/asyncRoute.js";

export const driverRouter = Router();
driverRouter.use(requireAuth);

driverRouter.get("/profile", asyncRoute(async (req, res) => {
  const d = await prisma.driver.findUnique({ where: { id: req.auth!.driverId } });
  if (!d) return res.status(404).json({ error: "Not found" });
  const { passwordHash, ...safe } = d;
  res.json(safe);
}));

driverRouter.put("/status", validateBody(z.object({ status: z.string().min(1) })), asyncRoute(async (req, res) => {
  const d = await prisma.driver.update({
    where: { id: req.auth!.driverId }, data: { status: req.body.status } });
  // Live lane dot on the Control Tower board — delivery only, board state
  // is already committed above.
  emitToDispatchers(d.orgId, "driver_status", { driverId: d.id, status: d.status });
  res.json({ status: d.status });
}));

driverRouter.get("/trip/current", asyncRoute(async (req, res) => {
  const t = await prisma.trip.findFirst({
    where: { driverId: req.auth!.driverId, status: { in: ["assigned", "in_progress", "arrived"] } },
    orderBy: { createdAt: "desc" } });
  if (!t) return res.json({ success: false });
  res.json({ success: true, tripId: t.id, tripIdentifier: t.identifier,
             preTripCheckCompleted: t.preTripCheckCompleted });
}));

driverRouter.get("/trips/active", asyncRoute(async (req, res) => {
  const trips = await prisma.trip.findMany({
    where: { driverId: req.auth!.driverId, status: { in: ["assigned", "in_progress", "arrived"] } } });
  res.json(trips);
}));

/** POST /driver/location's "what vanished?" answer (lib/writeConflict.ts). */
const LOCATION_DRIVER_GONE =
  "This driver account no longer exists — sign in again. The position was not recorded.";

driverRouter.post("/location", validateBody(z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  speed: z.number().optional(), heading: z.number().optional(), accuracy: z.number().optional(),
})), asyncRoute(async (req, res) => {
  const { latitude, longitude } = req.body as { latitude: number; longitude: number };
  // The dispatch engine's deadhead math reads Driver.lastLat/lastLng, so a
  // location ping must refresh them — otherwise ⚡Suggest keeps ranking from
  // wherever the last CSV import left the driver.
  // The ping and the denormalised position on Driver are one transaction, and
  // an unmapped transaction is not a 500 — Express 4 does not await this
  // handler, so a rejection here sent NO response and the phone's location
  // queue retried against a socket that was never going to answer. This is
  // the highest-frequency write in the product, so it is also the likeliest
  // loser of a deadlock with a commit or an unassign touching the same Driver
  // row.
  let loc: DriverLocation;
  let driver: Driver;
  try {
    [loc, driver] = await prisma.$transaction([
      prisma.driverLocation.create({ data: { driverId: req.auth!.driverId, latitude, longitude } }),
      prisma.driver.update({
        where: { id: req.auth!.driverId },
        data: { lastLat: latitude, lastLng: longitude, lastLocationAt: new Date() },
      }),
    ]);
  } catch (err) {
    // What vanishes on THIS path is the driver's own account row — deleted or
    // re-provisioned while their app still holds a valid token — not a tender
    // or a load. The ping is dropped whole; the next one carries the position
    // anyway, so the app has nothing to re-send.
    if (respondToWriteConflict(res, err, LOCATION_DRIVER_GONE)) return;
    throw err;
  }
  emitToDispatchers(driver.orgId, "driver_location", {
    driverId: driver.id, driverName: driver.name, latitude, longitude, at: loc.createdAt.toISOString(),
  });
  res.status(201).json(loc);
}));

// Cockpit S2a Task 9: the driver's own accept/decline of an outstanding
// tender — the same effects as the dispatcher's POST
// /assignments/:id/tender/accept|decline (Task 7), reached through
// lib/assignmentActions.ts so neither the HOS-restore arithmetic nor the
// accept/decline transaction has a second copy (see that file's header).
//
// The only logic that is new here is the ownership check. There is no lane
// lock to guard (locks are a dispatcher-vs-dispatcher concurrency device;
// this is the driver acting on their own tender) and no org scope (driver
// routes carry none) — just: does this assignment belong to the calling
// driver? requireAuth already resolved a dispatcher token's req.auth.driverId
// to the "" sentinel (middleware/auth.ts's NO_DRIVER), which can never equal
// a real assignment.driverId, so the same comparison also rejects a
// dispatcher token without any extra role check.
//
// A mismatch — wrong driver OR a dispatcher token — is a 404, never 403:
// confirming that a tender exists for an assignment the caller cannot act on
// is the same enumeration a 403 would be.
const driverDeclineSchema = z.object({ reason: z.string().max(500).optional() });

async function findOwnTenderOr404(req: Request, res: Response) {
  const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id as string } });
  if (!assignment || assignment.driverId !== req.auth!.driverId) {
    res.status(404).json({ error: "Assignment not found" });
    return null;
  }
  return assignment;
}

driverRouter.post("/tenders/:id/accept", asyncRoute(async (req, res) => {
  const assignment = await findOwnTenderOr404(req, res);
  if (!assignment) return;

  if (assignment.status !== "tendered") {
    return res.status(409).json({ error: `cannot accept a ${assignment.status} assignment` });
  }

  // Same write-conflict mapping as the dispatcher's route. The driver is the
  // MORE likely loser of this race — the dispatcher can withdraw the tender at
  // any moment while the offer sits on a phone — and an unmapped rejection
  // leaves the Accept button spinning with no answer at all.
  //
  // Fix round 1: this is the DRIVER accepting their own tender, not a
  // dispatcher — actorOf(req) would have read a dispatcher token's id and
  // silently mislabeled the trace "dispatcher" for a driver token that
  // carries none. Named explicitly instead, so the LoadChange row says who.
  const driver = await prisma.driver.findUnique({ where: { id: assignment.driverId }, select: { name: true } });
  const actor = SYSTEM_ACTOR(`driver ${driver?.name ?? assignment.driverId}`);
  let updated;
  try {
    // Fix round 2 (ruling R14): the driver has taken the freight — external
    // reality, same stance as the decline below. A dispatcher's Cockpit edit
    // lock on this load must not refuse it, let alone hang it.
    updated = await acceptTender(assignment, actor, { bypassLock: true });
  } catch (err) {
    // Fix round 2: a never-hang net, same shape cancel and PATCH /loads/:id
    // already use. bypassLock above means this should not be reachable
    // today — kept as a backstop against a future regression.
    if (err instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: err.lock, message: err.message });
    if (respondToWriteConflict(res, err, TENDER_ACCEPT_GONE)) return;
    throw err;
  }

  res.json({ assignment: updated });
}));

driverRouter.post("/tenders/:id/decline", validateBody(driverDeclineSchema), asyncRoute(async (req, res) => {
  const { reason } = req.body as z.infer<typeof driverDeclineSchema>;
  const assignment = await findOwnTenderOr404(req, res);
  if (!assignment) return;

  if (assignment.status !== "tendered") {
    return res.status(409).json({ error: `cannot decline a ${assignment.status} assignment` });
  }

  try {
    await declineTender(assignment, reason);
  } catch (err) {
    // Fix round 2: same never-hang net as accept above. declineTender's own
    // unassign() call already passes bypassLock:true (fix round 1), so this
    // should not be reachable today — kept as the same backstop.
    if (err instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: err.lock, message: err.message });
    if (respondToWriteConflict(res, err, TENDER_DECLINE_GONE)) return;
    throw err;
  }

  res.status(204).send();
}));

// ── "Where are you?" — the driver's side of the handshake ──────────────────
//
// The dispatcher asks; the phone shows this; the driver presses approve or
// deny. Approving is the ONLY path that shares a position, and it does so by
// writing a normal ping — so a shared location is the same kind of fact as any
// other, visible on the map and in the trail, not a special hidden record.
//
// Denying is a real answer and is recorded as one. Nothing here lets a
// dispatcher extract a position without the driver's action.

/** Requests waiting on THIS driver. The phone polls (or is pushed) this. */
driverRouter.get("/location-requests", asyncRoute(async (req, res) => {
  const pending = await prisma.locationRequest.findMany({
    where: { driverId: req.auth!.driverId, status: "pending" },
    orderBy: { requestedAt: "desc" },
    select: { id: true, requestedAt: true },
  });
  res.json(pending);
}));

driverRouter.post(
  "/location-requests/:id/respond",
  validateBody(
    z.object({
      approve: z.boolean(),
      // Present only when approving. Optional rather than conditional so a
      // denial never has to carry a position it does not have.
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    }),
  ),
  asyncRoute(async (req, res) => {
    const { approve, latitude, longitude } = req.body as {
      approve: boolean;
      latitude?: number;
      longitude?: number;
    };
    // Scoped to the driver's own id: one driver can never answer another's
    // request, and an id from someone else is NOT FOUND, not forbidden.
    const request = await prisma.locationRequest.findFirst({
      // String(...) because Express types params as string | string[]; a
      // repeated ?id= would otherwise reach Prisma as an array.
      where: { id: String(req.params.id), driverId: req.auth!.driverId },
    });
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== "pending") {
      // Already answered or expired. Re-answering would rewrite history.
      return res.status(409).json({ error: `Request is already ${request.status}` });
    }

    if (!approve) {
      const denied = await prisma.locationRequest.update({
        where: { id: request.id },
        data: { status: "denied", respondedAt: new Date() },
      });
      return res.json(denied);
    }

    if (typeof latitude !== "number" || typeof longitude !== "number") {
      // Approving without coordinates would produce an "approved" request
      // carrying no location — the one state this model must never reach.
      return res.status(400).json({ error: "latitude and longitude are required to approve" });
    }

    let loc: DriverLocation;
    try {
      [loc] = await prisma.$transaction([
        prisma.driverLocation.create({ data: { driverId: req.auth!.driverId, latitude, longitude } }),
        prisma.driver.update({
          where: { id: req.auth!.driverId },
          data: { lastLat: latitude, lastLng: longitude, lastLocationAt: new Date() },
        }),
      ]);
    } catch (err) {
      if (respondToWriteConflict(res, err, LOCATION_DRIVER_GONE)) return;
      throw err;
    }
    const approved = await prisma.locationRequest.update({
      where: { id: request.id },
      data: { status: "approved", respondedAt: new Date(), locationId: loc.id },
    });
    const driver = await prisma.driver.findUnique({ where: { id: req.auth!.driverId } });
    if (driver?.orgId) {
      emitToDispatchers(driver.orgId, "driver_location", {
        driverId: driver.id, driverName: driver.name, latitude, longitude, at: loc.createdAt.toISOString(),
      });
    }
    res.json(approved);
  }),
);
