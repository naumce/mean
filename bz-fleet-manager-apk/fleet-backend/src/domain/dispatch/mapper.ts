// Boundary mapper: Prisma-shaped rows -> the pure engine's input types.
// Kept structural (it accepts the minimal shape it needs, not Prisma classes)
// so it is unit-testable without a database. Dates -> epoch ms here; the engine
// never sees a Date.
//
// Design rulings baked in here (see SESSION-STATE control_tower_pivot):
//  * PRESENCE != AVAILABILITY. The existing Driver.status is mobile presence
//    ('offline'/'online'), not dispatch availability. Only an explicit
//    dispatch-inactive marker blocks planning; being "offline in the app" does not.
//  * UNKNOWN HOS is optimistic-but-flagged: a driver with no imported HosState is
//    mapped to full clocks so they remain dispatchable, and the caller surfaces a
//    `warn` (hosKnown=false) rather than silently pretending the hours are real.

import type {
  DriverInput,
  HosStateInput,
  LoadInput,
  StopInput,
  TractorInput,
  TrailerInput,
  TrailerType,
} from "./types.js";

const TRAILER_TYPES: readonly TrailerType[] = [
  "DryVan",
  "Reefer",
  "Flatbed",
  "StepDeck",
  "Tanker",
  "Intermodal",
];

export function asTrailerType(value: string): TrailerType {
  if ((TRAILER_TYPES as readonly string[]).includes(value)) return value as TrailerType;
  throw new Error(`unknown trailer type: ${value}`);
}

// --- Load -------------------------------------------------------------------

export interface AppointmentRow {
  windowStart: Date | null;
  windowEnd: Date;
}
export interface StopRow {
  sequence: number;
  type: string;
  lat: number | null;
  lng: number | null;
  dwellMin: number | null;
  appointment: AppointmentRow | null;
}
export interface LoadRow {
  requiredEquip: string;
  hazmatClass: string | null;
  revenueCents: number;
  fscCents: number;
  stops: StopRow[];
}

function toStopInput(s: StopRow): StopInput {
  if (s.lat == null || s.lng == null) {
    throw new Error(`stop ${s.sequence} is not geocoded (no lat/lng)`);
  }
  const type: StopInput["type"] =
    s.type === "delivery" || s.type === "intermediate" ? s.type : "pickup";
  return {
    sequence: s.sequence,
    type,
    location: { lat: s.lat, lng: s.lng },
    windowStart: s.appointment?.windowStart != null ? s.appointment.windowStart.getTime() : null,
    windowEnd: s.appointment?.windowEnd != null ? s.appointment.windowEnd.getTime() : null,
    dwellMin: s.dwellMin ?? undefined,
  };
}

/** Total load revenue for economics = linehaul + fuel surcharge. */
export function toLoadInput(load: LoadRow): LoadInput {
  return {
    requiredEquip: asTrailerType(load.requiredEquip),
    hazmatClass: load.hazmatClass,
    revenueCents: load.revenueCents + load.fscCents,
    stops: load.stops.map(toStopInput),
  };
}

// --- Driver -----------------------------------------------------------------

/** Mobile-presence values (or dispatch values) that mean "not dispatchable". */
const DISPATCH_INACTIVE = new Set(["inactive", "off_duty", "on_break", "suspended", "disabled"]);

/** Map mobile presence / dispatch status to the engine's availability. */
export function dispatchStatus(status: string): DriverInput["status"] {
  return DISPATCH_INACTIVE.has(status) ? "inactive" : "active";
}

/** Full clocks assumed when a driver's HOS has not been imported yet. */
export const UNKNOWN_HOS: HosStateInput = {
  driveRemainingMin: 660,
  windowRemainingMin: 840,
  cycleRemainingMin: 4200,
  minutesSinceBreak: 0,
};

export interface HosRow {
  driveRemainingMin: number;
  windowRemainingMin: number;
  cycleRemainingMin: number;
  minutesSinceBreak: number;
}
export interface DriverRow {
  status: string;
  hazmatEndorsed: boolean;
  lastLat: number | null;
  lastLng: number | null;
  hos: HosRow | null;
  medicalCertExpiresAt?: Date | null;
}

/**
 * Map a driver row for the engine. `availableAt` (epoch ms) is supplied by the
 * caller (end of current assignment, or "now"). Returns `hosKnown=false` when
 * HOS was defaulted, so the caller can attach a warn instead of trusting it.
 */
export function toDriverInput(
  driver: DriverRow,
  opts: { availableAt: number },
): { input: DriverInput; hosKnown: boolean } {
  if (driver.lastLat == null || driver.lastLng == null) {
    throw new Error("driver has no known position for the deadhead origin");
  }
  const hosKnown = driver.hos != null;
  return {
    input: {
      status: dispatchStatus(driver.status),
      hazmatEndorsed: driver.hazmatEndorsed,
      availableAt: opts.availableAt,
      location: { lat: driver.lastLat, lng: driver.lastLng },
      hos: driver.hos ?? UNKNOWN_HOS,
      medicalExpiresAt: driver.medicalCertExpiresAt?.getTime() ?? null,
    },
    hosKnown,
  };
}

// --- Equipment --------------------------------------------------------------

export interface TractorRow {
  status: string;
  inspectionExpiresAt?: Date | null;
  registrationExpiresAt?: Date | null;
  nextServiceAt?: Date | null;
}
export function toTractorInput(t: TractorRow): TractorInput {
  return {
    status: t.status === "in_shop" || t.status === "inactive" ? t.status : "active",
    inspectionExpiresAt: t.inspectionExpiresAt?.getTime() ?? null,
    registrationExpiresAt: t.registrationExpiresAt?.getTime() ?? null,
    serviceDueAt: t.nextServiceAt?.getTime() ?? null,
  };
}

export interface TrailerRow {
  type: string;
  status: string;
  inspectionExpiresAt?: Date | null;
  registrationExpiresAt?: Date | null;
  nextServiceAt?: Date | null;
}
export function toTrailerInput(t: TrailerRow): TrailerInput {
  return {
    type: asTrailerType(t.type),
    status: t.status === "idle" || t.status === "in_shop" ? t.status : "active",
    inspectionExpiresAt: t.inspectionExpiresAt?.getTime() ?? null,
    registrationExpiresAt: t.registrationExpiresAt?.getTime() ?? null,
    serviceDueAt: t.nextServiceAt?.getTime() ?? null,
  };
}
