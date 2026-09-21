import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { emitToDriver } from "../realtime.js";
import { unassign } from "../lib/assignmentActions.js";
import { respondToWriteConflict } from "../lib/writeConflict.js";
import { orgWhere, outsideOrg } from "../middleware/orgScope.js";
import { geocodeAddress } from "../lib/geocode.js";
import { clearPlaceAttention, settlePendingStops } from "../lib/geocodeSettle.js";
import { guardLoad } from "../lib/loadGuard.js";
import { applyLoadChange, applyStatusChange, InvalidStopSet, LoadNotFound, nextAtMs, StaleVersion, type LoadPatch } from "../lib/loadWriter.js";
import { LoadLocked } from "../lib/loadLocks.js";
import { actorOf, SYSTEM_ACTOR } from "../lib/actor.js";
import { emitLoadChanged } from "../lib/loadEvents.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Load detail + edit (Control Tower screen 3). A load is editable only while
// it is open — once assigned, its stops/appointments are the basis of a
// committed plan and must go through unassign first. Stops are replaced
// wholesale on save (same reconciliation semantics as import). Mounted under
// dispatcherRouter with attachOrgScope.
export const dispatcherLoadsRouter = Router();

dispatcherLoadsRouter.get("/loads", asyncRoute(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const loads = await prisma.load.findMany({
    where: { ...orgWhere(req), ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    include: { stops: { orderBy: { sequence: "asc" } }, assignment: { select: { id: true, driverId: true } } },
  });
  res.json(loads);
}));

dispatcherLoadsRouter.get("/loads/:id", asyncRoute(async (req, res) => {
  const load = await prisma.load.findUnique({
    where: { id: req.params.id as string },
    include: {
      stops: { include: { appointment: true }, orderBy: { sequence: "asc" } },
      assignment: { include: { driver: { select: { id: true, name: true } } } },
      rate: true,
    },
  });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });
  res.json(load);
}));

const stopSchema = z.object({
  sequence: z.number().int().min(1),
  type: z.enum(["pickup", "delivery", "intermediate"]),
  address: z.string().min(1),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  dwellMin: z.number().int().min(0).nullable().optional(),
  windowStart: z.string().datetime().nullable().optional(),
  windowEnd: z.string().datetime().nullable().optional(),
});

const patchSchema = z.object({
  requiredEquip: z.enum(["DryVan", "Reefer", "Flatbed", "StepDeck", "Tanker", "Intermodal"]).optional(),
  revenueCents: z.number().int().min(0).optional(),
  fscCents: z.number().int().min(0).optional(),
  hazmatClass: z.string().nullable().optional(),
  commodity: z.string().nullable().optional(),
  brokerName: z.string().nullable().optional(),
  weightLbs: z.number().int().min(0).nullable().optional(),
  stops: z.array(stopSchema).min(2).optional(),
});

