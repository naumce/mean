import { Router } from "express";
import { readAnchorMs, shiftDays, shiftDemoTime } from "../lib/demoTimeShift.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Demo controls. One button: move the whole seeded scenario forward so it sits
// under today again (see lib/demoTimeShift.ts for what that means and why it
// moves whole days).
//
// GATED BY `DEMO_MODE`, and gated hard. This endpoint rewrites every timestamp
// in the database — on a real tenant that is not a feature, it is data loss
// with a friendly name. When DEMO_MODE is not exactly "true" the routes are
// not merely refused, they are ABSENT: a 404, the same answer an unknown path
// gets. A 403 would confirm the endpoint exists and invite someone to go
// looking for the flag that switches it on.
//
// Mounted (without its own prefix) at /api/dispatcher behind requireAuth +
// requireDispatcher + attachOrgScope — app.ts's single structural gate — so a
// caller is already an authenticated dispatcher before the flag is consulted.
export const dispatcherDemoRouter = Router();

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

/** Read at request time, never at import time: a process that booted without
 *  the flag must not keep the routes alive after it is turned off, and the
 *  tests flip it between cases. */
dispatcherDemoRouter.use("/demo", (req, res, next) => {
  if (!demoModeEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

/** What pressing the button would do, without doing it. Lets the UI label the
 *  control honestly — "move 3 days forward" vs "already current" — instead of
 *  offering an action that turns out to be a no-op. */
dispatcherDemoRouter.get("/demo/shift", asyncRoute(async (_req, res) => {
  const anchorMs = await readAnchorMs();
  const plan = shiftDays(anchorMs, Date.now());
  res.json({ ...plan, anchorAt: anchorMs === null ? null : new Date(anchorMs).toISOString() });
}));

dispatcherDemoRouter.post("/demo/shift", asyncRoute(async (_req, res) => {
  const plan = await shiftDemoTime(Date.now());
  // A refusal is still a 200: "already current" is a correct, expected answer
  // to pressing the button twice, not an error the UI should surface as one.
  res.json(plan);
}));
