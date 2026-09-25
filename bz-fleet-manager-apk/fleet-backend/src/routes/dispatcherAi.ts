import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AiExperiment } from "@prisma/client";
import { prisma } from "../db.js";
import { orgWhere, outsideOrg } from "../middleware/orgScope.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import {
  DEFAULT_HARNESS_CONFIG,
  harnessConfigSchema,
  harnessEnabled,
  ollamaBaseUrl,
  resolveHarnessConfig,
  type HarnessConfig,
} from "../lib/aiHarness/config.js";
import { checkOllama } from "../lib/aiHarness/ollamaAdapter.js";
import { runnerState } from "../lib/aiHarness/runner.js";
import { DISPATCH_PROMPT_V1 } from "../lib/aiHarness/prompts/dispatch-v1.js";
import { getUncoveredLoads, type LoadDetail } from "../lib/dispatchTools/loads.js";
import { cityStateFromAddress } from "../lib/driverAvailability.js";
import { scenarioOf, toRunSummaries } from "../lib/aiHarness/runView.js";
import { dispatcherAiRunsRouter } from "./dispatcherAiRuns.js";

// routes/dispatcherAi.ts (Qwen Harness v0.1, Task 6): the AI Lab's developer
// console — experiments CRUD, the Ollama/queue status panel, and the
// uncovered-loads picker. Run lifecycle routes (enqueue/list/detail/cancel/
// decision/replay/evaluation) live in dispatcherAiRuns.ts, mounted onto the
// same /ai-gated sub-router below, purely to keep both files under the
// project's own file-size convention — there is no functional split between
// them beyond that.
//
// Every route here sits behind the SAME structural gate every other
// dispatcher router does (requireAuth, requireDispatcher, attachOrgScope —
// app.ts's one mount for the whole /api/dispatcher surface) PLUS one more,
// local to this feature: the whole /ai/* surface 404s outright unless
// harnessEnabled() (OLLAMA_URL is set), checked per request rather than once
// at startup so a test (or a real deploy) can flip it without a restart.
export const dispatcherAiRouter = Router();

function requireHarnessEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!harnessEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

const aiRouter = Router();
aiRouter.use(requireHarnessEnabled);

/** Fetches an AiExperiment and applies the cross-tenant 404 in one place —
 *  the same ownedCustomer/ownedCarrier convention this codebase already uses
 *  for a single-resource-by-id route. Duplicated (not exported) in
 *  dispatcherAiRuns.ts rather than shared: sharing it would need that file
 *  and this one to import from each other, and dispatcherAiRuns.ts already
 *  imports THIS router — a cycle for the sake of one four-line function. */
async function ownedExperiment(req: { orgScope?: string | null }, id: string): Promise<AiExperiment | null> {
  const experiment = await prisma.aiExperiment.findUnique({ where: { id } });
  if (!experiment || outsideOrg(req, experiment.orgId)) return null;
  return experiment;
}

function toExperimentDto(row: AiExperiment, runCount = 0, lastRunAt: Date | null = null) {
  const config = resolveHarnessConfig(row.config);
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    status: row.status,
    model: config.model,
    promptVersion: row.promptVersion,
    config,
    createdAt: row.createdAt.toISOString(),
    runCount,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
  };
}

aiRouter.get("/status", asyncRoute(async (req, res) => {
  const ollama = await checkOllama(ollamaBaseUrl(), DEFAULT_HARNESS_CONFIG.model);
  // An unscoped (legacy/dev) dispatcher has no single org whose queue could
  // be shown — the same "nothing meaningful to report" call as
  // uncovered-loads below, rather than picking an arbitrary org.
  const orgId = req.orgScope ?? null;
  res.json({
    enabled: true,
    ollama,
    defaults: DEFAULT_HARNESS_CONFIG,
    promptVersions: [DISPATCH_PROMPT_V1.version],
    queue: orgId ? runnerState(orgId) : { running: null, queued: [] },
  });
}));

function toUncoveredLoad(load: LoadDetail) {
  const first = load.stops[0];
  const last = load.stops[load.stops.length - 1];
  return {
    id: load.id,
    externalId: load.externalId,
    customerName: load.customerName,
    scenario: scenarioOf(load.extras),
    requiredEquip: load.requiredEquip,
    pickupWindowStart: first?.appointment?.windowStart?.toISOString() ?? null,
    pickupWindowEnd: first?.appointment?.windowEnd?.toISOString() ?? null,
    originCity: first ? cityStateFromAddress(first.address).city : null,
    destCity: last ? cityStateFromAddress(last.address).city : null,
  };
}