// Re-attempt geocoding for a load's pending stops — the recovery path after
// configuring GEOCODER_URL (or fixing an address via PATCH would also work).
dispatcherLoadsRouter.post("/loads/:id/geocode", asyncRoute(async (req, res) => {
  const load = await prisma.load.findUnique({
    where: { id: req.params.id as string },
    include: { stops: { orderBy: { sequence: "asc" } } },
  });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });
  // §7.3/R8: a load someone else is editing refuses every writer. Geocoding
  // rewrites that load's stops (and clears the writer's own attention line),
  // which is exactly a write under an open editor.
  if (!(await guardLoad(req, res, load.id))) return;

  let version: number;
  let roles: string[];
  let resolvedCount: number;
  try {
    // Network resolution FIRST and entirely outside the Postgres transaction
    // below — the same rule the writer itself follows (lib/loadWriter.ts
    // never does I/O inside a transaction) — but still inside this try: an
    // unexpected throw here must answer 500, not hang the request forever
    // (Express 4 does not await async handlers), the same as a failure in
    // the transaction itself.
    const resolved: { stopId: string; role: string; lat: number; lng: number }[] = [];
    for (const stop of load.stops) {
      if (stop.lat != null && stop.lng != null) continue;
      const hit = await geocodeAddress(stop.address);
      if (!hit) continue;
      resolved.push({ stopId: stop.id, role: stop.type, lat: hit.lat, lng: hit.lng });
    }
    resolvedCount = resolved.length;

    if (resolved.length === 0) {
      version = load.version;
      roles = [];
    } else {
      // Which stop ROLES this recovery placed, not a count — that is what
      // `load_changed`'s `fields` means everywhere else, and two resolved
      // intermediates are one fact ("intermediate moved"), not two frames.
      roles = [...new Set(resolved.map((r) => r.role))];
      const actor = SYSTEM_ACTOR("geocoder");
      // Fix round 1: every WRITE this recovery makes — the stops, the
      // attention rows it clears, the version bump, the trace row — now
      // lands in ONE transaction. A failure partway used to persist
      // coordinates while the version stood still (a lie: the record
      // changed but nothing said so).
      version = await prisma.$transaction(async (tx) => {
        for (const r of resolved) {
          await tx.loadStop.update({ where: { id: r.stopId }, data: { lat: r.lat, lng: r.lng, geocodeStatus: "ok" } });
        }
        // The `can't place <role> "…" on the map` line the writer left is
        // about a stop we could not place — and we just placed it. Without
        // this the pill stayed on the board forever after the recovery that
        // fixed it. One clear per ROLE, matching `roles` above.
        for (const role of roles) await clearPlaceAttention(load.id, role, tx);
        const bumped = await tx.load.update({ where: { id: load.id }, data: { version: { increment: 1 } }, select: { version: true } });
        // This route writes LoadStop rows directly rather than through
        // applyLoadChange (the writer only ever consults the in-memory
        // gazetteer inside a transaction; this recovery path exists
        // specifically to call the network provider), so nothing else
        // leaves a trace row for the version tick above. `applyLoadChange`'s
        // own scalar trace is built by a closure private to that function
        // (loadWriter.ts's `entry`, not exported) — mirrored here by hand
        // rather than inventing a second shape, per spec §5.2: every
        // version tick has one.
        await tx.loadChange.create({
          data: {
            loadId: load.id, orgId: load.orgId, atMs: nextAtMs(), actorId: actor.dispatcherId, actorName: actor.name,
            source: "system", field: "geocode", before: null, after: `placed ${roles.join(", ")}`, note: null,
          },
        });
        return bumped.version;
      });
    }
  } catch (e) {
    console.error("POST /loads/:id/geocode failed", e);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }

  const fresh = await prisma.loadStop.findMany({ where: { loadId: load.id }, orderBy: { sequence: "asc" } });
  const pending = fresh.filter((s) => s.lat == null || s.lng == null).length;
  if (resolvedCount > 0) {
    emitLoadChanged(load.orgId, { loadId: load.id, version, fields: roles });
  }
  res.json({ resolved: resolvedCount, pending });
}));

/** What the dispatcher must actually do first, given the load's status.
 *
 *  A single blanket "unassign it first" was wrong for most of the statuses it
 *  fired on: a TENDERED load is withdrawn, not unassigned (the driver has an
 *  offer open, and the button is Withdraw tender / decline); a ROLLING or
 *  DELIVERED one cannot be unassigned at all — DELETE /assignments/:id refuses
 *  anything outside PRE_ROLL_STATUSES — so telling a dispatcher to unassign it
 *  sends them to a button that will 409 them too. Only "assigned" ever meant
 *  what the old message said. */
function nextStepFor(status: string, action: "cancel" | "edit"): string {
  if (status === "tendered") return "withdraw the tender first";
  if (status === "assigned") return "unassign it first";
  // The one status whose answer depends on what you were trying to do: there
  // is nothing left to do about a canceled load you are canceling, but a
  // canceled load you want to EDIT has a real next step, and POST
  // /loads/:id/reopen is exactly it.
  if (status === "canceled") return action === "edit" ? "reopen it first" : "it is already canceled";
  return "a rolling or delivered load can no longer be changed";
}

