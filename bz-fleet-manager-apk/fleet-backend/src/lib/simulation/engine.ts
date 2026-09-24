import type { SimDriverState } from "@prisma/client";
import { prisma } from "../../db.js";
import { emitToDispatchers } from "../../realtime.js";
import { emitLoadChanged } from "../loadEvents.js";
import { SYSTEM_ACTOR } from "../actor.js";
import { availabilityFor, lastGeocodedDeliveryStop } from "../driverAvailability.js";
import { transitionAssignment } from "../assignmentLifecycle.js";
import { clamp, positionAlong } from "./movement.js";
import type { GeoPoint } from "../../domain/dispatch/types.js";

// AI Dispatch Foundation, Task 8: a lightweight simulation that moves
// committed plans forward in time, so the Night Shift agent and every
// existing dispatcher view see the demo world exactly as if it were real.
//
// Two clocks, never confused:
//   - `simNowMs = wallNowMs + simMinutesAdvanced * 60_000` is a NOTIONAL
//     "what time is it in the fiction" value, used only to decide whether a
//     plan has crossed plannedStart/plannedEnd. Nothing about the process
//     clock changes, and no timestamp on an EXISTING row is ever rewritten.
//   - Assignment lifecycle timestamps (`startedAt`/`completedAt`) are
//     stamped in SIMULATED time (`simNowMs`), so a fast-forwarded arrival's
//     on-time/late outcome is judged against `Appointment.windowEnd` on the
//     same fictional timeline `plannedStart`/`plannedEnd` already live on —
//     stamping them at real wall-clock `now` instead would make a load that
//     "arrived" after `speed`-multiplied hours of simulated driving read as
//     on-time, because barely any real time had actually passed.
//   - Every `DriverLocation` ping is written with Prisma's own wall-clock
//     `createdAt` default (never overridden here), and `Driver.lastLocationAt`
//     is stamped from `wallNowMs` — pings are stamped in REAL time so the
//     Night Shift worker's staleness/freshness checks see them as live,
//     current pings, exactly what a phone would have sent, regardless of how
//     far the fictional clock has moved.
//
// One transaction per transition, not one shared transaction for the whole
// tick. Every `transitionAssignment` call
// below opens its OWN `prisma.$transaction`. A tick that touches several
// assignments must not let one bad one — a dispatcher-held `LoadLock`, a
// concurrent unassign racing a completion, a deadlock — take the rest down
// with it: a single shared transaction can't offer that, because a genuine
// SQL failure partway through poisons Postgres's side of it (25P02, "current
// transaction is aborted") for every statement after, catch-and-continue or
// not. One transaction per transition means a failure rolls back exactly
// that transition and nothing else; the tick's own bookkeeping (pings,
// `Driver.lastLat/lastLng`, the availability upserts, the `SimulationState`
// update) all run as separate, later writes that no transition failure can
// reach.
//
// availabilityFor() (lib/driverAvailability.ts, out of scope for this task)
// reads through the plain `prisma` client — called after every write below
// has already committed, so it always sees this tick's own final state, not
// a snapshot of a transition still in flight.

export type SimMode = "auto" | "stopped" | "dark" | "offroute" | "idle";

export interface TickResult {
  simNowMs: number;
  pings: number;
  started: number;
  completed: number;
  /** Assignments this tick tried to transition but whose OWN transaction
   *  failed — a dispatcher-held `LoadLock`, or a genuine concurrent-write
   *  failure (see `warnSkipped`'s doc comment). Counted, not thrown: one bad
   *  transition must never cost every other driver's progress for the tick. */
  skipped: number;
}

const SIM_ACTOR = SYSTEM_ACTOR("simulation");

/** Shared shape for both the "about to start" and "in progress" assignment
 *  queries — one definition of what a plan's stops look like, so the two
 *  queries can never quietly drift apart. */
const LOAD_STOPS_INCLUDE = {
  load: {
    select: {
      orgId: true,
      stops: {
        orderBy: { sequence: "asc" },
        select: { sequence: true, type: true, lat: true, lng: true, address: true },
      },
    },
  },
} as const;

interface PingEvent {
  driverId: string;
  driverName: string;
  latitude: number;
  longitude: number;
  at: string;
}

