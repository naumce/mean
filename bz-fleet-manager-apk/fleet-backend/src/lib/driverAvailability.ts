import type { Assignment, DriverAvailability, HosState, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { ACTIVE_STATUSES } from "./activeStatuses.js";
import { STATE_CODES } from "./geocode.js";

// Driver availability: one shared "where and when will this driver be free"
// projection, plus the explicit (dispatcher-set) row that can override it.
// Extracted from dispatcherDriverNext.ts (lines 47-54), which inlined the
// projection before anything else needed it — that route now imports
// projectAvailability() instead of recomputing it. dispatcherDriverSupply.ts
// (the read/write API) and Task 6's rankOrgDrivers batch are the other two
// consumers of this module.

// ---------------------------------------------------------------------------
// City/state parsing
// ---------------------------------------------------------------------------

/** Pulls "City, ST" out of a free-form address ("123 Dock Rd, Kansas City,
 *  MO 64101" -> {city:"Kansas City", state:"MO"}), preserving the source's
 *  own capitalisation. geocode.ts already has a parseCityState(), but its
 *  contract doesn't fit here: it lowercases both parts (it's keying a
 *  gazetteer lookup, not labelling a UI field) and reports "no match" as a
 *  single null rather than per-field — so a caller can't tell "no state
 *  found" apart from "found a state but no city". This one reuses
 *  geocode.ts's STATE_CODES vocabulary (so the two never disagree on what
 *  counts as a state token) but keeps the source text and nulls per field. */
export function cityStateFromAddress(address: string): { city: string | null; state: string | null } {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const stateToken = parts[i]?.split(/\s+/)[0] ?? "";
    if (STATE_CODES.has(stateToken.toLowerCase())) {
      const city = parts[i - 1]?.replace(/\s+/g, " ").trim() ?? "";
      if (city) return { city, state: stateToken.toUpperCase() };
    }
  }
  return { city: null, state: null };
}

// ---------------------------------------------------------------------------
// Projection: where/when a driver becomes free, with no explicit row at all
// ---------------------------------------------------------------------------

export interface ProjectedAvailability {
  at: number;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
  basis: "current_assignment_last_drop" | "last_ping" | "none";
}

/** The stop projectAvailability treats as "the current assignment's last
 *  drop": the last delivery-type stop that is ALSO geocoded (an ungeocoded
 *  final stop can't tell us a future position, so the fallback chain skips
 *  it exactly like dispatcherDriverNext.ts's pre-extraction inline code
 *  did). Exported so a caller that also needs the stop itself — not just
 *  the lat/lng/city/state projectAvailability distills from it, e.g.
 *  dispatcherDriverNext.ts's own "destination" display field — can find the
 *  identical stop without a second, drifting copy of this predicate. */
export function lastGeocodedDeliveryStop<T extends { type: string; lat: number | null; lng: number | null }>(
  stops: T[],
): T | null {
  return [...stops].reverse().find((s) => s.type === "delivery" && s.lat != null && s.lng != null) ?? null;
}

/**
 * EXACTLY dispatcherDriverNext.ts's pre-extraction rule (lines 47-54): the
 * driver's future position is their CURRENT assignment's last geocoded
 * delivery stop when there is one; otherwise their last ping; otherwise
 * nothing. Availability starts at that assignment's planned end when there
 * is a current assignment, else `nowMs`.
 *
 * city/state are new here (the route this was extracted from never needed
 * them): parsed from the same last-drop stop's address when that's the
 * basis. A ping is a bare lat/lng with no address to parse, so basis
 * "last_ping"/"none" always carry null city/state.
 */