// Cancel: the broker pulled the freight. An assigned or rolling load must be
// unassigned first, so the driver's HOS and the board reflect reality; only
// "open" and "tendered" pass the guard below. Every report already excludes
// canceled loads; this is the endpoint that finally produces them.
//
// CRITICAL (S2a final review, C1): the "tendered" arm of that guard was
// written when "tendered" was an UNREACHABLE Load.status and therefore
// canceled nothing but an open load. Task 6 made it reachable, and a tendered
// load has a LIVE Assignment behind it — which this handler then left
// standing: the driver's provisionally-consumed hours stayed consumed for
// freight that no longer existed and fed every later feasibility decision for
// the rest of their cycle; the leg kept occupying their lane in every
// ACTIVE_STATUSES query; and their app still held an offer they could accept,
// flipping the canceled load back to "assigned" and putting them on the road
// with no dispatcher action at all.
//
// So: cancelling a load that still has an assignment unassigns it first, in
// the same transaction, through lib/assignmentActions.ts's unassign() — the
// SAME helper DELETE /assignments/:id and the tender decline use, never a
// second copy of the HOS restore. unassign() frees the load back to "open" on
// its way past; the update below then takes it to "canceled", and the two
// being one Serializable transaction is what stops a crash between them from
// leaving the freight back on the backlog.
//
// DELIBERATELY NOT LANE-GUARDED, unlike every assignment mutation — and this
// is a RULING, not an oversight, so please do not "fix" it. A cancellation is
// external reality: the broker has pulled the freight, and it is gone whether
// or not a colleague happens to have that driver's drawer open. Refusing the
// cancel on a 409 would leave a live tender sitting on the driver's phone for
// a load that no longer exists — they could then accept it — which is
// strictly worse than the concurrent-edit collision the guard would prevent.
// The guard is right for a drag (two dispatchers disagreeing about where a leg
// should go); it is wrong for a fact that has already happened. If this ever
// does need guarding, note the driver is already tenancy-proven via the load,
// so guardLane(req, res, assignment.driverId) would be safe to add.
dispatcherLoadsRouter.post("/loads/:id/cancel", asyncRoute(async (req, res) => {
  const load = await prisma.load.findUnique({ where: { id: req.params.id as string } });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });
  if (load.status !== "open" && load.status !== "tendered") {
    return res.status(409).json({ error: `load is ${load.status}; ${nextStepFor(load.status, "cancel")}` });
  }
  // Looked up for BOTH permitted statuses, not just "tendered": an assignment
  // hanging off a load the status column calls "open" is already broken state,
  // and cancelling around it would preserve exactly the leak this fixes.
  const assignment = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  const actor = await actorOf(req);

  // The write-conflict mapping is NOT optional here, and this handler shipped
  // without it — a regression the C1 fix introduced by opening a transaction on
  // a route that never had one. The race is the exact one lib/writeConflict.ts
  // describes and needs no injection to hit: the dispatcher presses Cancel as
  // the driver taps Reject. The decline deletes the Assignment first, this
  // transaction's `tx.assignment.delete` raises P2025, and with nothing mapping
  // it Express 4 sends NO RESPONSE AT ALL — the Cancel button spins forever
  // while unassign() has already put the freight the broker pulled back on the
  // backlog as "open", bookable by anyone.
  let result;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // Fix round 1: bypassLock — unassign()'s status write must never hang
        // behind another dispatcher's Cockpit edit lock on this load; a
        // cancellation is external reality (see the ruling above) and this is
        // the same stance, just no longer routed around the lock by accident.
        if (assignment) await unassign(tx, assignment, actor, { bypassLock: true });
        // R16: cancel moves through the one writer, same as every other
        // status change — a trace row now explains the single most
        // consequential transition in the product, not just the version tick
        // F6 already gave it. bypassLock keeps the ruling above intact: a
        // cancellation is external reality and must not be refused by a
        // colleague's edit lock.
        const r = await applyStatusChange(tx, {
          loadId: load.id, orgId: load.orgId, actor, source: "loadboard",
          status: "canceled", note: "canceled from the loadboard", bypassLock: true,
        });
        const fresh = await tx.load.findUniqueOrThrow({ where: { id: load.id } });
        return { load: fresh, version: r.version };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    // Fix round 1: a never-hang net, same shape as PATCH's mapping below.
    // bypassLock above means this should not be reachable in the normal
    // unassign path — kept as a backstop against any future write in this
    // transaction that re-adds a lock check without threading bypassLock.
    if (err instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: err.lock, message: err.message });
    // Either row can be the one that vanished: the Assignment (the driver
    // answered the tender) or the Load itself. The transaction rolled back, so
    // the load is whatever the winner left it as — "open" after a decline,
    // which cancels cleanly on the retry this message asks for.
    if (respondToWriteConflict(res, err, "This load's tender was answered while you were canceling — refresh the board and cancel again")) return;
    // F5: an unrecognised error must never leave this handler silent — Express
    // 4 does not await async handlers, so an uncaught throw here would answer
    // the Cancel button with nothing at all, forever.
    console.error("POST /loads/:id/cancel failed", err);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }

  // The driver's app must drop the offer it is holding — the same event the
  // unassign path sends, or the Accept button stays live on a phone.
  if (assignment) emitToDriver(assignment.driverId, "trip_unassignment", { loadId: load.id });
  emitLoadChanged(load.orgId, { loadId: load.id, version: result.version, fields: ["status"] });
  res.json(result.load);
}));

