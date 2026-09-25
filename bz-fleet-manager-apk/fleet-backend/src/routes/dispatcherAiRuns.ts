import { Router } from "express";
import { z } from "zod";
import type { AiExperiment } from "@prisma/client";
import { prisma } from "../db.js";
import { orgWhere, outsideOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { enqueueRun, cancelRun } from "../lib/aiHarness/runner.js";
import { getUncoveredLoads } from "../lib/dispatchTools/loads.js";
import { evaluateExperiment } from "../lib/aiHarness/evaluation.js";
import { prismaRunStore } from "../lib/aiHarness/runStore.js";
import {
  allReferencedDriverIds,
  fetchDriverNames,
  fetchScenarios,
  scenarioOf,
  toRunDetail,
  toRunSummaries,
  RUN_SUMMARY_SELECT,
  type RunScenario,
} from "../lib/aiHarness/runView.js";

// routes/dispatcherAiRuns.ts (Qwen Harness v0.1, Task 6): run lifecycle —
// enqueue (single + batch), listing, one run's full detail, cancel, the
// human verdict, replay, and the experiment-level evaluation table. Exported
// as its own Router and mounted onto dispatcherAi.ts's already-gated
// `/ai` sub-router (`aiRouter.use(dispatcherAiRunsRouter)`) — split out purely
// so neither file grows past this project's file-size convention; every path
// below is still relative to `/ai`, and every route still runs behind that
// file's harnessEnabled() gate and the structural auth/org gate app.ts
// mounts ahead of the whole /api/dispatcher surface.
export const dispatcherAiRunsRouter = Router();

/** Same fetch-and-scope-check as dispatcherAi.ts's own ownedExperiment —
 *  intentionally duplicated rather than imported, to avoid a two-file import
 *  cycle (dispatcherAi.ts already imports THIS router) for the sake of one
 *  four-line function. See that file's comment on the same helper. */
async function ownedExperiment(req: { orgScope?: string | null }, id: string): Promise<AiExperiment | null> {
  const experiment = await prisma.aiExperiment.findUnique({ where: { id } });
  if (!experiment || outsideOrg(req, experiment.orgId)) return null;
  return experiment;
}

const RUN_STATUSES = ["queued", "running", "proposed", "incomplete", "failed", "cancelled"] as const;

function queueErrorStatus(error: "QUEUE_FULL" | "EXPERIMENT_NOT_FOUND" | "LOAD_NOT_FOUND" | "HARNESS_DISABLED") {
  return error === "QUEUE_FULL" ? 429 : 404;
}

const startRunSchema = z.object({ loadId: z.string().min(1) });

dispatcherAiRunsRouter.post("/experiments/:id/runs", validateBody(startRunSchema), asyncRoute(async (req, res) => {
  const experiment = await ownedExperiment(req, req.params.id as string);
  if (!experiment) return res.status(404).json({ error: "Not found" });

  const body = req.body as z.infer<typeof startRunSchema>;
  const result = await enqueueRun({
    orgId: experiment.orgId,
    experimentId: experiment.id,
    loadId: body.loadId,
    requestedById: req.auth?.dispatcherId ?? null,
  });

  if ("error" in result) {
    const status = queueErrorStatus(result.error);
    return res.status(status).json({ error: status === 429 ? "QUEUE_FULL" : "Not found" });
  }
  res.status(202).json({ runId: result.runId });
}));

const batchRunSchema = z.object({ limit: z.number().int().min(1).max(10) });

dispatcherAiRunsRouter.post("/experiments/:id/runs/batch", validateBody(batchRunSchema), asyncRoute(async (req, res) => {
  const experiment = await ownedExperiment(req, req.params.id as string);
  if (!experiment) return res.status(404).json({ error: "Not found" });

  const body = req.body as z.infer<typeof batchRunSchema>;
  const loads = await getUncoveredLoads(experiment.orgId);
  const requestedById = req.auth?.dispatcherId ?? null;

  const runIds: string[] = [];
  for (const load of loads) {
    if (runIds.length >= body.limit) break;
    const result = await enqueueRun({ orgId: experiment.orgId, experimentId: experiment.id, loadId: load.id, requestedById });
    if ("error" in result) {
      if (result.error === "QUEUE_FULL") break;
      continue; // load came straight from getUncoveredLoads for this org/experiment — should not happen, but never abort the whole batch over one row
    }
    runIds.push(result.runId);
  }

  res.status(202).json({ runIds });
}));

dispatcherAiRunsRouter.get("/experiments/:id/evaluation", asyncRoute(async (req, res) => {
  const experiment = await ownedExperiment(req, req.params.id as string);
  if (!experiment) return res.status(404).json({ error: "Not found" });

  const evaluation = await evaluateExperiment(experiment.orgId, experiment.id);
  if (!evaluation) return res.status(404).json({ error: "Not found" });
  res.json({ evaluation });
}));

const listRunsQuerySchema = z.object({
  experimentId: z.string().min(1).optional(),
  loadId: z.string().min(1).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

dispatcherAiRunsRouter.get("/runs", asyncRoute(async (req, res) => {
  const parsed = listRunsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query" });
  const { experimentId, loadId, status, limit } = parsed.data;

  // I5: same reasoning as GET /ai/experiments/:id — this list only ever
  // renders RunSummary fields, so it only ever selects those.
  const records = await prisma.aiDecisionRecord.findMany({
    where: {
      ...orgWhere(req),
      ...(experimentId ? { experimentId } : {}),
      ...(loadId ? { loadId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { proposedAt: "desc" },
    take: limit ?? 100,
    select: RUN_SUMMARY_SELECT,
  });

  // Defense in depth (fix round 1): scope the name/scenario lookups to the
  // caller's own org. `req.orgScope` is null only for an unscoped (legacy/
  // dev) dispatcher, whose `orgWhere(req)` above already returned {} — the
  // existing "sees everything" convention this codebase already applies
  // everywhere else, not a new gap introduced here.
  res.json({ runs: await toRunSummaries(records, req.orgScope ?? null) });
}));

dispatcherAiRunsRouter.get("/runs/:id", asyncRoute(async (req, res) => {
  const record = await prisma.aiDecisionRecord.findUnique({ where: { id: req.params.id as string } });
  if (!record || outsideOrg(req, record.orgId)) return res.status(404).json({ error: "Not found" });

  const loadRow = record.loadId
    ? await prisma.load.findUnique({ where: { id: record.loadId }, select: { id: true, externalId: true, customerName: true, extras: true } })
    : null;
  const scenario = loadRow ? scenarioOf(loadRow.extras) : null;
  // A one-entry map built from the load already fetched above, rather than
  // another fetchScenarios([...]) round trip for data this handler already
  // has in hand.
  const scenarios = new Map<string, RunScenario | null>(loadRow ? [[loadRow.id, scenario]] : []);

  const driverNames = await fetchDriverNames(allReferencedDriverIds(record), record.orgId);
  const steps = await prismaRunStore.listSteps(record.id);
  const load = loadRow ? { id: loadRow.id, externalId: loadRow.externalId, customerName: loadRow.customerName, scenario } : null;

  res.json({
    run: toRunDetail(record, driverNames, scenarios),
    steps,
    load,
    driverNames: Object.fromEntries(driverNames),
  });
}));

dispatcherAiRunsRouter.post("/runs/:id/cancel", asyncRoute(async (req, res) => {
  const record = await prisma.aiDecisionRecord.findUnique({ where: { id: req.params.id as string }, select: { id: true, orgId: true } });
  if (!record || outsideOrg(req, record.orgId)) return res.status(404).json({ error: "Not found" });

  const cancelled = await cancelRun(record.orgId, record.id);
  res.json({ cancelled });
}));

const decisionSchema = z.object({
  verdict: z.enum(["accept", "reject", "other"]),
  driverId: z.string().min(1).optional(),
  note: z.string().max(1000).optional(),
});

// A verdict only makes sense once a run has actually stopped moving on its
// own AND there is something to react to — not while it is still queued or
// running (nothing settled yet), but also not "cancelled" (nothing was ever
// proposed either). This is an exhaustive allow-list, not "everything except
// queued/running": the brief names exactly these three.
const DECISION_ALLOWED_STATUSES = new Set(["proposed", "incomplete", "failed"]);

dispatcherAiRunsRouter.post("/runs/:id/decision", validateBody(decisionSchema), asyncRoute(async (req, res) => {
  const record = await prisma.aiDecisionRecord.findUnique({ where: { id: req.params.id as string } });
  if (!record || outsideOrg(req, record.orgId)) return res.status(404).json({ error: "Not found" });

  if (!DECISION_ALLOWED_STATUSES.has(record.status)) {
    return res.status(409).json({ error: `Cannot record a decision while the run is ${record.status}` });
  }

  const body = req.body as z.infer<typeof decisionSchema>;
  if (body.verdict === "other") {
    if (!body.driverId) return res.status(400).json({ error: "driverId is required for verdict \"other\"" });
    const driver = await prisma.driver.findUnique({ where: { id: body.driverId }, select: { id: true, orgId: true } });
    if (!driver || driver.orgId !== record.orgId) {
      return res.status(400).json({ error: "driverId does not exist in this organization" });
    }
  }

  const humanDecision = {
    verdict: body.verdict,
    driverId: body.driverId ?? null,
    note: body.note ?? null,
    byDispatcherId: req.auth?.dispatcherId ?? null,
  };

  const updated = await prisma.aiDecisionRecord.update({
    where: { id: record.id },
    data: { humanDecision, decidedAt: new Date() },
  });

  const driverNames = await fetchDriverNames(allReferencedDriverIds(updated), updated.orgId);
  const scenarios = await fetchScenarios([updated.loadId], updated.orgId);

  res.json({ run: toRunDetail(updated, driverNames, scenarios) });
}));

dispatcherAiRunsRouter.post("/runs/:id/replay", asyncRoute(async (req, res) => {
  const record = await prisma.aiDecisionRecord.findUnique({ where: { id: req.params.id as string } });
  if (!record || outsideOrg(req, record.orgId)) return res.status(404).json({ error: "Not found" });

  if (record.status === "queued" || record.status === "running") {
    return res.status(409).json({ error: `Cannot replay while the run is ${record.status}` });
  }
  if (!record.loadId) return res.status(400).json({ error: "This run has no load to replay" });

  const result = await enqueueRun({
    orgId: record.orgId,
    experimentId: record.experimentId,
    loadId: record.loadId,
    requestedById: req.auth?.dispatcherId ?? null,
    parentRunId: record.id,
  });

  if ("error" in result) {
    const status = queueErrorStatus(result.error);
    return res.status(status).json({ error: status === 429 ? "QUEUE_FULL" : "Not found" });
  }
  res.status(202).json({ runId: result.runId });
}));
