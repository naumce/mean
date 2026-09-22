import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { issueKey } from "../lib/apiKeys.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Night Shift API key management (Task 5, spec §10/§12) — session-only.
// A key itself can never reach these routes: they are not on
// middleware/apiKeyAuth.ts's ALLOWED list, so apiKeyAllowList 401s an
// x-api-key caller here the same as any other route it does not need.
// Mounted under dispatcherRouter with attachOrgScope (app.ts), same as
// dispatcherNightShiftRouter.
export const dispatcherApiKeysRouter = Router();

const NO_ORG = "Night Shift API keys require an org-scoped dispatcher account";
const KEY_NOT_FOUND = "API key not found";

dispatcherApiKeysRouter.get("/night-shift/api-keys", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const keys = await prisma.orgApiKey.findMany({
    where: { orgId, role: "nightshift" },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, revokedAt: true },
  });
  res.json({ keys });
}));

const createSchema = z.object({ name: z.string().min(1).max(80) });

dispatcherApiKeysRouter.post("/night-shift/api-keys", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
  // The raw key is returned here and ONLY here (spec: "shown once") — the
  // GET above never sees anything but the prefix, and nothing in this file
  // persists the raw value anywhere issueKey itself does not already hash.
  const { key, record } = await issueKey(orgId, parsed.data.name);
  res.status(201).json({ key, id: record.id, prefix: record.prefix });
}));

dispatcherApiKeysRouter.delete("/night-shift/api-keys/:id", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const existing = await prisma.orgApiKey.findUnique({ where: { id: req.params.id as string } });
  // 404, never 403: another org's key id must read exactly like one that
  // does not exist (Global Constraint).
  if (!existing || outsideOrg(req, existing.orgId)) return res.status(404).json({ error: KEY_NOT_FOUND });
  if (existing.revokedAt === null) {
    await prisma.orgApiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  }
  res.status(204).end();
}));
