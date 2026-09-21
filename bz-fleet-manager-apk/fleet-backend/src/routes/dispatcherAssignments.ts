import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Assignment } from "@prisma/client";
import { prisma } from "../db.js";
import { outsideCallerOrg, outsideOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { emitToDispatchers, emitToDriver } from "../realtime.js";
import { computeEconomics, type RateBreakdown, type RateConfig } from "../domain/dispatch/economics.js";
import { evaluate } from "../domain/dispatch/evaluate.js";
import { restConflict } from "../domain/dispatch/restConflict.js";
import {
  toDriverInput,
  toLoadInput,
  toTractorInput,
  toTrailerInput,
  type DriverRow,
  type HosRow,
  type LoadRow,
  type TractorRow,
  type TrailerRow,
} from "../domain/dispatch/mapper.js";
import type {
  BreakPoint,
  BusyInterval,
  Conflict,
  DriverInput,
  GeoPoint,
  LoadInput,
  StopInput,
  TractorInput,
  TrailerInput,
} from "../domain/dispatch/types.js";
import { emptyMilesSaved, rankOrgDrivers } from "../lib/rankDrivers.js";
import { coverageFor, type BreakPlanEntry } from "../lib/restCoverage.js";
import { rateConfigForDriver } from "../lib/rateConfig.js";
import { buildFuelPlan, type FuelPlanBody } from "../lib/fuelPlan.js";
import { buildRoadMilesFn, type LatLng } from "../lib/routing.js";
import { truckProfileFor } from "../lib/truckProfile.js";
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js";
import { guardLane } from "../lib/laneId.js";
import { guardLoad } from "../lib/loadGuard.js";
import {
  acceptTender,
  declineTender,
  restoreHos,
  restoredClocks,
  TENDER_ACCEPT_GONE,
  TENDER_DECLINE_GONE,
  unassign,
  UNASSIGN_GONE,
} from "../lib/assignmentActions.js";
import { CommitConflict, respondToWriteConflict } from "../lib/writeConflict.js";
import { applyStatusChange } from "../lib/loadWriter.js";
import { actorOf } from "../lib/actor.js";
import { emitLoadChanged } from "../lib/loadEvents.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The assignment engine commit (Control Tower §4F). A dispatcher drops a load
// onto a driver+equipment; the server re-runs feasibility itself (never trusts
// the client), and only writes the Assignment + Rate snapshot when there are no
// hard conflicts (or `force` is set). Mounted under dispatcherRouter — auth +
// role already enforced.
export const dispatcherAssignmentsRouter = Router();


const createAssignmentSchema = z.object({
  loadId: z.string().min(1),
  driverId: z.string().min(1),
  tractorId: z.string().min(1),
  trailerId: z.string().min(1),
  /** epoch-ms or ISO time the driver can begin; defaults to now */
  availableAt: z.union([z.string().datetime(), z.number()]).optional(),
  /** commit despite hard conflicts (dispatcher override) */
  force: z.boolean().optional(),
  /** evaluate + price only; never write (powers the drop-preview modal) */
  dryRun: z.boolean().optional(),
  /** offer to the driver rather than assigning outright; capacity is still
   *  held (HOS is decremented) because a tender the driver is considering
   *  must not be double-booked */
  tender: z.boolean().optional(),
});

/** Committed windows that already occupy a driver/tractor/trailer.
 *
 *  `excludeAssignmentId` is what makes a REPLAN possible: the assignment being
 *  moved is still active, so without excluding it every leg overlaps itself,
 *  every move is refused, and the board can never be dragged at all. A commit
 *  passes nothing (there is no row yet to exclude). */
async function busyFor(
  field: "driverId" | "tractorId" | "trailerId",
  id: string,
  excludeAssignmentId?: string,
): Promise<BusyInterval[]> {
  const rows = await prisma.assignment.findMany({
    where: {
      [field]: id,
      status: { in: [...ACTIVE_STATUSES] },
      ...(excludeAssignmentId ? { NOT: { id: excludeAssignmentId } } : {}),
    },
    select: { plannedStart: true, plannedEnd: true },
  });
  return rows.map((r) => ({ start: r.plannedStart.getTime(), end: r.plannedEnd.getTime() }));
}

/** The four engine inputs, or the first mapping failure's message. Shared by
 *  the commit and the replan so both refuse an ungeocoded stop / positionless
 *  driver the same way, with the same 422 message. */
type MappedInputs = {
  load: LoadInput;
  driver: { input: DriverInput; hosKnown: boolean };
  tractor: TractorInput;
  trailer: TrailerInput;
};

function mapDispatchInputs(
  load: LoadRow,
  driver: DriverRow,
  tractor: TractorRow,
  trailer: TrailerRow,
  availableAt: number,
): { ok: true; inputs: MappedInputs } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      inputs: {
        load: toLoadInput(load),
        driver: toDriverInput(driver, { availableAt }),
        tractor: toTractorInput(tractor),
        trailer: toTrailerInput(trailer),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unmappable dispatch inputs" };
  }
}

/** computeEconomics throws when the resolved cost model is unusable
 *  (currently only mpg <= 0 — a carrier's cost model with mpg left/set at 0
 *  passes resolveRateConfig faithfully, since 0 is a value `??` treats as
 *  set, and only fails once the domain tries to divide by it). This product's
 *  rule is that an unusable input is refused with a stated reason, never a
 *  bare 500 — and here it is worse than a bare 500: these are async (req,
 *  res) handlers, which Express 4 never awaits, so an uncaught throw becomes
 *  a rejected promise the router can't turn into a response at all (see
 *  src/lib/processGuards.ts) — the caller gets no reply, not even a 500.
 *  Same try/catch-into-a-result shape as mapDispatchInputs above, so both
 *  commit and replan can turn this into a clear 422 at the boundary instead. */
