// US FMCSA property-carrying Hours-of-Service feasibility (Control Tower §4B).
// Pure function; the single most correctness-critical piece of the engine.
// An LLM must never decide this — it is deterministic law.

import type { Conflict, HosStateInput } from "./types.js";

/** cumulative driving minutes after which a 30-min break is required (8h) */
export const BREAK_THRESHOLD_MIN = 480;
export const BREAK_DURATION_MIN = 30;

export interface HosEval {
  feasible: boolean;
  /** driving minutes this trip requires (deadhead + loaded) */
  requiredDriveMin: number;
  /** on-duty minutes this trip requires (drive + dwell + break) */
  requiredOnDutyMin: number;
  /** whether the 8h-cumulative 30-min break is triggered by this trip */
  needsBreak: boolean;
  /** the blocking conflict when infeasible, else undefined */
  conflict?: Conflict;
}

const hoursLabel = (min: number): string => {
  const total = Math.round(min); // round FIRST so 119.6 is "2h", never "1h 60m"
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

/**
 * How many 30-minute breaks a stretch of driving requires. THE definition —
 * `evaluateHos` and `evaluate`'s timeline walk both derive from this, and
 * tests/engine-break-agreement.test.ts is the guard that they still agree.
 *
 * FMCSA: a break is due after MORE than 8 cumulative hours of driving, so
 * exactly 480 is still legal. The previous formulation expressed that with a
 * whole-minute epsilon, which silently swallowed every fractional overshoot
 * under a minute — and real drive times are always fractional.
 */
export function breaksRequired(minutesSinceBreak: number, driveMin: number): number {
  // No driving, no break — however overdue the driver already is. The break
  // they owe belongs to the trip that does the driving, not to this one.
  if (driveMin <= 0) return 0;
  if (minutesSinceBreak + driveMin <= BREAK_THRESHOLD_MIN) return 0;
  // Driving available before the first break. Clamped at 0: a driver already
  // past the threshold must break before turning a wheel — not "minus two
  // hours ago".
  const beforeFirst = Math.max(0, BREAK_THRESHOLD_MIN - minutesSinceBreak);
  const afterFirst = driveMin - beforeFirst;
  return 1 + Math.max(0, Math.ceil(afterFirst / BREAK_THRESHOLD_MIN) - 1);
}

/**
 * Evaluate whether a trip fits the driver's remaining HOS clocks.
 * @param driveMin total driving minutes the trip requires (deadhead + loaded)
 * @param dwellMin total on-site (non-driving) on-duty minutes across all stops
 * @param hos the driver's current remaining clocks
 */
export function evaluateHos(args: {
  driveMin: number;
  dwellMin: number;
  hos: HosStateInput;
}): HosEval {
  const { hos } = args;
  const requiredDriveMin = args.driveMin;
  const breaksNeeded = breaksRequired(hos.minutesSinceBreak, requiredDriveMin);
  const needsBreak = breaksNeeded > 0;
  const requiredOnDutyMin = requiredDriveMin + args.dwellMin + breaksNeeded * BREAK_DURATION_MIN;

  const overDrive = requiredDriveMin > hos.driveRemainingMin;
  const overWindow = requiredOnDutyMin > hos.windowRemainingMin;
  const overCycle = requiredOnDutyMin > hos.cycleRemainingMin;

  if (overDrive || overWindow || overCycle) {
    const reason = overDrive
      ? `needs ${hoursLabel(requiredDriveMin)} drive; ${hoursLabel(hos.driveRemainingMin)} remaining`
      : overWindow
        ? `needs ${hoursLabel(requiredOnDutyMin)} on-duty; ${hoursLabel(hos.windowRemainingMin)} in the 14h window`
        : `needs ${hoursLabel(requiredOnDutyMin)} on-duty; ${hoursLabel(hos.cycleRemainingMin)} left in cycle`;
    return {
      feasible: false,
      requiredDriveMin,
      requiredOnDutyMin,
      needsBreak,
      conflict: { kind: "hos", severity: "block", detail: reason },
    };
  }

  return { feasible: true, requiredDriveMin, requiredOnDutyMin, needsBreak };
}
