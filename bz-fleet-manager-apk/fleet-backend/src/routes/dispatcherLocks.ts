import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { outsideCallerOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { emitToDispatchers } from "../realtime.js";
import { acquire, get, release, snapshot, sweep } from "../lib/locks.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Pessimistic lane locks (§6.2). A lane is a driver id; the client holds one
// while its drawer is open and heartbeats every 30 s against a 90 s TTL.
// Mounted the same way as the other Control Tower routers — requireAuth,
// requireDispatcher, attachOrgScope — so req.auth and req.orgScope are set
// before any handler below runs.
export const dispatcherLocksRouter = Router();

const lockSchema = z.object({ laneId: z.string().min(1) });

// Reclaim expired locks periodically so memory does not grow with abandoned
// lanes. unref() so this timer never holds the process — or the test
// runner — open.
const sweeper = setInterval(() => sweep(), 15_000);
sweeper.unref?.();

// Security fix (S2a Task 3, fix round 2): POST/DELETE previously performed no
// ownership check on laneId at all. Harmless while the lock table was
// bucketed by org, but Ruling 14 flattened it to Map<laneId, Lock> (a lane
// has exactly one lock, globally) — which made a lock taken on ANY org's
// driver id visible to that driver's own org's assignment guard
// (lib/laneId.ts's assertNotLockedByOther). Any authenticated dispatcher,
// knowing only another org's driver UUID, could lock it and deny that org's
// own dispatcher their own driver — a working cross-tenant DoS, plus the 409
// body naming the attacker.
//
// The fix: resolve the id first and 404 it (never 403 — a 403 confirms the
// row exists, which is the same enumeration by another route) when it is
// missing or outside the caller's org, exactly as every other dispatcher
// route already did.
//
// The rule is middleware/orgScope.ts's outsideCallerOrg(), called directly.
// That is the ONE definition of "is this nullable-org row outside the
// caller's tenant" — the same function dispatcherDrivers.ts applies to a
// driver and dispatcherAssignments.ts's commit handler applies to THIS VERY
// LANE ID, one request earlier, on its way to the same lock table. Two entry
// points to one lane must not be able to drift apart about who may name it.
//
// An earlier revision of this comment claimed the check "copies
// dispatcherDriverNext.ts's idiom, with one deliberate deviation: gated
// behind `req.orgScope != null` first". Both halves were misleading and are
// recorded here only so the claim is not resurrected. With that gate applied
// the expression simply IS outsideCallerOrg — so it was never a deviation
// from a precedent, it was an inline re-implementation of the shared helper,
// which is the defect and not the design. dispatcherDriverNext.ts is a
// genuinely DIFFERENT rule (`orgId == null` → 404 unconditionally, for every
// caller, because ranking loads needs a real org) and is not the precedent
// this route follows.
//
// Behaviour is unchanged by that refactor — all five cases, as traced when
// the check was introduced:
//   no such driver                → 404
//   scoped caller, orgless driver → 404 (an orgless row is outside every
//                                        tenant, exactly as orgWhere() omits
//                                        it from every list)
//   scoped caller, foreign org    → 404 (the cross-tenant DoS, closed)
//   scoped caller, own org        → allowed
//   unscoped (legacy) caller      → allowed, any org and orgless alike —
//                                        outsideCallerOrg's own
//                                        `req.orgScope != null` gate comes
//                                        first, so middleware/orgScope.ts's
//                                        documented "sees everything" stance
//                                        survives here rather than being
//                                        narrowed by the security fix.
//
// Returns the LANE's owning org on success; on failure it has already sent
// the 404 (mirrors lib/laneId.ts's guardLane).
type LaneResolution = { ok: true; laneOrgId: string | null } | { ok: false };

async function resolveLaneOrNotFound(req: Request, res: Response, laneId: string): Promise<LaneResolution> {
  const driver = await prisma.driver.findUnique({ where: { id: laneId }, select: { orgId: true } });
  if (!driver || outsideCallerOrg(req, driver.orgId)) {
    res.status(404).json({ error: "Driver not found" });
    return { ok: false };
  }
  return { ok: true, laneOrgId: driver.orgId };
}

dispatcherLocksRouter.get("/locks", (req, res) => {
  res.json({ locks: snapshot(req.orgScope ?? null) });
});

// A lock's VISIBILITY follows the LANE's org — the driver being locked — not
// the HOLDER's. For a scoped dispatcher the two are always the same value
// (resolveLaneOrNotFound above refuses any lane outside their org), so this
// changes nothing for them. They diverge only for an unscoped legacy account,
// and there the holder's org was the wrong one: their lock carried orgId null,
// so snapshot()'s `l.orgId === scope` filter hid it from the very org it is
// enforced against (lib/laneId.ts's guardLane is global by laneId). Org A's
// board rendered the lane free, the drag was then refused by a holder the
// board could not name, and the prescribed "refresh on 409" re-fetched a board
// that still showed it free — a retry loop with no exit. Keying visibility to
// the lane makes a lock visible to exactly the people it constrains.
dispatcherLocksRouter.post("/locks", validateBody(lockSchema), asyncRoute(async (req, res) => {
  const { laneId } = req.body as z.infer<typeof lockSchema>;
  const lane = await resolveLaneOrNotFound(req, res, laneId);
  if (!lane.ok) return;
  const dispatcherId = req.auth!.dispatcherId!;
  // attachOrgScope already loaded this dispatcher once (for orgId) but didn't
  // keep the name; the lock's `name` is what the 409 toast on another
  // dispatcher's screen shows, so fetch it here.
  const me = await prisma.dispatcher.findUnique({ where: { id: dispatcherId }, select: { name: true } });
  const r = acquire(laneId, dispatcherId, me?.name ?? "Dispatcher", lane.laneOrgId);
  if (!r.ok) return res.status(409).json({ error: "ENTITY_ALREADY_LOCKED", lock: r.lock });
  // Only announce a genuinely new hold; a heartbeat must not spam every
  // board. `fresh` (not a `since`/`expiresAt` comparison) is the source of
  // truth here — see lib/locks.ts.
  if (r.fresh) {
    emitToDispatchers(lane.laneOrgId, "lane_lock", {
      laneId, by: r.lock.name, dispatcherId, since: r.lock.since,
    });
  }
  res.json({ lock: r.lock });
}));

dispatcherLocksRouter.delete("/locks/:laneId", asyncRoute(async (req, res) => {
  const laneId = req.params.laneId as string;
  const lane = await resolveLaneOrNotFound(req, res, laneId);
  if (!lane.ok) return;
  const dispatcherId = req.auth!.dispatcherId!;
  // Read the holder BEFORE releasing, against the same `now` release() judges
  // by: on refusal the 409 must carry `lock` like every other
  // ENTITY_ALREADY_LOCKED in the codebase — without it the client's toast
  // renders "Locked by undefined" — and after a successful release there is
  // nothing left to read. release() stays the decider of who may release;
  // this only supplies the body.
  const now = Date.now();
  const held = get(laneId, now);
  if (!release(laneId, dispatcherId, now)) {
    return res.status(409).json({ error: "ENTITY_ALREADY_LOCKED", lock: held });
  }
  // Same lane-org visibility rule as POST above: the board that must learn a
  // lane came free is the lane's org, not the releasing dispatcher's.
  emitToDispatchers(lane.laneOrgId, "lane_unlock", { laneId });
  res.status(204).end();
}));