function priceOrRefuse(
  input: { revenueCents: number; deadheadMi: number; loadedMi: number },
  rateCfg: RateConfig,
): { ok: true; econ: RateBreakdown } | { ok: false; error: string } {
  try {
    return { ok: true, econ: computeEconomics(input, rateCfg) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unusable cost model";
    return {
      ok: false,
      error: `Cannot price this load: ${detail}. Fix the assigned carrier's (or the org's) cost model before committing.`,
    };
  }
}

/** Real road miles for the exact legs this plan drives (provider + cache;
 *  constant-null without ROUTER_URL, i.e. haversine as before). Commit and
 *  replan both persist their economics, so both get real distances; suggest
 *  ranking stays on the fast estimate — it's comparative. */
async function roadMilesForPlan(
  from: GeoPoint,
  stops: StopInput[],
  vehicle?: { trailerType?: string | null; loadWeightLbs?: number | null; hazmatClass?: string | null },
) {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const legPairs: [LatLng, LatLng][] = [[from, ordered[0].location]];
  for (let i = 0; i < ordered.length - 1; i++) legPairs.push([ordered[i].location, ordered[i + 1].location]);
  // Routed for the TRUCK, not a car: Mapbox applies max_height/width/weight, so
  // the miles a plan is costed on are the miles this combination can legally
  // drive. Without a vehicle we fall back to car geometry rather than guessing
  // dimensions we were not given.
  return buildRoadMilesFn(legPairs, vehicle ? truckProfileFor(vehicle) : null);
}

/** The destination of the leg a break falls on — stops[0] for the deadhead
 *  leg (legIndex -1), else the stop the leg departing stops[i] arrives at.
 *  Mirrors evaluate()'s own leg walk exactly (Global Constraint 2: one
 *  definition, not a second one) so a break's coverage query ranks detours
 *  against the same destination the engine used to position it. */
function legEndFor(stops: StopInput[], legIndex: number): GeoPoint {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  return legIndex === -1 ? ordered[0].location : ordered[legIndex + 1].location;
}

/** Attach rest coverage + ranked options to every break point in a plan, and
 *  collect any `no_rest` conflicts alongside (Task 7).
 *
 *  RULING 6: when the driver's HOS was never imported, mapDispatchInputs fed
 *  the engine an ASSUMED minutesSinceBreak (already flagged by the `hos` warn
 *  above this call) — every break point it produced is therefore derived from
 *  a number nobody actually supplied. The break plan is unknowable, not
 *  empty: `breakPlanKnown: false` says so, `breakPlan: []` alone would not
 *  (an empty array is itself the positive claim "no break needed"), and no
 *  `no_rest` conflict is raised at any severity — an unknowable plan cannot
 *  also ground a refusal. */
async function buildBreakPlan(
  orgId: string,
  breaks: BreakPoint[],
  stops: StopInput[],
  hosKnown: boolean,
): Promise<{ breakPlan: BreakPlanEntry[]; breakPlanKnown: boolean; noRestConflicts: Conflict[] }> {
  if (!hosKnown) return { breakPlan: [], breakPlanKnown: false, noRestConflicts: [] };

  const noRestConflicts: Conflict[] = [];
  const breakPlan = await Promise.all(
    breaks.map(async (bp): Promise<BreakPlanEntry> => {
      const coverage = await coverageFor(orgId, bp, legEndFor(stops, bp.legIndex));
      const conflict = restConflict(bp, coverage);
      if (conflict) noRestConflicts.push(conflict);
      return {
        atMs: bp.atMs,
        at: bp.at,
        precision: bp.precision,
        options: coverage.options,
        hasCoverage: coverage.hasData,
      };
    }),
  );

  return { breakPlan, breakPlanKnown: true, noRestConflicts };
}

dispatcherAssignmentsRouter.post(
  "/assignments",
  validateBody(createAssignmentSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof createAssignmentSchema>;

    const load = await prisma.load.findUnique({
      where: { id: body.loadId },
      include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } },
    });
    // Cross-tenant ids read as "not found" — never reveal another org's data.
    if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: "Load not found" });

    // The driver's tenancy is resolved BEFORE the lane guard runs, not after.
    // guardLane() consults lib/locks.ts's table, which is keyed by laneId
    // alone — globally, by design (see that file's header) — so guarding a
    // lane named by the RAW request body turned the guard into a cross-tenant
    // oracle: a dispatcher needing nothing but one open load of her own could
    // name any other org's driver id and read back 409-with-holder when that
    // lane was held and 404 when it was not, leaking the holder's name,
    // dispatcher UUID, org UUID and lock timestamps. `dryRun` made it a pure
    // read that writes nothing, and no rate limit applies. A driver id from
    // outside the caller's tenant must therefore be refused before the lock
    // table is consulted at all.
    //
    // 404, never 403: a 403 confirms the driver exists, which is the same
    // enumeration by another route. outsideCallerOrg() is the identical
    // nullable-org rule dispatcherLocks.ts's resolveLaneOrNotFound() applies
    // to the very same lane id, so both entry points to a lane agree on who
    // may name it — and it preserves middleware/orgScope.ts's documented
    // bypass, since an unscoped (legacy/dev) dispatcher has req.orgScope ==
    // null and is not narrowed here.
    const driver = await prisma.driver.findUnique({
      where: { id: body.driverId },
      include: { hos: true },
    });
    if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });

    if (!guardLane(req, res, body.driverId)) return;
    if (!(await guardLoad(req, res, body.loadId))) return;

    if (load.status !== "open") return res.status(409).json({ error: `Load is already ${load.status}` });

    const existing = await prisma.assignment.findUnique({ where: { loadId: body.loadId } });
    if (existing) return res.status(409).json({ error: "Load is already assigned" });

    const [tractor, trailer] = await Promise.all([
      prisma.tractor.findUnique({ where: { id: body.tractorId } }),
      prisma.trailer.findUnique({ where: { id: body.trailerId } }),
    ]);
    // Tenant integrity: the driver and equipment must belong to the LOAD's
    // org — a valid dispatcher token must never commit another tenant's
    // resources (or decrement their driver's HOS clocks). The driver re-check
    // is not redundant with the caller-org check above: for an UNSCOPED
    // dispatcher that check passes for every org, and this is what still
    // stops her pairing org A's load with org B's driver.
    if (driver.orgId !== load.orgId) return res.status(404).json({ error: "Driver not found" });
    if (!tractor || tractor.orgId !== load.orgId) return res.status(404).json({ error: "Tractor not found" });
    if (!trailer || trailer.orgId !== load.orgId) return res.status(404).json({ error: "Trailer not found" });

    const availableAt =
      body.availableAt == null
        ? Date.now()
        : typeof body.availableAt === "number"
          ? body.availableAt
          : new Date(body.availableAt).getTime();

    const mapped = mapDispatchInputs(load, driver, tractor, trailer, availableAt);
    if (!mapped.ok) return res.status(422).json({ error: mapped.error });
    const { load: loadInput, driver: driverMap, tractor: tractorInput, trailer: trailerInput } = mapped.inputs;

    const [driverBusy, tractorBusy, trailerBusy] = await Promise.all([
      busyFor("driverId", body.driverId),
      busyFor("tractorId", body.tractorId),
      busyFor("trailerId", body.trailerId),
    ]);

    const roadMilesFn = await roadMilesForPlan(driverMap.input.location, loadInput.stops, {
      trailerType: trailerInput.type,
      loadWeightLbs: load.weightLbs,
      hazmatClass: loadInput.hazmatClass,
    });

    const result = evaluate(loadInput, driverMap.input, tractorInput, trailerInput, {
      driverBusy,
      tractorBusy,
      trailerBusy,
      roadMilesFn,
    });

    // Missing HOS import is a warn, not a silent optimistic pass.
    const conflicts: Conflict[] = [...result.conflicts];
    if (!driverMap.hosKnown) {
      conflicts.push({
        kind: "hos",
        severity: "warn",
        detail: "HOS not imported for this driver; feasibility assumes full hours",
      });
    }

    // Rest coverage for every break this plan needs (Task 7). Must run BEFORE
    // `blockers` is computed: a `no_rest` conflict pushed after that line
    // would be reported to the dispatcher but never actually enforced.
    const { breakPlan, breakPlanKnown, noRestConflicts } = await buildBreakPlan(
      load.orgId,
      result.plan.breaks,
      loadInput.stops,
      driverMap.hosKnown,
    );
    conflicts.push(...noRestConflicts);

    const blockers = conflicts.filter((c) => c.severity === "block");
    // Price with the COMMITTING DRIVER's cost model: their carrier's, falling
    // back field-by-field to the org's (rateConfigForDriver, T1 Task 3) — a
    // driver with no carrier still prices at the org's own model, unchanged
    // from before the carrier layer existed.
    const rateCfg = await rateConfigForDriver(body.driverId);
    const priced = priceOrRefuse(
      {
        revenueCents: loadInput.revenueCents ?? 0,
        deadheadMi: result.plan.deadheadMi,
        loadedMi: result.plan.loadedMi,
      },
      rateCfg,
    );
    // An unusable cost model (currently only mpg <= 0) is refused with a
    // stated reason at this boundary — never a bare 500, and never the
    // unanswered request an uncaught throw would produce here (see
    // priceOrRefuse's doc comment). Refused before dryRun/blockers so a
    // preview never returns economics it could not actually compute.
    if (!priced.ok) return res.status(422).json({ error: priced.error });
    const econ = priced.econ;

    // Fuel burn + buy-here advice + IFTA attribution (T4 Task 7). Priced with
    // the SAME rateCfg.mpg just resolved above (the committing driver's
    // carrier, not the org) — never a second mpg resolution. Fuel raises no
    // conflicts of its own; `fuel` sits alongside `conflicts`, never inside it.
    const fuel: FuelPlanBody = await buildFuelPlan(
      load.orgId, driverMap.input.location, result.plan, load.stops, rateCfg.mpg,
    );

    // Preview mode: full verdict + economics, no writes. The portal's drop
    // modal shows this before the dispatcher commits.
    if (body.dryRun) {
      return res.json({
        feasible: blockers.length === 0, conflicts, plan: result.plan, economics: econ, breakPlan, breakPlanKnown, fuel,
      });
    }

    if (blockers.length > 0 && !body.force) {
      return res.status(422).json({
        feasible: false, conflicts, plan: result.plan, economics: econ, breakPlan, breakPlanKnown, fuel,
      });
    }

    // Empty-miles-saved: how much deadhead this choice avoided vs. the median
    // feasible alternative. Purely informational — a failure here must never
    // block the commit. rankOrgDrivers now resolves each alternative's OWN
    // carrier rate internally (T1 Task 3b), so `rateCfg` above is NOT passed
    // in here — it stays scoped to pricing THIS commit's leg via
    // priceOrRefuse. emptyMilesSaved only reads feasible/hosKnown/deadheadMi
    // off the ranking, never marginCents or score, so per-driver pricing
    // inside the ranking does not change this number (verified, not assumed
    // — see tests/dispatcher-assignments.test.ts).
    let savedMi = 0;
    try {
      const ranking = await rankOrgDrivers(load.orgId, loadInput, tractorInput, trailerInput, availableAt);
      savedMi = emptyMilesSaved(ranking, body.driverId, result.plan.deadheadMi);
    } catch {
      savedMi = 0;
    }

    const actor = await actorOf(req);
    let loadVersion = 0;
    let assignment;
    try {
      assignment = await prisma.$transaction(async (tx) => {
      // Re-verify under Serializable isolation: the pre-checks above ran on a
      // snapshot a concurrent commit may have invalidated (double-booking the
      // driver or double-assigning the load).
      const dupe = await tx.assignment.findUnique({ where: { loadId: load.id } });
      if (dupe) throw new CommitConflict("Load is already assigned");
      const busyNow = await tx.assignment.findMany({
        where: { driverId: body.driverId, status: { in: [...ACTIVE_STATUSES] } },
        select: { plannedStart: true, plannedEnd: true },
      });
      const overlapsNow = busyNow.some(
        (b) => result.plan.proposedStart < b.plannedEnd.getTime() && b.plannedStart.getTime() < result.plan.proposedEnd,
      );
      // This fires for a genuine race AND for an overlap the dispatcher could
      // already see and chose to force. An overlap is physics, not judgement:
      // one driver cannot run two loads at once, so `force` deliberately does
      // NOT override it. Blaming a "concurrent dispatch" for the deterministic
      // case sends the dispatcher hunting a colleague who does not exist —
      // say which it was. (Mirrors the same fix in PATCH /plan.)
      if (overlapsNow)
        throw new CommitConflict(
          blockers.some((c) => c.kind === "overlap")
            ? "Driver is already committed to an overlapping trip — an overlap cannot be forced"
            : "Driver was committed to an overlapping trip by a concurrent dispatch",
        );
      // Fresh in-tx clock read: both the decrement below and the exact-restore
      // snapshot come from this value, never the stale pre-check read.
      const hosNow = await tx.hosState.findUnique({ where: { driverId: body.driverId } });

      // A tender offers the load to the driver rather than assigning it
      // outright, but the truck is not free while the offer is outstanding —
      // ACTIVE_STATUSES already treats "tendered" as busy, so this alone is
      // what makes the overlap/yard/busy queries hold the driver's capacity.
      const status = body.tender ? "tendered" : "assigned";

      const created = await tx.assignment.create({
        data: {
          orgId: load.orgId,
          loadId: load.id,
          driverId: body.driverId,
          tractorId: body.tractorId,
          trailerId: body.trailerId,
          plannedStart: new Date(result.plan.proposedStart),
          plannedEnd: new Date(result.plan.proposedEnd),
          deadheadMi: result.plan.deadheadMi,
          loadedMi: result.plan.loadedMi,
          marginCents: econ.marginCents,
          savedMi,
          driveMin: Math.round(result.plan.driveMin),
          onDutyMin: Math.round(result.plan.onDutyMin),
          tookBreak: result.plan.needsBreak,
          hosDriveBefore: hosNow?.driveRemainingMin,
          hosWindowBefore: hosNow?.windowRemainingMin,
          hosCycleBefore: hosNow?.cycleRemainingMin,
          hosBreakBefore: hosNow?.minutesSinceBreak,
          status,
          tenderedAt: body.tender ? new Date() : null,
          assignedBy: req.auth?.dispatcherId,
        },
      });
      await tx.rate.create({
        data: {
          loadId: load.id,
          linehaulCents: load.revenueCents,
          fscCents: load.fscCents,
          totalMi: econ.totalMi,
          loadedMi: econ.loadedMi,
          deadheadMi: econ.deadheadMi,
          ratePerLoadedMiCents: econ.ratePerLoadedMiCents,
          estCostCents: econ.estCostCents,
          marginCents: econ.marginCents,
        },
      });
      // F6/plan A3: the load's status now moves through the one writer, same
      // as every other Load write — one LoadChange row, one version tick. A
      // board still holding the pre-assignment version must be refused, not
      // silently allowed to write over the status this commit just set.
      loadVersion = (await applyStatusChange(tx, {
        loadId: load.id, orgId: load.orgId, actor, source: "loadboard", status,
        note: `assignment ${created.id} → ${status}`,
      })).version;
      // Persist any surviving conflicts (the warns, or blocks when forced) for the alerts feed.
      if (conflicts.length > 0) {
        await tx.dispatchConflict.createMany({
          data: conflicts.map((c) => ({
            orgId: load.orgId,
            loadId: load.id,
            driverId: body.driverId,
            kind: c.kind,
            severity: c.severity,
            detail: c.detail,
          })),
        });
      }
      // The empty-repositioning leg — the raw material for the empty-miles-saved
      // ROI metric. Cost = the deadhead's share of the estimated total cost.
      const firstStop = load.stops[0];
      if (result.plan.deadheadMi > 0 && driver.lastLat != null && driver.lastLng != null && firstStop?.lat != null && firstStop?.lng != null) {
        await tx.deadheadLeg.create({
          data: {
            assignmentId: created.id,
            fromLat: driver.lastLat,
            fromLng: driver.lastLng,
            toLat: firstStop.lat,
            toLng: firstStop.lng,
            miles: result.plan.deadheadMi,
            costCents: econ.totalMi > 0 ? Math.round(econ.estCostCents * (result.plan.deadheadMi / econ.totalMi)) : 0,
          },
        });
      }
      // Provisionally consume the driver's HOS clocks for the committed plan.
      // Simplification: the 30-min break (when triggered) resets the 8h
      // cumulative-driving counter; real ELD imports overwrite this state.
      if (hosNow) {
        await tx.hosState.update({
          where: { driverId: body.driverId },
          data: {
            driveRemainingMin: Math.max(0, hosNow.driveRemainingMin - Math.round(result.plan.driveMin)),
            windowRemainingMin: Math.max(0, hosNow.windowRemainingMin - Math.round(result.plan.onDutyMin)),
            cycleRemainingMin: Math.max(0, hosNow.cycleRemainingMin - Math.round(result.plan.onDutyMin)),
            minutesSinceBreak: result.plan.needsBreak
              ? 0
              : hosNow.minutesSinceBreak + Math.round(result.plan.driveMin),
            updatedAt: new Date(),
          },
        });
      }
      return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      // The vanished row here is the LOAD (tx.load.update) or the driver's
      // HosState — there is no Assignment yet for a concurrent decline to
      // delete, which is why this message differs from the replan's.
      if (respondToWriteConflict(res, err, "The load or driver this commit depends on was removed — refresh the board")) return;
      // F5: an unrecognised error must never leave this handler silent —
      // Express 4 does not await async handlers, so an uncaught throw here
      // answers the commit with nothing at all, forever.
      console.error("POST /assignments failed", err);
      return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
    }

    emitToDriver(body.driverId, body.tender ? "trip_tender" : "trip_assignment", {
      loadId: load.id,
      assignmentId: assignment.id,
    });
    // F6: the version this commit moved to — the writer's own return value,
    // not a second read (spec §9).
    emitLoadChanged(load.orgId, { loadId: load.id, version: loadVersion, fields: ["status"] });

    res.status(201).json({
      assignment,
      plan: result.plan,
      economics: econ,
      conflicts,
      breakPlan,
      breakPlanKnown,
      fuel,
      forced: blockers.length > 0,
    });
  }),
);