interface TransitionEvent {
  loadId: string;
  version: number;
}

/** Where an in-progress driver actually pings, given their simulated
 *  perturbation layered on the geometrically true `position` (null when the
 *  load has fewer than 2 geocoded stops — see movement.ts). `dark`/`idle`
 *  drivers never ping; `stopped` ignores `position` entirely and re-pings
 *  their last known spot — a real stationary truck keeps reporting in. */
function inProgressPing(
  mode: SimMode,
  position: GeoPoint | null,
  offset: { offsetLat: number; offsetLng: number },
  lastKnown: GeoPoint | null,
): GeoPoint | null {
  switch (mode) {
    case "auto":
      return position;
    case "stopped":
      return lastKnown ?? position;
    case "offroute":
      return position ? { lat: position.lat + offset.offsetLat, lng: position.lng + offset.offsetLng } : null;
    case "dark":
    case "idle":
      return null;
  }
}

/** Where the final ping lands when an assignment completes — always the
 *  delivery stop itself, whatever perturbation the simulation was layering
 *  on the way there. Only `dark`/`idle` still suppress it: those drivers
 *  were never reporting a position at all. */
function completionPing(mode: SimMode, deliveryPoint: GeoPoint): GeoPoint | null {
  return mode === "dark" || mode === "idle" ? null : deliveryPoint;
}

function toGeoPointOrNull(row: { lastLat: number | null; lastLng: number | null } | undefined): GeoPoint | null {
  return row?.lastLat != null && row?.lastLng != null ? { lat: row.lastLat, lng: row.lastLng } : null;
}

/** SimDriverState reads default to "auto" when a driver has never had one
 *  written (Task 7 only seeds rows for scenarios K/L/N) — a driver with no
 *  row is exactly the schema's own default. Expired `modeUntil` rows were
 *  already normalised to `auto` by the caller before this is used. */
function effectiveModeOf(
  simStateById: ReadonlyMap<string, SimDriverState>,
  driverId: string,
): { mode: SimMode; offsetLat: number; offsetLng: number } {
  const s = simStateById.get(driverId);
  if (!s) return { mode: "auto", offsetLat: 0, offsetLng: 0 };
  return { mode: s.mode as SimMode, offsetLat: s.offsetLat, offsetLng: s.offsetLng };
}

/** A single failed transition is reported and skipped, never thrown. Safe
 *  because `transitionAssignment` runs inside its OWN `prisma.$transaction`:
 *  whatever failed — a thrown `LoadLocked`, a P2025 because the
 *  assignment or load vanished between this tick's read and its write, a
 *  deadlock — Prisma has already rolled that ONE transaction back in full
 *  before the rejection reaches here. There is no shared transaction left for
 *  it to have poisoned, so moving on to the next assignment is always safe. */
function warnSkipped(action: "start" | "complete", loadId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`simulation tick: could not ${action} the assignment for load ${loadId} — ${message}`);
}

/** Step (b): assignments due to start this tick. One batched read, then one
 *  transition per row, EACH IN ITS OWN TRANSACTION — same as the dispatcher's
 *  own Start button, just called from the simulation's clock instead of a
 *  click. */
async function startDueAssignments(
  orgId: string,
  simNowMs: number,
): Promise<{ transitions: TransitionEvent[]; driverIds: string[]; skipped: number }> {
  const due = await prisma.assignment.findMany({
    where: { orgId, status: "assigned", plannedStart: { lte: new Date(simNowMs) } },
    include: LOAD_STOPS_INCLUDE,
  });

  const transitions: TransitionEvent[] = [];
  const driverIds: string[] = [];
  let skipped = 0;
  for (const a of due) {
    try {
      const { loadVersion } = await prisma.$transaction((tx) =>
        transitionAssignment(tx, a, "in_progress", { actor: SIM_ACTOR, source: "system", now: new Date(simNowMs) }),
      );
      transitions.push({ loadId: a.loadId, version: loadVersion });
      driverIds.push(a.driverId);
    } catch (err) {
      skipped++;
      warnSkipped("start", a.loadId, err);
    }
  }
  return { transitions, driverIds, skipped };
}

