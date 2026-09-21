import { driveMinutes, roadMiles } from "../domain/dispatch/distance.js";
import type { ActiveStatus } from "./activeStatuses.js";

// Live late-risk projection over active assignments. Pure (caller supplies
// `now`) so every rule is unit-testable with a fixed clock. Two honest,
// real-data signals only:
//
//  - late_start: the truck hasn't rolled for this load yet (assigned or
//    tendered — the driver hasn't started, or hasn't even accepted), so risk
//    is about the plan slipping; projected arrival = now + planned duration.
//  - behind_schedule: an in-progress driver's OPTIMISTIC arrival (straight
//    line x road factor at planning speed, ignoring remaining stops/dwell) is
//    computed from their live position. Because it's a lower bound, a miss is
//    certain ("even a direct run misses the window") — never a false alarm
//    from the simplification.

export interface RiskCandidate {
  /** null for a covered brokered load: it runs on the carrier's truck, not ours. */
  assignmentId: string | null;
  loadId: string;
  ref: string;
  /** null for a covered brokered load: no driver of ours is on it. */
  driverId: string | null;
  driverName: string | null;
  /** the carrier running a brokered load; null for our own assignments. */
  carrierName?: string | null;
  status: ActiveStatus;
  plannedStartMs: number;
  plannedEndMs: number;
  /** last delivery stop's appointment windowEnd; null = no basis, skipped */
  deadlineMs: number | null;
  driverPos: { lat: number; lng: number } | null;
  finalDrop: { lat: number; lng: number } | null;
}

export interface RiskRow {
  assignmentId: string | null;
  loadId: string;
  ref: string;
  driverId: string | null;
  driverName: string | null;
  carrierName?: string | null;
  kind: "late_start" | "behind_schedule";
  severity: "warn" | "block";
  detail: string;
  deadlineMs: number;
  /** null for a covered brokered load (spec §8.4/R20): no GPS on a carrier's
   *  truck means no transit estimate exists to report — the PU->DEL
   *  appointment span still drives severity and ordering below, but it is
   *  never shipped as an arrival nobody can stand behind. */
  projectedArrivalMs: number | null;
  /** minutes of slack left before the window closes; negative = projected miss */
  slackMin: number;
}

/** Slack under this (but still positive) is a warn; a projected miss is a block. */
export const DEFAULT_WARN_SLACK_MIN = 60;

const fmtMin = (min: number): string => {
  const whole = Math.max(0, Math.round(Math.abs(min)));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export function computeLateRisk(
  now: number,
  candidates: RiskCandidate[],
  warnSlackMin: number = DEFAULT_WARN_SLACK_MIN,
): RiskRow[] {
  const rows: RiskRow[] = [];

  for (const c of candidates) {
    if (c.deadlineMs == null) continue;

    let kind: RiskRow["kind"];
    let projectedArrivalMs: number;
    let cause: string;
    // F4/plan A3 (spec §8.4): a covered brokered load runs on someone else's
    // truck — RiskCandidate.driverId is null ONLY for these (no assignment of
    // ours exists). The late_start branch below turns the PU→DEL appointment
    // span into a transit-duration estimate for OUR assignments, which is
    // legitimate (we know the plan); for a brokered load there is no plan to
    // read a duration off of and no GPS to check it against, so the same math
    // would report a "projected arrival" and a "miss by" figure the record
    // never measured (spec §12: never display a value the record does not
    // hold). Branching on the null driverId here — not on `kind`, which is
    // always "late_start" for a brokered row since the behind_schedule branch
    // already `continue`s them for want of `driverPos` — keeps that lie out
    // of the sentence a dispatcher reads.
    const brokered = c.driverId === null;

    if (c.status === "in_progress") {
      if (!c.driverPos || !c.finalDrop) continue;
      kind = "behind_schedule";
      const optimisticMin = driveMinutes(roadMiles(c.driverPos, c.finalDrop));
      projectedArrivalMs = now + optimisticMin * 60000;
      cause = `Rolling, ${Math.round(roadMiles(c.driverPos, c.finalDrop))} mi from the drop`;
    } else {
      // assigned or tendered: nothing is rolling for this load yet, so the
      // driver's live position (wherever it is — possibly mid-way through a
      // different load) is not evidence about this one. Feasibility was
      // proven against the planned start; risk only appears once that start
      // has slipped without the truck moving.
      if (now <= c.plannedStartMs) continue;
      kind = "late_start";
      projectedArrivalMs = now + (c.plannedEndMs - c.plannedStartMs);
      cause = `Not started ${fmtMin((now - c.plannedStartMs) / 60000)} after the planned start`;
    }

    const slackMin = (c.deadlineMs - projectedArrivalMs) / 60000;
    if (slackMin >= warnSlackMin) continue;

    const severity: RiskRow["severity"] = slackMin < 0 ? "block" : "warn";
    const verdict =
      slackMin < 0
        ? kind === "behind_schedule"
          ? `even a direct run misses the delivery window by ${fmtMin(slackMin)}`
          : `projected to miss the delivery window by ${fmtMin(slackMin)}`
        : `${fmtMin(slackMin)} of slack left before the delivery window closes`;

    // F4: a brokered row's detail states only the one fact the record holds —
    // the pickup window opened and nothing has come back from the carrier —
    // never the arrival projection or "miss by" figure the sentence above
    // would otherwise print. The delivery-window math still drives severity
    // and ordering above; it just never reaches this sentence.
    const detail = brokered
      ? `PU window opened ${fmtMin((now - c.plannedStartMs) / 60000)} ago; no carrier check-in`
      : `${cause} — ${verdict}`;

    rows.push({
      assignmentId: c.assignmentId,
      loadId: c.loadId,
      ref: c.ref,
      driverId: c.driverId,
      driverName: c.driverName,
      carrierName: c.carrierName,
      kind,
      severity,
      detail,
      deadlineMs: c.deadlineMs,
      // R20: severity and slackMin above are still computed from this number
      // — the appointment-derived estimate is real evidence for THOSE. It is
      // only the arrival itself that is never honest to print for a load with
      // no GPS of ours on it.
      projectedArrivalMs: brokered ? null : Math.round(projectedArrivalMs),
      slackMin: Math.round(slackMin),
    });
  }

  // Certain misses first, then tightest slack.
  return rows.sort(
    (a, b) => Number(a.severity === "warn") - Number(b.severity === "warn") || a.slackMin - b.slackMin,
  );
}
