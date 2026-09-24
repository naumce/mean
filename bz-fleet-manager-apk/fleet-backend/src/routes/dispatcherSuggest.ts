import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { suggestForLoad } from "../lib/suggestForLoad.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The ⚡Suggest panel (Control Tower §4E). Thin wrapper (AI Dispatch
// Foundation, Task 5): the whole load -> ranked-driver pipeline now lives in
// lib/suggestForLoad.ts, shared with dispatchTools/dispatch.ts's
// findFeasibleDrivers/getDispatchCandidateDetails — this route only resolves
// query params + the caller's org, then maps the result to a status code.
export const dispatcherSuggestRouter = Router();

const querySchema = z.object({ loadId: z.string().min(1) });

dispatcherSuggestRouter.get("/suggest", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "loadId is required" });

  // suggestForLoad takes a concrete orgId and 404s a mismatch; an unscoped
  // (legacy/dev) dispatcher has no orgId of their own to pass, so they get
  // the same "sees everything" bypass every other route in this family gives
  // them — resolved here by trusting the LOAD's own org instead. A scoped
  // dispatcher's own orgId is passed as-is; suggestForLoad 404s it the normal
  // way (via its own null return) when the load belongs to someone else.
  let orgId = req.orgScope;
  if (orgId == null) {
    const load = await prisma.load.findUnique({ where: { id: parsed.data.loadId }, select: { orgId: true } });
    if (!load) return res.status(404).json({ error: "Load not found" });
    orgId = load.orgId;
  }

  const result = await suggestForLoad(orgId, parsed.data.loadId);
  if (!result) return res.status(404).json({ error: "Load not found" });
  res.json(result);
}));
