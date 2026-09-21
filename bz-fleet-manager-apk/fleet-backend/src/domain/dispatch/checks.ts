// Independent, explainable feasibility checks (Control Tower §4A).
// Each is a small pure predicate returning a Conflict when it fails, else null.
// The orchestrator (evaluate.ts) composes them; keeping them separate makes
// every rule unit-testable and its failure message self-describing.

import type {
  BusyInterval,
  Conflict,
  ConflictKind,
  DriverInput,
  LoadInput,
  TractorInput,
  TrailerInput,
} from "./types.js";

/** Trailer type must match what the load requires. */
export function checkEquipment(load: LoadInput, trailer: TrailerInput): Conflict | null {
  if (trailer.type === load.requiredEquip) return null;
  return {
    kind: "equipment",
    severity: "block",
    detail: `load needs ${load.requiredEquip}; trailer is ${trailer.type}`,
  };
}

/** A hazmat load requires a hazmat-endorsed driver. */
export function checkHazmat(load: LoadInput, driver: DriverInput): Conflict | null {
  const isHazmat = load.hazmatClass != null && load.hazmatClass !== "";
  if (!isHazmat || driver.hazmatEndorsed) return null;
  return {
    kind: "hazmat",
    severity: "block",
    detail: `load is hazmat class ${load.hazmatClass}; driver is not hazmat-endorsed`,
  };
}

/** Driver must be active (not off-duty / on-break / inactive). */
export function checkDriverAvailable(driver: DriverInput): Conflict | null {
  if (driver.status === "active") return null;
  return { kind: "driver_unavail", severity: "block", detail: `driver is ${driver.status}` };
}

/** Tractor must be active (not in shop / inactive). */
export function checkTractorAvailable(tractor: TractorInput): Conflict | null {
  if (tractor.status === "active") return null;
  return { kind: "tractor_unavail", severity: "block", detail: `tractor is ${tractor.status}` };
}

/** Trailer must be usable (active or idle, not in shop). */
export function checkTrailerAvailable(trailer: TrailerInput): Conflict | null {
  if (trailer.status !== "in_shop") return null;
  return { kind: "trailer_unavail", severity: "block", detail: `trailer is ${trailer.status}` };
}

const overlaps = (start: number, end: number, b: BusyInterval): boolean =>
  start < b.end && b.start < end;

/**
 * The proposed [start,end] window must not intersect any already-committed
 * interval for the same resource.
 */
export function checkOverlap(
  start: number,
  end: number,
  busy: BusyInterval[] | undefined,
  kind: ConflictKind,
  label: string,
): Conflict | null {
  const hit = (busy ?? []).find((b) => overlaps(start, end, b));
  if (!hit) return null;
  return { kind, severity: "block", detail: `${label} already committed in this window` };
}
