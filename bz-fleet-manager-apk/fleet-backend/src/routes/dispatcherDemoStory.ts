import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { demoModeEnabled } from "./dispatcherDemo.js";
import { runnerState } from "../lib/simulation/runner.js";
import {
  DEMO_ACTIONS, STAGES, InvalidAction, NightShiftReleasing, WorkerUnavailable, WrongStage,
  askAi, driverReply, next, observeStory, recordApproval, recordCustomerUpdate, resetDemo, resolve, skipArrival, waitingOnFor,
  type DemoAction, type DemoStory, type DemoStoryResponse,
} from "../lib/demoStory/index.js";

// Demo Mode: the presenter's own API — story state, Reset, and the seven
// human actions. GATED BY DEMO_MODE, gated hard, same convention as
// dispatcherDemo.ts's /demo/shift and dispatcherSim.ts's /sim/*: off means
// ABSENT, a 404, never merely refused. Mounted (no extra prefix) at
// /api/dispatcher behind app.ts's one structural gate
// (requireAuth + requireDispatcher + attachOrgScope), next to those two
// routers.
export const dispatcherDemoStoryRouter = Router();

dispatcherDemoStoryRouter.use("/demo/story", (req, res, innerNext) => {
  if (!demoModeEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  innerNext();
});

/** Every /demo/story handler is one org's story, never all of them — a 400
 *  (not a silent "every org") is what an unscoped legacy/dev dispatcher token
 *  gets here, same as dispatcherSim.ts's own orgOrRefuse. */
function orgOrRefuse(req: Request, res: Response): string | null {
  if (!req.orgScope) {
    res.status(400).json({ error: "ORG_REQUIRED" });
    return null;
  }
  return req.orgScope;
}

dispatcherDemoStoryRouter.get("/demo/story", asyncRoute(async (req, res) => {
  const orgId = orgOrRefuse(req, res);
  if (!orgId) return;

  const existing = await prisma.demoStory.findUnique({ where: { orgId } });
  const story = existing ? await observeStory(orgId) : null;

  const [load, state] = await Promise.all([
    story?.loadId ? prisma.load.findUnique({ where: { id: story.loadId }, select: { agentPill: true } }) : null,
    prisma.simulationState.findUnique({ where: { orgId }, select: { simMinutesAdvanced: true } }),
  ]);
  const live = runnerState(orgId);

  const body: DemoStoryResponse = {
    story,
    stages: STAGES,
    waitingOn: story ? await waitingOnFor(story) : null,
    links: {
      cockpitLoadId: story?.loadId ?? null,
      aiRunId: story?.runId ?? null,
      driverId: story?.driverId ?? null,
      agentTimelineLoadId: story?.loadId ?? null,
    },
    worker: { configured: Boolean(process.env.WORKER_URL) },
    sim: { running: live.running, speed: live.speed, simNowMs: Date.now() + (state?.simMinutesAdvanced ?? 0) * 60_000 },
    pill: load?.agentPill ?? null,
  };
  res.json(body);
}));

dispatcherDemoStoryRouter.post("/demo/story/reset", asyncRoute(async (req, res) => {
  const orgId = orgOrRefuse(req, res);
  if (!orgId) return;
  const dispatcherId = req.auth?.dispatcherId;
  if (!dispatcherId) return res.status(403).json({ error: "Forbidden" });

  const story = await resetDemo(orgId, dispatcherId);
  res.json({ story });
}));

const actionBodySchema = z.object({
  action: z.enum(DEMO_ACTIONS),
  assignmentId: z.string().min(1).optional(),
  driverId: z.string().min(1).optional(),
  text: z.string().min(1).max(500).optional(),
});
type ActionBody = z.infer<typeof actionBodySchema>;

function runAction(orgId: string, dispatcherId: string | null, body: ActionBody): Promise<DemoStory> {
  switch (body.action as DemoAction) {
    case "ask_ai": return askAi(orgId, dispatcherId);
    case "approve": return recordApproval(orgId, { assignmentId: body.assignmentId!, driverId: body.driverId! });
    case "driver_reply": return driverReply(orgId, body.text!);
    case "customer_update_sent": return recordCustomerUpdate(orgId);
    case "resolve": return resolve(orgId);
    case "skip_arrival": return skipArrival(orgId);
    case "next": return next(orgId, dispatcherId);
  }
}

dispatcherDemoStoryRouter.post("/demo/story/action", validateBody(actionBodySchema), asyncRoute(async (req, res) => {
  const orgId = orgOrRefuse(req, res);
  if (!orgId) return;
  const body = req.body as ActionBody;
  const dispatcherId = req.auth?.dispatcherId ?? null;

  if (body.action === "approve" && (!body.assignmentId || !body.driverId)) {
    return res.status(400).json({ error: "assignmentId and driverId are required for \"approve\"" });
  }
  if (body.action === "driver_reply" && !body.text) {
    return res.status(400).json({ error: "text is required for \"driver_reply\"" });
  }

  try {
    const story = await runAction(orgId, dispatcherId, body);
    res.json({ story });
  } catch (err) {
    if (err instanceof WrongStage) return res.status(409).json({ error: "WRONG_STAGE", stage: err.stage });
    if (err instanceof NightShiftReleasing) return res.status(409).json({ error: "NIGHT_SHIFT_RELEASING", message: err.message });
    if (err instanceof WorkerUnavailable) return res.status(503).json({ error: "WORKER_UNAVAILABLE", message: err.message });
    if (err instanceof InvalidAction) return res.status(400).json({ error: "INVALID_ACTION", message: err.message });
    throw err; // asyncRoute forwards to the terminal error handler
  }
}));
