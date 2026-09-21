// The spec §13 story as data: one run, Kansas City to Des Moines, with the
// anomalies at the minutes the story needs. The mile function IS the story.
// Every other number the replay produces (07:27, 08:44, 10:36) is the rules
// reading this data — nothing below states an outcome.
import type { Brief } from "../core/types.js";

export type ReplayStep =
  | { atMin: number; kind: "accept" }
  | { atMin: number; kind: "ping"; mi: number }
  | { atMin: number; kind: "reply"; text: string }
  | { atMin: number; kind: "dispatcher"; text: string };

export interface Scenario {
  t0Ms: number;
  brief: Brief;
  restStopsAtMi: Array<{ name: string; mi: number }>;
  landmarksAtMi: Array<{ name: string; mi: number }>;
  steps: ReplayStep[];
}

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
/** 06:10 America/Chicago on Sat Sep 6 2026. */
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const MIN = 60_000;
/** StraightRouter's length for this pair; the destination sits at this mile. */
const END_MI = 179.5;

/** Where the truck is at minute `m`. Piecewise, deliberately. */
export function mileAt(m: number): number {
  if (m <= 61) return m;                                  // 60 mph out of KC
  if (m <= 81) return 62;                                 // Bethany, MO: 20 minutes, not on the plan
  if (m <= 109) return 62 + (m - 82);                     // rolling again; reaches mile 90 at 110
  if (m <= 140) return 90;                                // Love's Osceola: the mandatory 30, in its window
  if (m <= 189) return 90 + 0.25 * (m - 140);             // traffic north of Osceola, 15 mph
  return Math.min(END_MI, 102.25 + (m - 189));            // clears; inside the arrival fence from minute 266
}

export function kcDesMoines(): Scenario {
  const brief: Brief = {
    loadRef: "W-19",
    origin: { name: "Kansas City, MO", ...KC },
    destination: { name: "Des Moines, IA", ...DSM },
    equipment: "DryVan",
    departAtMs: T0,
    deadlineAtMs: T0 + 245 * MIN, // 10:15
    driverName: "Jake Morrow",
    driverPhone: "+15550001",
    customerEmail: "ops@customer.example",
    // 6h10 already driven on an earlier load: the 8-hour mark lands 110 min in.
    minutesSinceBreakAtDepart: 370,
  };
  const steps: ReplayStep[] = [{ atMin: 0, kind: "accept" }];
  for (let m = 0; m <= 280; m += 1) {
    steps.push({ atMin: m, kind: "ping", mi: mileAt(m) });
    if (m === 81) steps.push({ atMin: 81, kind: "reply", text: "had to use the bathroom, rolling now" });
    if (m === 192) steps.push({ atMin: 192, kind: "dispatcher", text: "send the customer email" });
  }
  return {
    t0Ms: T0,
    brief,
    restStopsAtMi: [{ name: "Love's Osceola", mi: 90 }],
    landmarksAtMi: [{ name: "Bethany, MO", mi: 62 }, { name: "Osceola, IA", mi: 95 }],
    steps,
  };
}