// Lifecycle transitions: assigned -> in_progress (truck rolls) ->
// completed/delivered. Forward-only; completion does NOT restore HOS — those
// hours were genuinely driven. The load's status mirrors the assignment's
// (in_progress / delivered), and completing frees the driver automatically:
// every busy/overlap query filters on active statuses.
const statusSchema = z.object({ status: z.enum(["in_progress", "completed"]) });
/** The lifecycle transaction's "what vanished?" answer (lib/writeConflict.ts).
 *  Its own string rather than a shared one: an unassign or a tender decline
 *  can delete this Assignment while the dispatcher is pressing Start/Deliver,
 *  and on completion the Trailer being stamped can have been retired from the
 *  fleet — none of which is the tender-withdrawal event the other messages
 *  describe. */
const STATUS_GONE =
  "This assignment, its load, or its trailer was removed while the update was in flight — refresh the board; nothing was saved.";
const LIFECYCLE: Record<string, string[]> = {
  in_progress: ["assigned"],
  completed: ["assigned", "in_progress"],
};

dispatcherAssignmentsRouter.post(
  "/assignments/:id/status",
  validateBody(statusSchema),
  asyncRoute(async (req, res) => {
    const next = (req.body as z.infer<typeof statusSchema>).status;
    const assignment = await prisma.assignment.findUnique({
      where: { id: req.params.id as string },
      include: {
        load: {
          select: {
            orgId: true,
            // Only needed to locate the delivery stop for the trailer-position
            // stamp below (T2 Task 6); harmless on every other transition.
            stops: { orderBy: { sequence: "asc" }, select: { type: true, lat: true, lng: true } },
          },
        },
      },
    });
    if (!assignment || outsideOrg(req, assignment.load.orgId)) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    if (!guardLane(req, res, assignment.driverId)) return;
    if (!(await guardLoad(req, res, assignment.loadId))) return;

    if (!LIFECYCLE[next].includes(assignment.status)) {
      return res.status(409).json({ error: `cannot move a ${assignment.status} assignment to ${next}` });
    }

    const actor = await actorOf(req);
    const now = new Date();
    let loadVersion = 0;
    let updated: Assignment;
    try {
      updated = await prisma.$transaction(async (tx) => {
      const nextAssignment = await tx.assignment.update({
        where: { id: assignment.id },
        data: {
          status: next,
          ...(next === "in_progress" ? { startedAt: now } : {}),
          ...(next === "completed" ? { completedAt: now, ...(assignment.startedAt ? {} : { startedAt: now }) } : {}),
        },
      });
      // F6/plan A3: the load's status now moves through the one writer, same
      // as every other Load write.
      loadVersion = (await applyStatusChange(tx, {
        loadId: assignment.loadId, orgId: assignment.load.orgId, actor, source: "loadboard",
        status: next === "completed" ? "delivered" : "in_progress",
        note: `assignment ${assignment.id} → ${next}`,
      })).version;

      // Trailer position (T2 Task 6): on completion, stamp the trailer's
      // last-known position from the load's delivery stop (the same "delivery
      // stop" definition dispatcherLoadboard.ts uses: the last delivery-typed
      // stop, else the last stop by sequence), plus lastSeenAt. Purely
      // additive — never alters the assignment/load writes above, and never
      // touched for in_progress. A stop that was never geocoded writes
      // NOTHING: not 0,0, not the driver's position, not lastSeenAt alone —
      // absent must never be recorded as measured (a trailer pinned in the
      // Gulf of Guinea is the textbook version of that bug).
      if (next === "completed" && assignment.trailerId) {
        const stops = assignment.load.stops;
        const finalStop = [...stops].reverse().find((s) => s.type === "delivery") ?? stops[stops.length - 1];
        if (finalStop?.lat != null && finalStop?.lng != null) {
          await tx.trailer.update({
            where: { id: assignment.trailerId },
            data: { lastLat: finalStop.lat, lastLng: finalStop.lng, lastSeenAt: now },
          });
        }
      }

      return nextAssignment;
      });
    } catch (err) {
      // This route ran as a plain sequence of writes until it became an
      // interactive transaction (T2 Task 6, for the trailer-position stamp),
      // which newly exposed "truck rolls" and "load delivered" to the P2025 /
      // deadlock failure modes every other transaction here already maps. It
      // shipped with no try/catch at all, so an unmapped rejection sent NO
      // RESPONSE: the dispatcher watches a spinner on a completion they
      // believe they submitted, while the driver's phone has already been
      // told nothing.
      //
      // What can actually vanish differs from every other message in this
      // file: there is no tender to withdraw and no load to free. The rows
      // are the Assignment itself (unassigned or declined between the read
      // above and this transaction), its Load, and — only on completion —
      // the Trailer whose position is being stamped.
      if (respondToWriteConflict(res, err, STATUS_GONE)) return;
      // F5: same never-hang net as every other transaction in this file.
      console.error("POST /assignments/:id/status failed", err);
      return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
    }

    emitToDriver(assignment.driverId, next === "completed" ? "trip_completed" : "trip_started", {
      loadId: assignment.loadId, assignmentId: assignment.id,
    });
    // F6: the version this transition moved to — the writer's own return value.
    emitLoadChanged(assignment.load.orgId, { loadId: assignment.loadId, version: loadVersion, fields: ["status"] });
    res.json({ assignment: updated });
  }),
);