export function projectAvailability(
  driver: { lastLat: number | null; lastLng: number | null },
  current: {
    plannedEnd: Date;
    load: { stops: { type: string; lat: number | null; lng: number | null; address: string }[] };
  } | null,
  nowMs: number,
): ProjectedAvailability {
  const lastDrop = current ? lastGeocodedDeliveryStop(current.load.stops) : null;
  const lat = lastDrop?.lat ?? driver.lastLat;
  const lng = lastDrop?.lng ?? driver.lastLng;
  const at = current ? current.plannedEnd.getTime() : nowMs;
  const basis: ProjectedAvailability["basis"] = lastDrop
    ? "current_assignment_last_drop"
    : driver.lastLat != null && driver.lastLng != null
      ? "last_ping"
      : "none";
  const { city, state } = lastDrop ? cityStateFromAddress(lastDrop.address) : { city: null, state: null };
  return { at, lat, lng, city, state, basis };
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export type AvailabilityStatus = "AVAILABLE" | "AVAILABLE_SOON" | "ON_LOAD" | "OFF_DUTY" | "UNAVAILABLE";

/** An active assignment reads as AVAILABLE_SOON rather than ON_LOAD once its
 *  planned end is within this many ms of now. */
export const AVAILABLE_SOON_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Rules, in order:
 *  1. A row with source "manual" whose `availabilityStatus` is OFF_DUTY or
 *     UNAVAILABLE wins outright — the dispatcher said so explicitly.
 *     Only a MANUAL row counts as this kind of override (SDD ledger,
 *     T2xT8 pre-flight ruling: "only source:manual rows override derived
 *     status") — a "derived" or "simulation" row (Task 8 writes those) is
 *     treated as if its `availabilityStatus` were absent, so this
 *     derivation runs fresh instead of trusting a self-reported status.
 *     That ruling is scoped to the status override specifically; a
 *     derived/simulation row's `acceptingLoads` is still read normally in
 *     rule 3 below — it's an input fact, not a claimed conclusion.
 *
 *     Fix round 1 (task-2-report.md, Concern 1): source "manual" by itself
 *     used to be an unreliable signal, because dispatcherDriverSupply.ts's
 *     PATCH wrote it unconditionally on every write — including a first
 *     PATCH that only ever set `acceptingLoads`, whose freshly-created row
 *     then sat at the schema's own `availabilityStatus` default
 *     ("UNAVAILABLE") and read as a hard override nobody asked for. The
 *     route now writes source:"manual" ONLY on a PATCH that explicitly
 *     includes `availabilityStatus` (source:"derived" otherwise, and an
 *     UPDATE that omits it leaves both columns untouched) — so by the time
 *     a row reaches this function, source:"manual" reliably means "the
 *     dispatcher chose this status," not just "some PATCH touched this row."
 *     This function's own logic did not need to change for that fix; only
 *     the writer (dispatcherDriverSupply.ts) did.
 *  2. Otherwise, an active assignment -> AVAILABLE_SOON when its planned end
 *     is within AVAILABLE_SOON_WINDOW_MS of now, else ON_LOAD.
 *  3. Otherwise, `acceptingLoads` -> AVAILABLE.
 *  4. Otherwise UNAVAILABLE.
 *
 * `hos` is accepted for a future rule (e.g. downgrading a driver who is
 * nearly out of hours) but does not change the status today.
 */
export function deriveStatus(
  explicit: DriverAvailability | null,
  current: Assignment | null,
  hos: HosState | null,
  nowMs: number,
): AvailabilityStatus {
  void hos; // reserved for a future rule — see doc comment above

  const manualStatus = explicit?.source === "manual" ? explicit.availabilityStatus : null;
  if (manualStatus === "OFF_DUTY" || manualStatus === "UNAVAILABLE") return manualStatus;

  if (current) {
    return current.plannedEnd.getTime() - nowMs <= AVAILABLE_SOON_WINDOW_MS ? "AVAILABLE_SOON" : "ON_LOAD";
  }
  return explicit?.acceptingLoads ? "AVAILABLE" : "UNAVAILABLE";
}

// ---------------------------------------------------------------------------
// The batched view: explicit row (if any) merged with the projection
// ---------------------------------------------------------------------------

export interface DriverAvailabilityView {
  driverId: string;
  acceptingLoads: boolean;
  locationSharingEnabled: boolean;
  locationSharingUpdatedAt: Date | null;
  /** null when no DriverAvailability row exists yet — a driver-facing page
   *  authenticated by this token can't be linked until a row (and its
   *  default-generated token) exists, e.g. after the first PATCH. */
  shareToken: string | null;
  status: AvailabilityStatus;
  availableAt: number;
  available: { lat: number | null; lng: number | null; city: string | null; state: string | null };
  current: { lat: number; lng: number; at: number } | null;
  currentAssignment: { loadId: string; loadRef: string; deliveryEtaMs: number; deliveryCity: string | null } | null;
  source: string;
}

type DriverForAvailability = Prisma.DriverGetPayload<{
  include: {
    hos: true;
    availability: true;
    assignments: {
      include: {
        load: {
          select: {
            id: true;
            externalId: true;
            stops: { select: { type: true; address: true; lat: true; lng: true } };
          };
        };
      };
    };
  };
}>;

/** The last delivery-type stop's city, whether or not it is geocoded. Unlike
 *  projectAvailability's last-drop (which needs lat/lng because it feeds a
 *  position), a display label only needs the address text — an ungeocoded
 *  final stop still gets a name here. */
function lastDeliveryCity(stops: { type: string; address: string }[]): string | null {
  const stop = [...stops].reverse().find((s) => s.type === "delivery");
  return stop ? cityStateFromAddress(stop.address).city : null;
}

function toView(driver: DriverForAvailability, nowMs: number): DriverAvailabilityView {
  const current = driver.assignments[0] ?? null;
  const explicit = driver.availability ?? null;
  const projected = projectAvailability(driver, current, nowMs);

  // Location fields set via PATCH win over the projection, field-by-field (a
  // dispatcher who only overrides the city keeps the projected lat/lng) —
  // regardless of the row's `source`. Unlike `availabilityStatus` (see
  // deriveStatus above), these columns are all nullable with no non-empty
  // default, so there's no "schema default masquerading as an explicit
  // choice" ambiguity to guard against here: a non-null value on the row
  // unambiguously means someone set it (a manual PATCH today; a future
  // Task 8 simulation, plausibly). Fix round 1 made this matter concretely —
  // a PATCH that sets a location field without also setting
  // availabilityStatus now creates a "derived" row (dispatcherDriverSupply.ts),
  // so gating this on source==="manual" the way the status check does would
  // silently drop the very value the dispatcher just PATCHed.
  const available = {
    lat: explicit?.availableLat ?? projected.lat,
    lng: explicit?.availableLng ?? projected.lng,
    city: explicit?.availableCity ?? projected.city,
    state: explicit?.availableState ?? projected.state,
  };
  const availableAt = explicit?.availableAt?.getTime() ?? projected.at;

  const currentPing =
    driver.lastLat != null && driver.lastLng != null && driver.lastLocationAt != null
      ? { lat: driver.lastLat, lng: driver.lastLng, at: driver.lastLocationAt.getTime() }
      : null;

  const currentAssignment = current
    ? {
        loadId: current.load.id,
        loadRef: current.load.externalId ?? current.load.id,
        deliveryEtaMs: current.plannedEnd.getTime(),
        deliveryCity: lastDeliveryCity(current.load.stops),
      }
    : null;

  // Missing-row defaults (no DriverAvailability at all — a driver nobody has
  // ever set a manual override or run a simulation for yet): acceptingLoads
  // false, location sharing off/never updated, source "none", shareToken
  // null. Status still runs the full derivation above — an active
  // assignment yields ON_LOAD/AVAILABLE_SOON same as a driver WITH a row,
  // and only the absence of both an assignment and acceptingLoads falls
  // through to UNAVAILABLE.
  return {
    driverId: driver.id,
    acceptingLoads: explicit?.acceptingLoads ?? false,
    locationSharingEnabled: explicit?.locationSharingEnabled ?? false,
    locationSharingUpdatedAt: explicit?.locationSharingUpdatedAt ?? null,
    shareToken: explicit?.shareToken ?? null,
    status: deriveStatus(explicit, current, driver.hos, nowMs),
    availableAt,
    available,
    current: currentPing,
    currentAssignment,
    source: explicit?.source ?? "none",
  };
}

/**
 * One shared "where and when will this driver be free" batch: a single
 * `prisma.driver.findMany` (no per-driver queries) merging each driver's
 * explicit DriverAvailability row, if any, with the projection computed
 * from their current assignment / last ping. `nowMs` defaults to `Date.now()`
 * but takes a fixed value in tests so the AVAILABLE_SOON_WINDOW_MS boundary
 * is deterministic.
 */
export async function availabilityFor(
  orgId: string,
  driverIds?: string[],
  nowMs: number = Date.now(),
): Promise<DriverAvailabilityView[]> {
  const drivers = await prisma.driver.findMany({
    where: { orgId, ...(driverIds ? { id: { in: driverIds } } : {}) },
    include: {
      hos: true,
      availability: true,
      assignments: {
        where: { status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { plannedEnd: "desc" },
        take: 1,
        include: {
          load: {
            select: {
              id: true,
              externalId: true,
              stops: { orderBy: { sequence: "asc" }, select: { type: true, address: true, lat: true, lng: true } },
            },
          },
        },
      },
    },
  });

  return drivers.map((driver) => toView(driver, nowMs));
}
