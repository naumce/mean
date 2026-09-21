// Pure input/output types for the dispatch rules engine (Control Tower §4A/4B).
// The engine is framework- and DB-free: all instants are epoch milliseconds (number),
// all money is integer cents, all distances are miles. The route/DB layer converts
// Date <-> ms and Prisma rows <-> these shapes at the boundary.

export type TrailerType =
  | "DryVan"
  | "Reefer"
  | "Flatbed"
  | "StepDeck"
  | "Tanker"
  | "Intermodal";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface StopInput {
  sequence: number;
  type: "pickup" | "delivery" | "intermediate";
  location: GeoPoint;
  /** appointment window open (epoch ms); driver may wait if it arrives earlier */
  windowStart?: number | null;
  /** appointment "must be done by" (epoch ms); arriving after this is a conflict */
  windowEnd?: number | null;
  /** minutes on-site loading/unloading; default 60 */
  dwellMin?: number;
}

export interface LoadInput {
  requiredEquip: TrailerType;
  /** hazmat class string ("3","8",...); null/undefined = non-hazardous */
  hazmatClass?: string | null;
  /** ordered stops; must contain at least one pickup and one delivery */
  stops: StopInput[];
  revenueCents?: number;
}

export interface HosStateInput {
  /** remaining of the 11h (660 min) driving limit */
  driveRemainingMin: number;
  /** remaining of the 14h (840 min) on-duty window */
  windowRemainingMin: number;
  /** remaining of the 60/70h weekly cycle (3600/4200 min) */
  cycleRemainingMin: number;
  /** cumulative driving minutes since last 30-min break (for the 8h break rule) */
  minutesSinceBreak: number;
}

export interface DriverInput {
  status: "active" | "off_duty" | "on_break" | "inactive";
  hazmatEndorsed: boolean;
  /** earliest epoch ms the driver can begin repositioning */
  availableAt: number;
  /** deadhead origin: last-known position, last drop, or home base */
  location: GeoPoint;
  hos: HosStateInput;
  /** DOT medical certificate expiry (epoch ms); null/undefined = not tracked */
  medicalExpiresAt?: number | null;
}

export interface TractorInput {
  status: "active" | "in_shop" | "inactive";
  /** compliance clocks (epoch ms); null/undefined = not tracked */
  inspectionExpiresAt?: number | null;
  registrationExpiresAt?: number | null;
  serviceDueAt?: number | null;
}

export interface TrailerInput {
  type: TrailerType;
  status: "active" | "idle" | "in_shop";
  inspectionExpiresAt?: number | null;
  registrationExpiresAt?: number | null;
  serviceDueAt?: number | null;
}

/** an existing committed window for a driver/tractor/trailer (for overlap detection) */
export interface BusyInterval {
  start: number;
  end: number;
}

export interface EvalContext {
  /** average planning speed, mph; default 50 */
  avgSpeedMph?: number;
  /** haversine -> road distance multiplier; default 1.2 */
  roadFactor?: number;
  driverBusy?: BusyInterval[];
  tractorBusy?: BusyInterval[];
  trailerBusy?: BusyInterval[];
  /** slack under which an on-time arrival is downgraded to a "tight" warn; default 30 */
  tightArrivalMin?: number;
  /** Optional pre-resolved real road distances (provider/cache lookup built by
   *  lib/routing.ts). null for an unknown pair -> haversine × roadFactor. The
   *  engine stays pure: this is a synchronous map lookup, never I/O. */
  roadMilesFn?: (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => number | null;
}

export type ConflictKind =
  | "equipment"
  | "hazmat"
  | "driver_unavail"
  | "tractor_unavail"
  | "trailer_unavail"
  | "overlap"
  | "late_pickup"
  | "late_delivery"
  | "hos"
  | "invalid_load"
  | "inspection"
  | "registration"
  | "service_due"
  | "medical"
  | "no_rest";

export type Severity = "block" | "warn";

export interface Conflict {
  kind: ConflictKind;
  severity: Severity;
  detail: string;
}

/** Where and when a mandatory 30-min break lands inside a plan. Emitted by the
 *  same arithmetic that already inserts the break into the timeline — never a
 *  second calculation (Global Constraint 2). */
export interface BreakPoint {
  /** epoch ms the break begins */
  atMs: number;
  /** cumulative driving minutes into the trip when it begins */
  afterDriveMin: number;
  /** which leg it falls on. -1 = the deadhead leg; 0..n = the leg departing
   *  stops[i]. */
  legIndex: number;
  /** 0..1 position along that leg's driving time when the break begins */
  fraction: number;
  /** interpolated geographic position; null until Task 2 fills it */
  at: GeoPoint | null;
  /** 'routed' only when real provider miles backed this leg (Global
   *  Constraint 7); the UI prefixes estimated values with '≈' */
  precision: "routed" | "estimated";
}

/** One driving leg of a plan, in route order. Emitted by the same walk that
 *  already computes these distances — never a second derivation (Global
 *  Constraint 2: one definition per concept). */
export interface PlanLeg {
  /** -1 for the deadhead leg (driver location -> first stop); i for the leg
   *  departing stops[i]. Matches BreakPoint.legIndex exactly. */
  index: number;
  miles: number;
  /** miles from the START of this leg to the end of the plan, inclusive of
   *  this leg. The last leg's value equals its own miles. */
  milesRemaining: number;
}

export interface DispatchPlan {
  /** 15-min-snapped epoch ms the driver starts repositioning */
  proposedStart: number;
  /** epoch ms the final delivery completes (arrival + dwell) */
  proposedEnd: number;
  deadheadMi: number;
  loadedMi: number;
  /** every driving leg in route order; deadhead first. Sums to
   *  deadheadMi + loadedMi. */
  legs: PlanLeg[];
  /** total driving minutes (deadhead + loaded) */
  driveMin: number;
  /** total on-duty minutes (drive + dwell + break) */
  onDutyMin: number;
  needsBreak: boolean;
  /** every mandatory break this plan contains, in time order. Empty when
   *  needsBreak is false. `needsBreak === (breaks.length > 0)` always. */
  breaks: BreakPoint[];
}

export interface EvalResult {
  /** true when no block-severity conflict exists (warns are allowed) */
  feasible: boolean;
  conflicts: Conflict[];
  plan: DispatchPlan;
}
