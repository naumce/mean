import { randomBytes } from "node:crypto";
import { Router } from "express";
import { prisma } from "../db.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Integrations management (org-scoped): the webhook API key a TMS uses to
// push loads at /api/webhooks/loads. GET reads it, POST generates or rotates
// it — rotation invalidates the old key immediately.
export const dispatcherIntegrationsRouter = Router();

const WEBHOOK_PATH = "/api/webhooks/loads";

dispatcherIntegrationsRouter.get("/integrations/webhook-key", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Integrations require an org-scoped dispatcher account" });
  const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId }, select: { apiKey: true } });
  res.json({ apiKey: org.apiKey, url: WEBHOOK_PATH });
}));

dispatcherIntegrationsRouter.post("/integrations/webhook-key", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Integrations require an org-scoped dispatcher account" });
  const apiKey = `whk_${randomBytes(24).toString("base64url")}`;
  await prisma.org.update({ where: { id: orgId }, data: { apiKey } });
  res.status(201).json({ apiKey, url: WEBHOOK_PATH });
}));