/** Steps (c)+(d): every currently in-progress assignment either moves along
 *  its plan (a ping, mode-permitting) or has already reached `plannedEnd`
 *  (transitions to completed, in its own transaction, with one final ping at
 *  the delivery stop). Queried fresh AFTER startDueAssignments's transitions
 *  have each committed, so an assignment that just started this tick is
 *  included here too. Ping writes (a `DriverLocation` row plus the driver's
 *  denormalised last-known position) are their own small transaction, same
 *  pairing `routes/driver.ts`'s own location handler uses — never inside a
 *  transition's transaction, so a skipped transition can never take a ping
 *  down with it. */
async function advanceInProgress(
  orgId: string,
  simNowMs: number,
  wallNowMs: number,
): Promise<{
  pings: PingEvent[];
  transitions: TransitionEvent[];
  completedDriverIds: string[];
  skipped: number;
}> {
  const inProgress = await prisma.assignment.findMany({
    where: { orgId, status: "in_progress" },
    include: LOAD_STOPS_INCLUDE,
  });

  const driverIds = [...new Set(inProgress.map((a) => a.driverId))];
  const [drivers, simStates] = driverIds.length > 0
    ? await Promise.all([
        prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true, lastLat: true, lastLng: true } }),
        prisma.simDriverState.findMany({ where: { driverId: { in: driverIds } } }),
      ])
    : [[], []];
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const simStateById = new Map(simStates.map((s) => [s.driverId, s]));

  // Expire modeUntil FIRST: a perturbation that has run its
  // course reads as "auto" for the rest of this tick, and the row itself is
  // reset so the next tick (and GET /sim/state) see it that way too. A plain
  // write, not a transition — nothing here calls transitionAssignment, so it
  // carries none of the per-transition failure risk this file guards against.
  const expiredIds = simStates
    .filter((s) => s.modeUntil != null && s.modeUntil.getTime() <= wallNowMs)
    .map((s) => s.driverId);
  if (expiredIds.length > 0) {
    await prisma.simDriverState.updateMany({
      where: { driverId: { in: expiredIds } },
      data: { mode: "auto", modeUntil: null, offsetLat: 0, offsetLng: 0 },
    });
    for (const id of expiredIds) {
      simStateById.set(id, { ...simStateById.get(id)!, mode: "auto", modeUntil: null, offsetLat: 0, offsetLng: 0 });
    }
  }

  const pings: PingEvent[] = [];
  const transitions: TransitionEvent[] = [];
  const completedDriverIds: string[] = [];
  let skipped = 0;

  for (const a of inProgress) {
    const effective = effectiveModeOf(simStateById, a.driverId);
    const willComplete = a.plannedEnd.getTime() <= simNowMs;
    let pingPoint: GeoPoint | null;

    if (willComplete) {
      const deliveryStop = lastGeocodedDeliveryStop(a.load.stops);
      let loadVersion: number;
      try {
        ({ loadVersion } = await prisma.$transaction((tx) =>
          transitionAssignment(tx, a, "completed", { actor: SIM_ACTOR, source: "system", now: new Date(simNowMs) }),
        ));
      } catch (err) {
        skipped++;
        warnSkipped("complete", a.loadId, err);
        continue; // no transition happened: no ping, no availability sync for this driver
      }
      transitions.push({ loadId: a.loadId, version: loadVersion });
      completedDriverIds.push(a.driverId);

      pingPoint = null;
      if (deliveryStop && deliveryStop.lat != null && deliveryStop.lng != null) {
        pingPoint = completionPing(effective.mode, { lat: deliveryStop.lat, lng: deliveryStop.lng });
      }
    } else {
      const startMs = a.plannedStart.getTime();
      const endMs = a.plannedEnd.getTime();
      const fraction = endMs === startMs ? 1 : clamp((simNowMs - startMs) / (endMs - startMs), 0, 1);
      const position = positionAlong(a.load.stops, fraction);
      pingPoint = inProgressPing(effective.mode, position, effective, toGeoPointOrNull(driverById.get(a.driverId)));
    }

    if (pingPoint) {
      const [loc] = await prisma.$transaction([
        prisma.driverLocation.create({
          data: { driverId: a.driverId, latitude: pingPoint.lat, longitude: pingPoint.lng },
        }),
        prisma.driver.update({
          where: { id: a.driverId },
          data: { lastLat: pingPoint.lat, lastLng: pingPoint.lng, lastLocationAt: new Date(wallNowMs) },
        }),
      ]);
      pings.push({
        driverId: a.driverId,
        driverName: driverById.get(a.driverId)?.name ?? "",
        latitude: pingPoint.lat,
        longitude: pingPoint.lng,
        at: loc.createdAt.toISOString(),
      });
    }
  }

  return { pings, transitions, completedDriverIds, skipped };
}