// restoredClocks / restoreHos / unassign now live in lib/assignmentActions.ts
// (Cockpit S2a Task 9): the driver's own tender accept/decline needs the
// EXACT same HOS-restore arithmetic and cancellation steps as the dispatcher
// routes below, and a route file must never import from another route file.
// Imported above; PATCH /assignments/:id/plan (further down) still calls
// restoredClocks/restoreHos directly for its same-driver-move restore.

/** An assignment that has not started rolling: the dispatcher may still take
 *  it off the driver entirely (DELETE below) or move it (PATCH .../plan
 *  further down). A rolling truck is not rescheduled and a completed one has
 *  nothing to move, so both handlers refuse everything outside this set.
 *
 *  ONE definition, not two spellings: "tendered" was added to each of them
 *  separately (Rulings 9 and 8's Task 8 follow-on) and a third status arriving
 *  later must not be able to land in one and be forgotten in the other. Should
 *  the two ever genuinely diverge — a status that may be moved but not
 *  cancelled, or the reverse — split them then, with the reason written down;
 *  today they are the same question asked twice. */
const PRE_ROLL_STATUSES: readonly string[] = ["assigned", "tendered"];

// Unassign: cancel a not-yet-started assignment, put the load back on the
// backlog, and give the driver their provisionally-consumed hours back.
// Widened to accept "tendered" alongside "assigned" (Cockpit S2a Task 7): a
// tender is an offer the driver hasn't even accepted yet, so it must be at
// LEAST as cancellable as a committed assignment, not less.
dispatcherAssignmentsRouter.delete("/assignments/:id", asyncRoute(async (req, res) => {
  const assignment = await prisma.assignment.findUnique({
    where: { id: req.params.id as string },
    include: { load: { select: { orgId: true } } },
  });
  if (!assignment || outsideOrg(req, assignment.load.orgId)) {
    return res.status(404).json({ error: "Assignment not found" });
  }

  if (!guardLane(req, res, assignment.driverId)) return;
  if (!(await guardLoad(req, res, assignment.loadId))) return;

  if (!PRE_ROLL_STATUSES.includes(assignment.status)) {
    return res.status(409).json({ error: `cannot unassign a ${assignment.status} assignment` });
  }

  const actor = await actorOf(req);
  let unassigned: { loadId: string; version: number };
  try {
    unassigned = await prisma.$transaction(
      (tx) => unassign(tx, assignment, actor),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    if (respondToWriteConflict(res, err, UNASSIGN_GONE)) return;
    // F5: same never-hang net as every other transaction in this file.
    console.error("DELETE /assignments/:id failed", err);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }

  emitToDriver(assignment.driverId, "trip_unassignment", { loadId: assignment.loadId });
  // A4 Task 1: the load moved back to "open" through the one writer inside
  // unassign() — a hole the blunt board_update above was the ONLY announcement
  // of until now.
  emitLoadChanged(assignment.load.orgId, { loadId: unassigned.loadId, version: unassigned.version, fields: ["status"] });

  res.json({ ok: true, loadId: assignment.loadId });
}));

// Tender response (Cockpit S2a Task 7): the dispatcher records the driver's
// answer to an outstanding tender (POST /assignments ... {tender:true}).
const declineSchema = z.object({ reason: z.string().max(500).optional() });

// Accept: relabel the offer as a committed assignment. The HOS was already
// decremented when the tender was created (ACTIVE_STATUSES treats "tendered"
// as busy) — accepting must NEVER touch the driver's clocks again, or the
// hours would be double-charged.
dispatcherAssignmentsRouter.post("/assignments/:id/tender/accept", asyncRoute(async (req, res) => {
  const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id as string } });
  if (!assignment || outsideOrg(req, assignment.orgId)) {
    return res.status(404).json({ error: "Assignment not found" });
  }

  if (!guardLane(req, res, assignment.driverId)) return;
  if (!(await guardLoad(req, res, assignment.loadId))) return;

  if (assignment.status !== "tendered") {
    return res.status(409).json({ error: `cannot accept a ${assignment.status} assignment` });
  }

  const actor = await actorOf(req);
  let updated;
  try {
    updated = await acceptTender(assignment, actor);
  } catch (err) {
    if (respondToWriteConflict(res, err, TENDER_ACCEPT_GONE)) return;
    // F5: same never-hang net as every other transaction in this file.
    console.error("POST /assignments/:id/tender/accept failed", err);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }

  res.json({ assignment: updated });
}));

