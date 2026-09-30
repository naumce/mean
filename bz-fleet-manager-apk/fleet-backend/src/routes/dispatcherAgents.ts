import { Router } from "express";
import { asyncRoute } from "../lib/asyncRoute.js";
import { buildAgentsOverview } from "../lib/agentsOverview.js";

// AI Agents Surface (Task 3): GET /api/dispatcher/agents/overview — the AI
// Agents page's one read. Mounted under dispatcherRouter with the same
// structural gate every other dispatcher router gets (requireAuth,
// requireDispatcher, attachOrgScope — app.ts's one mount for the whole
// /api/dispatcher surface), next to dispatcherNightShiftRouter. Unlike
// dispatcherDemoStoryRouter/dispatcherSimRouter this is never gated on
// DEMO_MODE — it reports the real dispatch/Night Shift state whether or not
// the demo is on. The route stays thin; every query and shaping decision
// lives in lib/agentsOverview.ts (buildAgentsOverview), same split
// dispatcherNightShift.ts keeps with lib/agentTimeline.ts.
export const dispatcherAgentsRouter = Router();

dispatcherAgentsRouter.get("/agents/overview", asyncRoute(async (req, res) => {
  // An unscoped (legacy/dev) dispatcher sees the cross-org totals, same
  // "sees everything" convention as every other dispatcher route
  // (middleware/orgScope.ts) — buildAgentsOverview's own orgId === null
  // branches match that exactly.
  const overview = await buildAgentsOverview(req.orgScope ?? null);
  res.json(overview);
}));