aiRouter.get("/uncovered-loads", asyncRoute(async (req, res) => {
  const orgId = req.orgScope ?? null;
  if (!orgId) return res.json({ loads: [] });
  const loads = await getUncoveredLoads(orgId);
  res.json({ loads: loads.map(toUncoveredLoad) });
}));

aiRouter.get("/experiments", asyncRoute(async (req, res) => {
  const rows = await prisma.aiExperiment.findMany({ where: { ...orgWhere(req) }, orderBy: { createdAt: "desc" } });
  if (rows.length === 0) return res.json({ experiments: [] });

  const ids = rows.map((r) => r.id);
  const stats = await prisma.aiDecisionRecord.groupBy({
    by: ["experimentId"],
    where: { experimentId: { in: ids } },
    _count: { _all: true },
    _max: { proposedAt: true },
  });
  const statsByExperiment = new Map(stats.map((s) => [s.experimentId, s]));

  res.json({
    experiments: rows.map((r) => {
      const stat = statsByExperiment.get(r.id);
      return toExperimentDto(r, stat?._count._all ?? 0, stat?._max.proposedAt ?? null);
    }),
  });
}));

const createExperimentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  notes: z.string().max(2000).optional(),
  config: harnessConfigSchema.optional(),
});

aiRouter.post("/experiments", validateBody(createExperimentSchema), asyncRoute(async (req, res) => {
  // AiExperiment.orgId is required (not nullable) — same rule as POST
  // /customers: an unscoped (legacy/dev) dispatcher has no org to create one
  // under at all.
  if (!req.orgScope) {
    return res.status(400).json({ error: "AI experiments require an org-scoped dispatcher account" });
  }
  const orgId = req.orgScope;
  const body = req.body as z.infer<typeof createExperimentSchema>;
  const config: Partial<HarnessConfig> = body.config ?? {};
  const resolved = resolveHarnessConfig(config);

  const experiment = await prisma.aiExperiment.create({
    data: {
      orgId,
      name: body.name,
      notes: body.notes ?? null,
      model: resolved.model,
      config,
      createdById: req.auth?.dispatcherId ?? null,
    },
  });

  res.status(201).json({ experiment: toExperimentDto(experiment) });
}));

aiRouter.get("/experiments/:id", asyncRoute(async (req, res) => {
  const experiment = await ownedExperiment(req, req.params.id as string);
  if (!experiment) return res.status(404).json({ error: "Not found" });

  const [runCount, lastRun, records] = await Promise.all([
    prisma.aiDecisionRecord.count({ where: { experimentId: experiment.id } }),
    prisma.aiDecisionRecord.findFirst({
      where: { experimentId: experiment.id },
      orderBy: { proposedAt: "desc" },
      select: { proposedAt: true },
    }),
    prisma.aiDecisionRecord.findMany({
      where: { experimentId: experiment.id },
      orderBy: { proposedAt: "desc" },
      take: 100,
    }),
  ]);

  res.json({
    experiment: toExperimentDto(experiment, runCount, lastRun?.proposedAt ?? null),
    runs: await toRunSummaries(records, experiment.orgId),
  });
}));

const updateExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    notes: z.string().max(2000).optional(),
    status: z.enum(["active", "archived"]).optional(),
    config: harnessConfigSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

aiRouter.patch("/experiments/:id", validateBody(updateExperimentSchema), asyncRoute(async (req, res) => {
  const experiment = await ownedExperiment(req, req.params.id as string);
  if (!experiment) return res.status(404).json({ error: "Not found" });

  const body = req.body as z.infer<typeof updateExperimentSchema>;
  const storedConfig = experiment.config as unknown as Partial<HarnessConfig>;
  const mergedConfig = body.config ? { ...storedConfig, ...body.config } : storedConfig;
  const resolved = resolveHarnessConfig(mergedConfig);

  const updated = await prisma.aiExperiment.update({
    where: { id: experiment.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.config !== undefined ? { config: mergedConfig, model: resolved.model } : {}),
    },
  });

  const [runCount, lastRun] = await Promise.all([
    prisma.aiDecisionRecord.count({ where: { experimentId: updated.id } }),
    prisma.aiDecisionRecord.findFirst({
      where: { experimentId: updated.id },
      orderBy: { proposedAt: "desc" },
      select: { proposedAt: true },
    }),
  ]);

  res.json({ experiment: toExperimentDto(updated, runCount, lastRun?.proposedAt ?? null) });
}));

aiRouter.use(dispatcherAiRunsRouter);

dispatcherAiRouter.use("/ai", aiRouter);