// Decline: the offer is withdrawn entirely — same cancellation as an
// unassign (restore HOS, free the load, delete the row), plus an audit
// DispatchConflict for the alerts feed so dispatchers see why the load came
// back to the board.
dispatcherAssignmentsRouter.post(
  "/assignments/:id/tender/decline",
  validateBody(declineSchema),
  asyncRoute(async (req, res) => {
    const { reason } = req.body as z.infer<typeof declineSchema>;
    const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id as string } });
    if (!assignment || outsideOrg(req, assignment.orgId)) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    if (!guardLane(req, res, assignment.driverId)) return;
    if (!(await guardLoad(req, res, assignment.loadId))) return;

    if (assignment.status !== "tendered") {
      return res.status(409).json({ error: `cannot decline a ${assignment.status} assignment` });
    }

    try {
      await declineTender(assignment, reason);
    } catch (err) {
      if (respondToWriteConflict(res, err, TENDER_DECLINE_GONE)) return;
      // F5: same never-hang net as every other transaction in this file —
      // found in the audit this fix wave required, not one of the five named
      // catches, but the identical shape.
      console.error("POST /assignments/:id/tender/decline failed", err);
      return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
    }

    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------------
// Replan (Cockpit S2a Task 8): PATCH /assignments/:id/plan
//
// The one endpoint every board gesture lands in. Dragging a leg to a new time,
// dropping it on another driver's row, and pulling its right edge are the same
// operation seen from three angles: UNASSIGN-AND-REASSIGN, in one Serializable
// transaction. Give the old plan's hours back, re-run the engine against the
// new driver/equipment/time, re-snapshot the clocks, rewrite the money.
//
// It answers with the COMMIT's response shape on purpose, so the portal has one
// verdict renderer for a drop and a move alike.
// ---------------------------------------------------------------------------

