import type { RequestHandler } from "express";
import { prisma } from "../db.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Multi-tenant scoping for the Control Tower routes. Resolves the
// authenticated dispatcher's org once per request and exposes it as
// req.orgScope. A dispatcher WITH an org is confined to it: every CT query
// must filter by req.orgScope, and cross-org ids read as "not found". A
// dispatcher WITHOUT an org (legacy/dev accounts) sees everything —
// preserves the pre-tenancy behaviour until all accounts are migrated.
// Layered after requireAuth + requireDispatcher.
//
// Wrapped in asyncRoute (plan A5 task 7, fix round 1): this is the one
// function in src/middleware that awaits the database — checked the rest
// (auth.ts, rateLimit.ts, rejectNulBytes.ts, validate.ts, errorHandler.ts are
// all synchronous; see tests/no-silent-hang.test.ts's middleware sweep,
// which enforces this rather than trusting the comment) — and it sits ahead
// of every authenticated dispatcher route. Express 4 never awaits a
// middleware function any more than it awaits a route handler, so a rejected
// promise here used to go nowhere for exactly the reason Task 1 wrapped
// route handlers in the first place. This does not touch the settle
// deadline — that is src/middleware/settleDeadline.ts's job now, mounted
// ahead of this so it bounds this function's hang time too.
//
// Named function expression, not an anonymous arrow (plan A5 task 7, fix
// round 1 completion): asyncRoute's wrapper now carries fn.name onto itself
// so Express's router stack still shows "attachOrgScope" instead of going
// blank — tests/dispatcher-mount-order.test.ts finds this layer BY THAT
// NAME. Naming it here is what gives that name-preservation something to
// carry through. Consequence, reasoned through and accepted: HANDLER_RE in
// tests/no-silent-hang.test.ts deliberately does not match `async function
// name(req...` shapes at all (src/routes is full of legitimate non-handler
// helpers with that exact signature — ownLoad, scopedTrip, resolveLaneOrNotFound,
// etc. — and flagging all of them would be noise), so that guard is
// structurally blind to this function either way, wrapped or not. If a
// future edit strips the asyncRoute(...) call here while keeping the name,
// the broad guard stays silent. tests/no-silent-hang.test.ts pins that one
// exception with a narrow, name-specific check instead of widening the
// general regex.
//
// Exported via an alias (`export { attachOrgScopeMW as attachOrgScope }`),
// not `export const attachOrgScope = asyncRoute(async function
// attachOrgScope ...)`, for a reason specific to THIS repo's test runner:
// under vitest's esbuild-based SSR transform (not under tsx, not under `tsc`
// + node — verified both), a top-level `const`/`export const` binding whose
// name textually matches a nested named-function-expression's own name gets
// silently renamed ("attachOrgScope" -> "attachOrgScope2") by esbuild's
// symbol renamer, even though real ES module scoping has no actual
// collision (a function expression's own name is only visible inside its
// own body). That silently reintroduces exactly the bug this file exists to
// prevent — countOfName(stack, "attachOrgScope") back to 0 — but ONLY when
// run through vitest, which is precisely the one place a regression here
// would go unnoticed. Binding the wrapped handler to a differently-named
// local (`attachOrgScopeMW`) and re-exporting it under the name importers
// expect sidesteps esbuild's renamer, which only acts on same-named local
// bindings, not on export aliases. Confirmed empirically against 5 module
// shapes before landing on this one; do not "simplify" this back to `export
// const attachOrgScope = asyncRoute(async function attachOrgScope(...))`
// without re-running tests/dispatcher-mount-order.test.ts under vitest.

declare global {
  namespace Express {
    interface Request {
      /** dispatcher's orgId, or null = unscoped legacy/dev account */
      orgScope?: string | null;
    }
  }
}

const attachOrgScopeMW: RequestHandler = asyncRoute(async function attachOrgScope(req, res, next) {
  // apiKeyAuth (mounted ahead of the whole /api/dispatcher gate, Task 5)
  // already set req.orgScope from the verified OrgApiKey row for this
  // request — nothing to look up. Re-deriving it from req.auth.dispatcherId
  // below would also just fail closed (there is no dispatcherId on an
  // API-key request), so this has to be checked first, not as a fallback.
  if (req.viaApiKey) return next();
  const dispatcherId = req.auth?.dispatcherId;
  if (!dispatcherId) return res.status(403).json({ error: "Forbidden" });
  const dispatcher = await prisma.dispatcher.findUnique({
    where: { id: dispatcherId },
    select: { orgId: true },
  });
  if (!dispatcher) return res.status(403).json({ error: "Forbidden" });
  req.orgScope = dispatcher.orgId;
  next();
});
export { attachOrgScopeMW as attachOrgScope };

/** Prisma where-fragment for the current tenant ({} when unscoped). */
export function orgWhere(req: { orgScope?: string | null }): { orgId?: string } {
  return req.orgScope ? { orgId: req.orgScope } : {};
}

/** True when `orgId` is outside the request's tenant. */
export function outsideOrg(req: { orgScope?: string | null }, orgId: string): boolean {
  return req.orgScope != null && orgId !== req.orgScope;
}

/** True when a NULLABLE-org row is outside the caller's tenant.
 *
 *  Driver.orgId is nullable, so the `req.orgScope != null` gate comes FIRST:
 *  an unscoped (legacy/dev) dispatcher keeps the documented "sees everything"
 *  bypass above even for an orgless row. For a SCOPED caller an orgless row
 *  counts as outside — exactly how orgWhere() already leaves it out of every
 *  list. Hoisted here from dispatcherDrivers.ts (which introduced it) so the
 *  Trip- and Conversation-scoped routers share one definition of the rule
 *  rather than four drifting copies. */
export function outsideCallerOrg(req: { orgScope?: string | null }, orgId: string | null): boolean {
  return req.orgScope != null && (orgId == null || outsideOrg(req, orgId));
}
