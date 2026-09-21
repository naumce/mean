import { Router } from "express";
import { z } from "zod";
import { scanDetention } from "../lib/detentionScan.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// T5 Dwell and Detention, Task 5 — the HTTP surface over scanDetention
// (src/lib/detentionScan.ts), which already returns one detention row per
// stop complete with claims, refusal reasons and evidence. This router adds
// nothing but auth, org scoping and the sinceHours guardrail; every honesty
// rule (absent-not-zero, engine-authoritative, understate-not-overstate,
// evidence-carried-with-claim) lives in domain/dwell/{segments,detention}.ts
// and is exercised there, not here.
//
// Copied from dispatcherFuelPrices.ts (itself copied from
// dispatcherRestStops.ts) for structure: same auth, same org scoping, same
// 404-not-403 shape. Mounted (without its own prefix) at /api/dispatcher
// behind requireAuth + requireDispatcher + attachOrgScope — see app.ts's
// single structural gate. There is no :id route here, so the 404-not-403
// rule has nothing to bite on directly, but org scoping is still load-
// bearing: scanDetention takes a single concrete orgId, so an unscoped
// (legacy/dev) dispatcher account is refused with 400 rather than silently
// scanning every tenant's assignments — the same shape as the write
// endpoints on the routers above (e.g. "Fuel prices require an org-scoped
// dispatcher account").
export const dispatcherDetentionRouter = Router();

const DEFAULT_SINCE_HOURS = 72;
const MIN_SINCE_HOURS = 1;
// 720h = 30 days. This cap is a real safeguard, not decoration: scanDetention
// fetches every DriverLocation row in [sinceMs, now) for every driver with an
// assignment in the org, one query per driver (see that file's header). On a
// real fleet DriverLocation is millions of rows; an unbounded or
// caller-controlled-arbitrarily-large window turns one dispatcher-portal
// pageview into a full-table scan. Zod rejects an out-of-range value with 400
// rather than silently clamping it — a caller who asks for 5000 hours made a
// mistake, and clamping would hide that mistake instead of surfacing it.
const MAX_SINCE_HOURS = 720;
const MS_PER_HOUR = 3_600_000;

const querySchema = z.object({
  sinceHours: z.coerce.number().int().min(MIN_SINCE_HOURS).max(MAX_SINCE_HOURS).optional(),
});

dispatcherDetentionRouter.get("/detention", asyncRoute(async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: `sinceHours must be an integer between ${MIN_SINCE_HOURS} and ${MAX_SINCE_HOURS}`,
    });
  }

  if (!req.orgScope) {
    return res.status(400).json({ error: "Detention requires an org-scoped dispatcher account" });
  }

  const sinceHours = parsed.data.sinceHours ?? DEFAULT_SINCE_HOURS;
  const sinceMs = Date.now() - sinceHours * MS_PER_HOUR;

  try {
    // Express 4 does not await route handlers — a rejection that escapes this
    // try/catch would leave the caller with no HTTP response at all, not even
    // a 500 (src/lib/processGuards.ts). Caught explicitly and handed to
    // next(err) so errorHandler (app.ts, mounted last) can still respond;
    // this codebase has already been bitten by the un-caught version of this
    // once (see dispatcherFuelPrices.ts's own note on the same hazard).
    const claims = await scanDetention(req.orgScope, sinceMs);
    res.json(claims);
  } catch (err) {
    next(err);
  }
}));