const planSchema = z.object({
  driverId: z.string().min(1).optional(),
  tractorId: z.string().min(1).optional(),
  trailerId: z.string().min(1).optional(),
  /** epoch-ms or ISO time the leg should now start; defaults to where it is */
  availableAt: z.union([z.string().datetime(), z.number()]).optional(),
  /** right-edge resize: hold the leg open past the engine's proposed end */
  plannedEnd: z.union([z.string().datetime(), z.number()]).optional(),
  /** replan despite hard conflicts (dispatcher override) */
  force: z.boolean().optional(),
  /** evaluate + price only; never write (powers the drag preview) */
  dryRun: z.boolean().optional(),
});

/** A resize may extend a leg freely but may not shrink it more than a quarter
 *  hour below what the engine says the drive actually takes — that would be
 *  planning a trip that cannot physically happen. The boundary is INCLUSIVE:
 *  exactly `proposedEnd - 15min` is a legal (if optimistic) plan. */
const RESIZE_SLACK_MS = 15 * 60_000;

const toEpochMs = (v: string | number): number => (typeof v === "number" ? v : new Date(v).getTime());

dispatcherAssignmentsRouter.patch(
  "/assignments/:id/plan",
  validateBody(planSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof planSchema>;

    const assignment = await prisma.assignment.findUnique({
      where: { id: req.params.id as string },
      include: {
        load: { include: { stops: { include: { appointment: true }, orderBy: { sequence: "asc" } } } },
      },
    });
    // Cross-tenant ids read as "not found" — never a 403, which would confirm
    // the row exists and is the same enumeration by another route.
    if (!assignment || outsideOrg(req, assignment.orgId)) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    // Both ends of a move are mutated, so both lanes are guarded. The SOURCE
    // lane first: dragging a leg OFF a lane another dispatcher is working is
    // exactly the collision the lock exists to prevent, and the assignment is
    // already proven to be inside the caller's tenant, so asking about its own
    // driver's lane leaks nothing. The TARGET lane is guarded below, only once
    // that driver's tenancy has been established.
    if (!guardLane(req, res, assignment.driverId)) return;
    if (!(await guardLoad(req, res, assignment.loadId))) return;

    if (!PRE_ROLL_STATUSES.includes(assignment.status)) {
      return res.status(409).json({ error: `cannot replan a ${assignment.status} assignment` });
    }

    const targetDriverId = body.driverId ?? assignment.driverId;
    const targetTractorId = body.tractorId ?? assignment.tractorId;
    const targetTrailerId = body.trailerId ?? assignment.trailerId;
    if (!targetTractorId || !targetTrailerId) {
      return res.status(422).json({ error: "assignment has no tractor/trailer to replan" });
    }

    // Same order as POST /assignments, for the same reason: the target driver's
    // tenancy is resolved BEFORE the lane guard is consulted, so a foreign
    // driver id can never be used to read back who holds that lane (see the
    // long note on the commit handler).
    const driver = await prisma.driver.findUnique({ where: { id: targetDriverId }, include: { hos: true } });
    if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });

    if (targetDriverId !== assignment.driverId && !guardLane(req, res, targetDriverId)) return;
    if (!(await guardLoad(req, res, assignment.loadId))) return;

    const [tractor, trailer] = await Promise.all([
      prisma.tractor.findUnique({ where: { id: targetTractorId } }),
      prisma.trailer.findUnique({ where: { id: targetTrailerId } }),
    ]);
    // Tenant integrity: a replan must never pull another org's driver or
    // equipment onto this load (or decrement their driver's clocks). Not
    // redundant with the caller-org check above — for an UNSCOPED dispatcher
    // that check passes for every org, and this is what still stops her.
    if (driver.orgId !== assignment.orgId) return res.status(404).json({ error: "Driver not found" });
    if (!tractor || tractor.orgId !== assignment.orgId) return res.status(404).json({ error: "Tractor not found" });
    if (!trailer || trailer.orgId !== assignment.orgId) return res.status(404).json({ error: "Trailer not found" });

    const availableAt = body.availableAt == null ? assignment.plannedStart.getTime() : toEpochMs(body.availableAt);

    // HAZARD: the driver's live clocks already have THIS leg charged against
    // them. Evaluating a same-driver move against them would judge the move by
    // hours the move itself is about to hand back — and, worse, the decrement
    // below would then charge the leg a second time. Feed the engine the
    // restored clocks; the transaction performs the matching DB restore. A
    // DIFFERENT target driver is untouched by this assignment, so their clocks
    // are read as they stand.
    const sameDriver = targetDriverId === assignment.driverId;
    const hosForEval: HosRow | null =
      driver.hos && sameDriver ? restoredClocks(driver.hos, assignment) : driver.hos;
    const driverRow: DriverRow = {
      status: driver.status,
      hazmatEndorsed: driver.hazmatEndorsed,
      lastLat: driver.lastLat,
      lastLng: driver.lastLng,
      hos: hosForEval,
      medicalCertExpiresAt: driver.medicalCertExpiresAt,
    };

    const mapped = mapDispatchInputs(assignment.load, driverRow, tractor, trailer, availableAt);
    if (!mapped.ok) return res.status(422).json({ error: mapped.error });
    const { load: loadInput, driver: driverMap, tractor: tractorInput, trailer: trailerInput } = mapped.inputs;

    // HAZARD: exclude the assignment being replanned from its own busy
    // intervals. Without this every leg overlaps itself, no move is ever
    // feasible, and the board cannot be dragged at all.
    const [driverBusy, tractorBusy, trailerBusy] = await Promise.all([
      busyFor("driverId", targetDriverId, assignment.id),
      busyFor("tractorId", targetTractorId, assignment.id),
      busyFor("trailerId", targetTrailerId, assignment.id),
    ]);

    const roadMilesFn = await roadMilesForPlan(driverMap.input.location, loadInput.stops, {
      trailerType: trailerInput.type,
      loadWeightLbs: assignment.load.weightLbs,
      hazmatClass: loadInput.hazmatClass,
    });

    const result = evaluate(loadInput, driverMap.input, tractorInput, trailerInput, {
      driverBusy,
      tractorBusy,
      trailerBusy,
      roadMilesFn,
    });

    // Missing HOS import is a warn, not a silent optimistic pass.
    const conflicts: Conflict[] = [...result.conflicts];
    if (!driverMap.hosKnown) {
      conflicts.push({
        kind: "hos",
        severity: "warn",
        detail: "HOS not imported for this driver; feasibility assumes full hours",
      });
    }

    // Rest coverage for every break this plan needs (Task 7). Must run BEFORE
    // `blockers` is computed below: a `no_rest` conflict pushed after that
    // line would be reported to the dispatcher but never actually enforced.
    const { breakPlan, breakPlanKnown, noRestConflicts } = await buildBreakPlan(
      assignment.orgId,
      result.plan.breaks,
      loadInput.stops,
      driverMap.hosKnown,
    );
    conflicts.push(...noRestConflicts);

    // Price with the TARGET driver's cost model, same resolution as the
    // commit path: a replan onto a driver of a different carrier must re-price
    // at THAT carrier's model, not the leg's previous driver's.
    const rateCfg = await rateConfigForDriver(targetDriverId);
    const priced = priceOrRefuse(
      {
        revenueCents: loadInput.revenueCents ?? 0,
        deadheadMi: result.plan.deadheadMi,
        loadedMi: result.plan.loadedMi,
      },
      rateCfg,
    );
    // Same refusal-not-500 rule as the commit path — see priceOrRefuse.
    if (!priced.ok) return res.status(422).json({ error: priced.error });
    const econ = priced.econ;

    // Fuel burn + buy-here advice + IFTA attribution (T4 Task 7), priced at
    // the TARGET driver's carrier — same rateCfg.mpg just resolved above for
    // econ, never a second mpg resolution. Same "no conflicts of its own"
    // rule as the commit path: `fuel` sits alongside `conflicts`, not in it.
    const fuel: FuelPlanBody = await buildFuelPlan(
      assignment.orgId, driverMap.input.location, result.plan, assignment.load.stops, rateCfg.mpg,
    );

    const effectiveEnd = body.plannedEnd == null ? result.plan.proposedEnd : toEpochMs(body.plannedEnd);
    if (effectiveEnd < result.plan.proposedEnd - RESIZE_SLACK_MS) {
      // The engine's plan travels with the refusal so the board can snap the
      // bar back to a legal width instead of just flashing an error.
      return res.status(422).json({
        error: "plan_too_short", feasible: false, conflicts, plan: result.plan, economics: econ,
        breakPlan, breakPlanKnown, fuel,
      });
    }

    // A right-edge EXTENSION holds the truck past what the engine planned, so
    // evaluate()'s own overlap check — which only ever saw proposedEnd — cannot
    // see a collision the extension itself creates. Re-check the real window
    // that is about to be written.
    if (effectiveEnd > result.plan.proposedEnd) {
      const lanes: readonly (readonly [BusyInterval[], string])[] = [
        [driverBusy, "Driver"],
        [tractorBusy, "Tractor"],
        [trailerBusy, "Trailer"],
      ];
      for (const [busy, label] of lanes) {
        const hits = busy.some((b) => result.plan.proposedStart < b.end && b.start < effectiveEnd);
        if (hits && !conflicts.some((c) => c.kind === "overlap" && c.detail.startsWith(label))) {
          conflicts.push({
            kind: "overlap",
            severity: "block",
            detail: `${label} already committed inside the extended window`,
          });
        }
      }
    }

    const blockers = conflicts.filter((c) => c.severity === "block");

    // Preview mode: full verdict + economics, no writes. The board's drag
    // ghost shows this live while the dispatcher is still holding the mouse.
    if (body.dryRun) {
      return res.json({
        feasible: blockers.length === 0, conflicts, plan: result.plan, economics: econ, breakPlan, breakPlanKnown, fuel,
      });
    }

    if (blockers.length > 0 && !body.force) {
      return res.status(422).json({
        feasible: false, conflicts, plan: result.plan, economics: econ, breakPlan, breakPlanKnown, fuel,
      });
    }

    // Empty-miles-saved is the product's headline ROI number ("EMPTY MI
    // AVOIDED"), so a move that changes the deadhead must change it too —
    // leaving the commit-time figure in place after dragging a leg onto a much
    // closer driver would render a confident number that is no longer true.
    // Recomputed exactly the way the commit does, inside a try/catch so a
    // ranking failure is never able to block the replan. This assignment is
    // excluded from the ranking's busy rows: the leg being moved must not make
    // its own current driver look occupied. `rateCfg` above is NOT passed in
    // here either, for the same reason as the commit path: rankOrgDrivers now
    // prices every alternative at its OWN carrier internally (T1 Task 3b).
    let savedMi = 0;
    try {
      const ranking = await rankOrgDrivers(
        assignment.orgId, loadInput, tractorInput, trailerInput, availableAt, assignment.id,
      );
      savedMi = emptyMilesSaved(ranking, targetDriverId, result.plan.deadheadMi);
    } catch {
      savedMi = 0;
    }

    const previousDriverId = assignment.driverId;
    // A tender that moves to a DIFFERENT driver is a new offer: the clock the
    // new driver is being timed against restarts, rather than inheriting how
    // long the previous driver sat on it. A same-driver replan is the same
    // offer at a new time, so its stamp stands.
    const reTender = assignment.status === "tendered" && targetDriverId !== previousDriverId;
    let updated: Assignment;
    try {
      updated = await prisma.$transaction(async (tx) => {
        // 1. Hand the OLD plan's hours back FIRST, through the one shared
        //    restore. On a same-driver move this is what stops the driver being
        //    charged twice for a single leg — the decrement in step 4 reads the
        //    clocks this leaves behind.
        await restoreHos(tx, assignment);

        // 2. Re-verify under Serializable isolation: the checks above ran on a
        //    snapshot a concurrent commit may have invalidated. Excludes this
        //    assignment (a leg never conflicts with itself) and uses the window
        //    actually being written, extension included.
        const busyNow = await tx.assignment.findMany({
          where: {
            driverId: targetDriverId,
            status: { in: [...ACTIVE_STATUSES] },
            NOT: { id: assignment.id },
          },
          select: { plannedStart: true, plannedEnd: true },
        });
        const overlapsNow = busyNow.some(
          (b) => result.plan.proposedStart < b.plannedEnd.getTime() && b.plannedStart.getTime() < effectiveEnd,
        );
        if (overlapsNow) {
          // The transaction guard refuses a double-booking even under `force`
          // — same stance as POST /assignments, and deliberately so: `force`
          // overrides the ADVISORY verdict, not the invariant that one driver
          // cannot be in two places at once. But then the message must be
          // honest about which of the two cases it is. If the pre-check
          // already reported an overlap block, nothing raced us: the
          // dispatcher asked for a collision they could see, and blaming a
          // phantom "concurrent dispatch" would send them hunting a colleague
          // who does not exist.
          throw new CommitConflict(
            blockers.some((c) => c.kind === "overlap")
              ? "Driver is already committed to an overlapping trip — an overlap cannot be forced"
              : "Driver was committed to an overlapping trip by a concurrent dispatch",
          );
        }

        // 3. Fresh in-tx clock read — post-restore for a same-driver move,
        //    untouched for a new driver. Both the new snapshot and the
        //    decrement come from this value, never a stale pre-check read.
        const hosNow = await tx.hosState.findUnique({ where: { driverId: targetDriverId } });

        const next = await tx.assignment.update({
          where: { id: assignment.id },
          data: {
            driverId: targetDriverId,
            tractorId: targetTractorId,
            trailerId: targetTrailerId,
            // NOTE: the engine's proposedStart/proposedEnd are FLOATS — drive
            // minutes are fractional, so proposedEnd carries a sub-millisecond
            // remainder that `new Date()` truncates toward zero. The persisted
            // plannedEnd is therefore up to 1 ms below plan.proposedEnd. This
            // is pre-existing (POST /assignments truncates identically), and
            // it is why tests compare against Math.trunc(plan.proposedEnd)
            // rather than the raw value.
            plannedStart: new Date(result.plan.proposedStart),
            plannedEnd: new Date(effectiveEnd),
            deadheadMi: result.plan.deadheadMi,
            loadedMi: result.plan.loadedMi,
            marginCents: econ.marginCents,
            savedMi,
            ...(reTender ? { tenderedAt: new Date() } : {}),
            driveMin: Math.round(result.plan.driveMin),
            onDutyMin: Math.round(result.plan.onDutyMin),
            tookBreak: result.plan.needsBreak,
            hosDriveBefore: hosNow?.driveRemainingMin ?? null,
            hosWindowBefore: hosNow?.windowRemainingMin ?? null,
            hosCycleBefore: hosNow?.cycleRemainingMin ?? null,
            hosBreakBefore: hosNow?.minutesSinceBreak ?? null,
          },
        });

        // 4. Charge the (possibly new) driver for the new plan — the same
        //    arithmetic the commit uses, so a replan back onto an identical
        //    plan is a perfect round trip.
        if (hosNow) {
          await tx.hosState.update({
            where: { driverId: targetDriverId },
            data: {
              driveRemainingMin: Math.max(0, hosNow.driveRemainingMin - Math.round(result.plan.driveMin)),
              windowRemainingMin: Math.max(0, hosNow.windowRemainingMin - Math.round(result.plan.onDutyMin)),
              cycleRemainingMin: Math.max(0, hosNow.cycleRemainingMin - Math.round(result.plan.onDutyMin)),
              minutesSinceBreak: result.plan.needsBreak
                ? 0
                : hosNow.minutesSinceBreak + Math.round(result.plan.driveMin),
              updatedAt: new Date(),
            },
          });
        }

        // 5. Rate and DeadheadLeg are snapshots OF THIS PLAN, so a new plan
        //    replaces them. DispatchConflict is APPEND-ONLY: the earlier
        //    commit's rows are audit history and are never deleted (the same
        //    stance DELETE /assignments/:id and tender decline take), but the
        //    replan's own conflicts must still be recorded — otherwise the
        //    alerts feed keeps rendering the ORIGINAL commit's verdict as if it
        //    described the plan that now exists, which is stale data wearing
        //    the costume of measured data.
        await tx.deadheadLeg.deleteMany({ where: { assignmentId: assignment.id } });
        await tx.rate.deleteMany({ where: { loadId: assignment.loadId } });
        await tx.rate.create({
          data: {
            loadId: assignment.loadId,
            linehaulCents: assignment.load.revenueCents,
            fscCents: assignment.load.fscCents,
            totalMi: econ.totalMi,
            loadedMi: econ.loadedMi,
            deadheadMi: econ.deadheadMi,
            ratePerLoadedMiCents: econ.ratePerLoadedMiCents,
            estCostCents: econ.estCostCents,
            marginCents: econ.marginCents,
          },
        });
        if (conflicts.length > 0) {
          await tx.dispatchConflict.createMany({
            data: conflicts.map((c) => ({
              orgId: assignment.orgId,
              loadId: assignment.loadId,
              driverId: targetDriverId,
              kind: c.kind,
              severity: c.severity,
              detail: c.detail,
            })),
          });
        }
        const firstStop = assignment.load.stops[0];
        if (
          result.plan.deadheadMi > 0 &&
          driver.lastLat != null &&
          driver.lastLng != null &&
          firstStop?.lat != null &&
          firstStop?.lng != null
        ) {
          await tx.deadheadLeg.create({
            data: {
              assignmentId: assignment.id,
              fromLat: driver.lastLat,
              fromLng: driver.lastLng,
              toLat: firstStop.lat,
              toLng: firstStop.lng,
              miles: result.plan.deadheadMi,
              costCents:
                econ.totalMi > 0 ? Math.round(econ.estCostCents * (result.plan.deadheadMi / econ.totalMi)) : 0,
            },
          });
        }
        return next;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      // P2025 is reachable here WITHOUT any exotic race: the driver's own
      // tender decline (routes/driver.ts) deletes this exact Assignment and
      // carries no lane lock — locks are a dispatcher-vs-dispatcher device —
      // so a dispatcher dragging a tendered leg while its driver taps Reject
      // lands squarely on it.
      if (respondToWriteConflict(res, err, "This assignment no longer exists — refresh the board")) return;
      // F5: same never-hang net as every other transaction in this file —
      // found in the audit this fix wave required, not one of the five named
      // catches, but the identical shape.
      console.error("PATCH /assignments/:id/plan failed", err);
      return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
    }

    emitToDispatchers(assignment.orgId, "board_update", {
      loadId: assignment.loadId,
      assignmentId: assignment.id,
      driverId: targetDriverId,
      replanned: true,
    });
    if (targetDriverId !== previousDriverId) {
      emitToDriver(previousDriverId, "trip_unassignment", { loadId: assignment.loadId });
      // An outstanding OFFER moves as an offer: a replan must never silently
      // turn a tender the driver has not answered into a committed assignment.
      emitToDriver(targetDriverId, assignment.status === "tendered" ? "trip_tender" : "trip_assignment", {
        loadId: assignment.loadId,
        assignmentId: assignment.id,
      });
    }

    res.json({
      assignment: updated,
      plan: result.plan,
      economics: econ,
      conflicts,
      breakPlan,
      breakPlanKnown,
      fuel,
      forced: blockers.length > 0,
    });
  }),
);
