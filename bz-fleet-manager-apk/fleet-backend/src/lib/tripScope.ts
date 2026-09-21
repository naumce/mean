import type { Prisma } from "@prisma/client";
import { outsideCallerOrg } from "../middleware/orgScope.js";

// Tenant scoping for the legacy Trip domain, shared by dispatcherTrips.ts,
// dispatcherBoard.ts and dispatcherApprovals.ts.
//
// Trip carries no orgId column of its own (prisma/schema.prisma): its tenant is
// the org of the driver it is assigned to. An UNASSIGNED trip (driverId null)
// therefore belongs to no tenant and stays in the shared pool every dispatcher
// can see and claim — the only reading the current schema supports, and the
// same "a null org is nobody's" convention dispatcherDrivers.ts already applies
// to Vehicle. It is also load-bearing: POST /trips has no tenant column to
// stamp, so a scoped dispatcher would otherwise be unable to see or assign the
// trip they just created. An ASSIGNED trip is strictly private to its driver's
// org.

type ScopedRequest = { orgScope?: string | null };

/** Prisma where-fragment selecting the trips this caller may see. */
export function tripScope(req: ScopedRequest): Prisma.TripWhereInput {
  if (req.orgScope == null) return {};
  return { OR: [{ driverId: null }, { driver: { orgId: req.orgScope } }] };
}

/** True when a trip's owning driver puts it outside the caller's tenant. */
export function tripOutsideCallerOrg(req: ScopedRequest, driver: { orgId: string | null } | null): boolean {
  return driver != null && outsideCallerOrg(req, driver.orgId);
}

/** Prisma where-fragment selecting the signs-proofs this caller may see.
 *  SignsProof reaches its tenant through stop -> trip -> driver -> orgId. */
export function signsProofScope(req: ScopedRequest): Prisma.SignsProofWhereInput {
  if (req.orgScope == null) return {};
  return { stop: { trip: tripScope(req) } };
}
