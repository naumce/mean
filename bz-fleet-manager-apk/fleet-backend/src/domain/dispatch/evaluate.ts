// The dispatch feasibility orchestrator (Control Tower §4A/4C).
// Projects a proposed timeline for (load, driver, tractor, trailer), then runs
// every independent rule + the HOS clock. Pure: deterministic given its inputs,
// no Date, no DB. Returns block/warn conflicts and the computed plan.

import {
  checkDriverAvailable,
  checkEquipment,
  checkHazmat,
  checkOverlap,
  checkTractorAvailable,
  checkTrailerAvailable,
} from "./checks.js";
import { interpolate } from "./breakGeo.js";
import { checkCompliance } from "./compliance.js";
import { driveMinutes, roadMiles } from "./distance.js";
import { BREAK_DURATION_MIN, BREAK_THRESHOLD_MIN, evaluateHos } from "./hos.js";
import type {
  BreakPoint,
  Conflict,
  DriverInput,
  EvalContext,
  EvalResult,
  LoadInput,
  PlanLeg,
  StopInput,
  TractorInput,
  TrailerInput,
} from "./types.js";

const MIN_MS = 60_000;
const QUARTER_HOUR_MS = 15 * MIN_MS;
const DEFAULT_DWELL_MIN = 60;

/** Round an instant to the nearest 15 minutes. */
export function snap15(ms: number): number {
  return Math.round(ms / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}

/** Snap UP to the 15-minute grid — used for proposedStart so the plan can
 *  never begin before the driver is actually available. */
export function snapCeil15(ms: number): number {
  return Math.ceil(ms / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}

/**
 * Wall-clock minutes for a leg of `legMin` driving that begins with
 * `sinceBreak` minutes already on the 8-hour clock: the driving plus every
 * 30-minute break the leg has to absorb along the way.
 *
 * Pure. `driveLeg()` inside evaluate() does the same arithmetic while also
 * recording where each break falls; this exists so the planned departure can
 * be computed from the SAME duration the walk will actually take. Before it,
 * the departure was planned from bare driving minutes, so any deadhead long
 * enough to need a break — 480 road miles and up — arrived at the pickup
 * exactly one break late, every time, for every driver.
 */
export function legWallMinutes(legMin: number, sinceBreak: number): number {
  let remaining = legMin;
  let since = sinceBreak;
  let breaks = 0;
  while (since + remaining > BREAK_THRESHOLD_MIN) {
    remaining -= Math.max(0, BREAK_THRESHOLD_MIN - since);
    since = 0;
    breaks += 1;
  }
  return legMin + breaks * BREAK_DURATION_MIN;
}

const dwellOf = (stop: StopInput): number =>
  stop.dwellMin ?? DEFAULT_DWELL_MIN;

const lateKind = (stop: StopInput): "late_pickup" | "late_delivery" =>
  stop.type === "delivery" ? "late_delivery" : "late_pickup";

function invalid(detail: string): EvalResult {
  return {
    feasible: false,
    conflicts: [{ kind: "invalid_load", severity: "block", detail }],
    plan: {
      proposedStart: 0,
      proposedEnd: 0,
      deadheadMi: 0,
      loadedMi: 0,
      legs: [],
      driveMin: 0,
      onDutyMin: 0,
      needsBreak: false,
      breaks: [],
    },
  };
}

/**
 * Evaluate one candidate assignment. `feasible` is true iff no block-severity
 * conflict is present; warns (tight arrivals, reefer sub-checks) never block.
 */
export function evaluate(
  load: LoadInput,
  driver: DriverInput,
  tractor: TractorInput,
  trailer: TrailerInput,
  context: EvalContext = {},
): EvalResult {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  if (stops.length < 2) return invalid("load needs at least a pickup and a delivery stop");
  if (!stops.some((s) => s.type === "pickup")) return invalid("load has no pickup stop");
  if (!stops.some((s) => s.type === "delivery")) return invalid("load has no delivery stop");

  const avgSpeed = context.avgSpeedMph ?? 50;
  const roadFactor = context.roadFactor ?? 1.2;
  const tightMin = context.tightArrivalMin ?? 30;
  // Real provider miles when the caller pre-resolved this pair, else estimate.
  const road = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number =>
    context.roadMilesFn?.(a, b) ?? roadMiles(a, b, roadFactor);

  const firstStop = stops[0];
  const deadheadMi = road(driver.location, firstStop.location);
  const deadheadDriveMin = driveMinutes(deadheadMi, avgSpeed);

  // Earliest legal start: don't reach the first pickup before its window
  // opens. Snapped UP so the plan can never begin before availableAt.
  // The deadhead's wall-clock length, breaks included — the walk below will
  // insert the same breaks, so planning the departure from bare driving
  // minutes made every long deadhead arrive one break late.
  const deadheadMs = legWallMinutes(deadheadDriveMin, driver.hos.minutesSinceBreak) * MIN_MS;
  const windowFloor = firstStop.windowStart != null ? firstStop.windowStart - deadheadMs : driver.availableAt;
  const rawStart = Math.max(driver.availableAt, windowFloor);
  const snappedStart = snapCeil15(rawStart);
  // An appointment typed on the broker board — "PU: 09/13 - 08:00" — is a
  // single instant: windowStart === windowEnd. Snapping the departure UP
  // then lands the arrival 1–15 minutes past that instant, and the block
  // reads "arrives stop 1 after its 4m-late deadline" for a driver fifteen
  // miles away. No plan could ever hit it, so no board-typed load could ever
  // be assigned. Found by running the flow end to end, not by any test.
  //
  // Arriving a few minutes early for an appointment is what a driver
  // actually does. So when the snap ALONE is what makes us late — the raw
  // start would have arrived in time — take the grid point before it, as
  // long as the driver is genuinely available by then. A real range window
  // wider than the grid never enters this branch: ceil-snapping keeps the
  // arrival inside [windowStart, windowStart + 15min), well before its end.
  const snapMadeUsLate =
    firstStop.windowEnd != null &&
    snappedStart + deadheadMs > firstStop.windowEnd &&
    rawStart + deadheadMs <= firstStop.windowEnd &&
    snappedStart - QUARTER_HOUR_MS >= driver.availableAt;
  const proposedStart = snapMadeUsLate ? snappedStart - QUARTER_HOUR_MS : snappedStart;

  // Walk the stops, accumulating loaded miles, drive/dwell time, and arrivals.
  // The 30-min break (when this trip crosses the 8h-cumulative threshold) is
  // inserted INTO the driving leg where it occurs, so every downstream arrival
  // check, proposedEnd, and the persisted busy window include it.
  const conflicts: Conflict[] = [];
  // Leg miles as they are computed (deadhead first, then each loaded leg in
  // route order) — a raw collection point, never a recomputation. Turned
  // into PlanLeg[] with milesRemaining in a second pass once the walk is done.
  const legMiles: { index: number; miles: number }[] = [{ index: -1, miles: deadheadMi }];
  let loadedMi = 0;
  let loadedDriveMin = 0;
  let dwellMin = 0;
  let waitMin = 0;
  let sinceBreakMin = driver.hos.minutesSinceBreak;
  let breaksTaken = 0;
  const breaks: BreakPoint[] = [];
  let driveMinSoFar = 0;
  // -1 = deadhead; 0..n = the leg departing stops[i]. Set immediately before
  // each driveLeg() call so a break records the leg it actually falls on.
  let legIndex = -1;
  let legPrecision: "routed" | "estimated" = "estimated";

  // A leg long enough to cross a 480-min cumulative-driving boundary absorbs
  // a 30-min break at each crossing (a very long trip can need two); each
  // break resets the cumulative counter, matching evaluateHos's count.
  const driveLeg = (legMin: number): number => {
    let ms = legMin * MIN_MS;
    let remaining = legMin;
    // driving minutes already consumed on THIS leg when a break triggers
    let consumedOnLeg = 0;
    // breaks already inserted on THIS leg. `cursor` is the leg's departure
    // instant, so the offset to a break must count only the delay added since
    // that instant — the trip-wide `breaksTaken` would double-count every
    // break from an earlier leg.
    let breaksOnLeg = 0;
    while (sinceBreakMin + remaining > BREAK_THRESHOLD_MIN) {
      const untilBreak = Math.max(0, BREAK_THRESHOLD_MIN - sinceBreakMin);
      consumedOnLeg += untilBreak;
      breaks.push({
        atMs: cursor + (consumedOnLeg + breaksOnLeg * BREAK_DURATION_MIN) * MIN_MS,
        afterDriveMin: driveMinSoFar + consumedOnLeg,
        legIndex,
        // A zero-length leg cannot host a break, but guard the division
        // anyway: NaN here would silently poison every downstream ETA.
        fraction: legMin > 0 ? consumedOnLeg / legMin : 0,
        at: null,
        precision: legPrecision,
      });
      remaining -= untilBreak;
      sinceBreakMin = 0;
      ms += BREAK_DURATION_MIN * MIN_MS;
      breaksTaken += 1;
      breaksOnLeg += 1;
    }
    sinceBreakMin += remaining;
    driveMinSoFar += legMin;
    return ms;
  };

  let cursor = proposedStart;
  legIndex = -1;
  legPrecision =
    context.roadMilesFn?.(driver.location, firstStop.location) != null ? "routed" : "estimated";
  cursor += driveLeg(deadheadDriveMin); // arrival at first stop

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const arrival = cursor;

    if (stop.windowEnd != null) {
      if (arrival > stop.windowEnd) {
        conflicts.push({
          kind: lateKind(stop),
          severity: "block",
          detail: `arrives stop ${stop.sequence} after its ${msLabel(stop.windowEnd - arrival)}-late deadline`,
        });
      } else if (stop.windowEnd - arrival < tightMin * MIN_MS) {
        conflicts.push({
          kind: lateKind(stop),
          severity: "warn",
          detail: `tight arrival at stop ${stop.sequence}: ${msLabel(stop.windowEnd - arrival)} of slack`,
        });
      }
    }

    // Early arrival waits for the dock to open; the wait consumes real
    // wall-clock (and therefore 14h-window) time.
    let serviceStart = arrival;
    if (stop.windowStart != null && arrival < stop.windowStart) {
      waitMin += Math.round((stop.windowStart - arrival) / MIN_MS);
      serviceStart = stop.windowStart;
    }

    cursor = serviceStart + dwellOf(stop) * MIN_MS;
    dwellMin += dwellOf(stop);

    if (i < stops.length - 1) {
      const legMi = road(stop.location, stops[i + 1].location);
      const legMin = driveMinutes(legMi, avgSpeed);
      loadedMi += legMi;
      loadedDriveMin += legMin;
      legMiles.push({ index: i, miles: legMi });
      legIndex = i;
      legPrecision =
        context.roadMilesFn?.(stop.location, stops[i + 1].location) != null ? "routed" : "estimated";
      cursor += driveLeg(legMin);
    }
  }

  const proposedEnd = cursor;
  const totalDriveMin = deadheadDriveMin + loadedDriveMin;

  // Second pass: milesRemaining is a suffix sum over the already-collected
  // leg miles (deadhead + loaded), computed only after every leg is known —
  // never re-derived from road(...).
  const legs: PlanLeg[] = new Array(legMiles.length);
  let milesRemaining = 0;
  for (let i = legMiles.length - 1; i >= 0; i--) {
    milesRemaining += legMiles[i].miles;
    legs[i] = { index: legMiles[i].index, miles: legMiles[i].miles, milesRemaining };
  }

  // Fill in each break's geography now that every leg endpoint is known.
  // legIndex -1 is the deadhead leg (driver -> first stop); i is the leg
  // departing stops[i].
  const positionedBreaks = breaks.map((b) => {
    const from = b.legIndex === -1 ? driver.location : stops[b.legIndex].location;
    const to = b.legIndex === -1 ? firstStop.location : stops[b.legIndex + 1]?.location;
    // A break recorded on a leg with no destination cannot be positioned.
    // Absent, not guessed (Global Constraint 1).
    if (!to) return b;
    return { ...b, at: interpolate(from, to, b.fraction) };
  });

  // Independent block checks.
  pushIf(conflicts, checkEquipment(load, trailer));
  pushIf(conflicts, checkHazmat(load, driver));
  pushIf(conflicts, checkDriverAvailable(driver));
  pushIf(conflicts, checkTractorAvailable(tractor));
  pushIf(conflicts, checkTrailerAvailable(trailer));
  // Compliance clocks vs the projected timeline: expired at departure blocks,
  // expiring mid-trip warns, service-due always warns. Runs BEFORE overlap/HOS
  // so an illegal unit is the surfaced reason — the root cause, not "driver
  // busy" — when both are true.
  conflicts.push(...checkCompliance(driver, tractor, trailer, { proposedStart, proposedEnd }));

  pushIf(conflicts, checkOverlap(proposedStart, proposedEnd, context.driverBusy, "overlap", "Driver"));
  pushIf(conflicts, checkOverlap(proposedStart, proposedEnd, context.tractorBusy, "overlap", "Tractor"));
  pushIf(conflicts, checkOverlap(proposedStart, proposedEnd, context.trailerBusy, "overlap", "Trailer"));

  // HOS clock. Dock waits consume the 14h window even though nobody is
  // driving, so they count as on-duty time here.
  const hos = evaluateHos({ driveMin: totalDriveMin, dwellMin: dwellMin + waitMin, hos: driver.hos });
  if (hos.conflict) conflicts.push(hos.conflict);

  const feasible = !conflicts.some((c) => c.severity === "block");

  return {
    feasible,
    conflicts,
    plan: {
      proposedStart,
      proposedEnd,
      deadheadMi,
      loadedMi,
      legs,
      driveMin: totalDriveMin,
      onDutyMin: hos.requiredOnDutyMin,
      needsBreak: hos.needsBreak,
      breaks: positionedBreaks,
    },
  };
}

function pushIf(list: Conflict[], c: Conflict | null): void {
  if (c) list.push(c);
}

function msLabel(ms: number): string {
  const min = Math.round(Math.abs(ms) / MIN_MS);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