/** Step (e), run after every write above has committed (see the header
 *  comment on why availabilityFor can't run any earlier). Skips any row
 *  whose `source` is "manual" — only a dispatcher's own explicit override may
 *  win against the derived projection.
 *
 *  For every other row this writes ONLY `availabilityStatus` and
 *  `source: "simulation"` — never `availableAt/Lat/Lng/City/State`, which are
 *  always cleared to null instead. A driver reaching this function just
 *  STARTED or COMPLETED an assignment; either way, their live projection
 *  (`projectAvailability`, driven by their CURRENT assignment or last ping)
 *  already answers "where/when will they be free" correctly on the very next
 *  read. Storing a snapshot of that answer here — even just the completion
 *  city — would freeze it: the moment this driver is given a NEW assignment,
 *  the stale stored value would keep winning over the fresh projection
 *  forever, because a non-null column always wins field-by-field regardless
 *  of `source` (see driverAvailability.ts's own `toView`). Nulling these
 *  columns out is what keeps every future read honest without this function
 *  needing to know anything about what comes next for the driver. */
async function syncAvailability(
  orgId: string,
  driverIds: readonly string[],
  wallNowMs: number,
): Promise<void> {
  if (driverIds.length === 0) return;
  const views = await availabilityFor(orgId, [...driverIds], wallNowMs);
  for (const view of views) {
    if (view.source === "manual") continue;
    const fields = {
      availabilityStatus: view.status,
      availableAt: null,
      availableLat: null,
      availableLng: null,
      availableCity: null,
      availableState: null,
      source: "simulation",
    };
    await prisma.driverAvailability.upsert({
      where: { driverId: view.driverId },
      update: fields,
      create: { driverId: view.driverId, ...fields },
    });
  }
}

/**
 * Advances org `orgId`'s simulation by `minutes` simulated minutes. See the
 * header comment for the wall-clock/sim-clock split and the one-transaction-
 * per-transition rule. Step order: start due assignments, advance
 * in-progress ones, persist the clock advance, emit the tick's events, then
 * sync availability for every driver touched.
 */
export async function tick(orgId: string, minutes: number, wallNowMs: number = Date.now()): Promise<TickResult> {
  let state = await prisma.simulationState.findUnique({ where: { orgId } });
  if (!state) state = await prisma.simulationState.create({ data: { orgId } });
  const simNowMs = wallNowMs + (state.simMinutesAdvanced + minutes) * 60_000;

  const started = await startDueAssignments(orgId, simNowMs);
  const advanced = await advanceInProgress(orgId, simNowMs, wallNowMs);

  // The clock advance is deliberately its own write, after every transition
  // this tick attempted — a skipped transition must never cost the tick its
  // own progress.
  await prisma.simulationState.update({
    where: { orgId },
    data: { simMinutesAdvanced: state.simMinutesAdvanced + minutes, lastTickAt: new Date(wallNowMs) },
  });

  const transitions = [...started.transitions, ...advanced.transitions];
  for (const t of transitions) {
    emitLoadChanged(orgId, { loadId: t.loadId, version: t.version, fields: ["status"] });
  }
  for (const p of advanced.pings) {
    emitToDispatchers(orgId, "driver_location", {
      driverId: p.driverId, driverName: p.driverName, latitude: p.latitude, longitude: p.longitude, at: p.at,
    });
  }

  const touchedDriverIds = [...new Set([...started.driverIds, ...advanced.completedDriverIds])];
  await syncAvailability(orgId, touchedDriverIds, wallNowMs);

  return {
    simNowMs,
    pings: advanced.pings.length,
    started: started.driverIds.length,
    completed: advanced.completedDriverIds.length,
    skipped: started.skipped + advanced.skipped,
  };
}