// Reopen: the fat-finger recovery for cancel (and the "broker called back"
// path). Canceled -> open puts the load straight back in the backlog.
dispatcherLoadsRouter.post("/loads/:id/reopen", asyncRoute(async (req, res) => {
  const load = await prisma.load.findUnique({ where: { id: req.params.id as string } });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });
  if (load.status !== "canceled") {
    return res.status(409).json({ error: `load is ${load.status}; only canceled loads reopen` });
  }
  // §7.3/R8: unlike cancel below, a reopen is not external reality that must
  // land — it is a dispatcher's own decision, so it waits for the editor.
  if (!(await guardLoad(req, res, load.id))) return;
  // F6/plan A3: the load's status now moves through the one writer, same as
  // every other Load write. A board rendered at version N has to learn that
  // what it holds is stale (spec §9), and the §7.4 backstop is only a
  // backstop if every writer bumps it.
  const actor = await actorOf(req);
  let r;
  try {
    r = await prisma.$transaction((tx) =>
      applyStatusChange(tx, { loadId: load.id, orgId: load.orgId, actor, source: "loadboard", status: "open", note: "reopened from the loadboard" }),
    );
  } catch (e) {
    // guardLoad above already refuses a load someone else holds — this is a
    // belt-and-suspenders re-check inside the writer, which is the authority.
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    // F5: LoadNotFound is a named, reachable outcome here — the load can
    // vanish between the findUnique above and this transaction — and every
    // other unrecognised error must still answer, not hang: Express 4 sends
    // no response at all for a throw out of an async handler.
    if (e instanceof LoadNotFound) return res.status(404).json({ error: "This load was removed before it could be reopened — refresh the board." });
    console.error("POST /loads/:id/reopen failed", e);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }
  const updated = await prisma.load.findUnique({ where: { id: load.id } });
  emitLoadChanged(load.orgId, { loadId: load.id, version: r.version, fields: ["status"] });
  res.json(updated);
}));

/** PATCH /loads/:id' "what vanished?" answer (lib/writeConflict.ts). */
const LOAD_EDIT_GONE =
  "This load was removed while you were editing it — none of your changes were saved. Refresh the board.";

dispatcherLoadsRouter.patch("/loads/:id", asyncRoute(async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  const body = parsed.data;

  const load = await prisma.load.findUnique({ where: { id: req.params.id as string } });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });
  if (!(await guardLoad(req, res, load.id))) return;
  if (load.status !== "open") {
    return res.status(409).json({ error: `load is ${load.status}; ${nextStepFor(load.status, "edit")}` });
  }
  if (body.stops) {
    const hasPickup = body.stops.some((s) => s.type === "pickup");
    const hasDelivery = body.stops.some((s) => s.type === "delivery");
    if (!hasPickup || !hasDelivery) {
      return res.status(400).json({ error: "stops need at least one pickup and one delivery" });
    }
  }

  // Plan A3: every Cockpit write to a Load goes through the same writer the
  // broker board uses — one LoadChange row per field, one version tick, the
  // same lock gate. Stops arrive as the whole ordered list (`stopSet`), the
  // writer's own reconciliation semantics for the Cockpit's stop editor.
  const actor = await actorOf(req);
  const { stops, ...fields } = body;
  const patch: LoadPatch = {
    ...fields,
    ...(stops
      ? {
          stopSet: stops.map((s) => ({
            ...s,
            windowStart: s.windowStart ? new Date(s.windowStart) : null,
            windowEnd: s.windowEnd ? new Date(s.windowEnd) : null,
          })),
        }
      : {}),
  };
  let result;
  try {
    result = await prisma.$transaction(
      (tx) => applyLoadChange(tx, { loadId: load.id, orgId: load.orgId, actor, source: "loadboard", patch }),
      { timeout: 15_000 },
    );
  } catch (e) {
    // What vanishes here is the LOAD itself (or one of its stops, deleted with
    // it) — not a tender and not an assignment: PATCH only accepts a load that
    // is still "open", so there is nothing on a driver's lane to lose.
    if (e instanceof LoadNotFound) return res.status(404).json({ error: LOAD_EDIT_GONE });
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleVersion) return res.status(409).json({ error: "STALE_VERSION", current: e.current });
    if (e instanceof InvalidStopSet) return res.status(400).json({ error: "INVALID_STOP_SET", message: e.message });
    console.error("PATCH /loads/:id failed", e);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }
  // The writer only ever consults the in-memory gazetteer (no I/O inside the
  // transaction) — this settles any stop it left "pending" against the
  // configured provider, same recovery path as POST /loads/:id/geocode.
  const settled = await settlePendingStops(load.orgId, [load.id]);
  const fresh = await prisma.load.findUnique({
    where: { id: load.id },
    include: { stops: { orderBy: { sequence: "asc" }, include: { appointment: true } } },
  });

  // F7: a no-op PATCH (values identical to what is stored) must not wake
  // every other board — `result.changed` is empty and the version did not
  // move, so there is nothing for either frame to say. Same rule the
  // broker-board routes already apply (dispatcherBrokerBoard.ts:315, 475).
  if (result.changed.length > 0) {
    emitLoadChanged(load.orgId, { loadId: load.id, version: result.version, fields: result.changed });
  }
  // M6: a stop the gazetteer left pending may have just been placed by the
  // provider, in its own transaction with its own version bump — a fact the
  // frame above (at the writer's version) says nothing about.
  for (const s of settled) emitLoadChanged(load.orgId, { loadId: s.loadId, version: s.version, fields: s.roles });
  res.json(fresh);
}));
