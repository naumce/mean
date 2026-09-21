import { Router } from "express";
import { prisma } from "../db.js";
import { MAX_ROWS_PER_CALL, auditIngestBatch, ingestLoadRows } from "../lib/loadIngest.js";
import { emitLoadsChanged } from "../lib/loadEvents.js";
import { webhookLimiters } from "../middleware/rateLimit.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Public push ingest: a TMS posts loads continuously instead of a dispatcher
// pasting CSVs. Auth is the org's x-api-key (generated on the Integrations
// card); everything lands in that org and fans load_changed out to its
// dispatchers. Accepts one load object, a bare array, or {loads:[...]}.
export const webhooksRouter = Router();

function extractLoads(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body)) return body.length ? (body as Record<string, unknown>[]) : null;
  if (body && typeof body === "object") {
    const wrapped = (body as { loads?: unknown }).loads;
    if (Array.isArray(wrapped)) return wrapped.length ? (wrapped as Record<string, unknown>[]) : null;
    if (wrapped === undefined && Object.keys(body).length > 0) return [body as Record<string, unknown>];
  }
  return null;
}

webhooksRouter.post("/loads", ...webhookLimiters(), asyncRoute(async (req, res) => {
  const key = req.header("x-api-key");
  if (!key) return res.status(401).json({ error: "Missing x-api-key header" });
  const org = await prisma.org.findUnique({ where: { apiKey: key } });
  if (!org) return res.status(401).json({ error: "Invalid API key" });

  const rows = extractLoads(req.body);
  if (!rows) return res.status(400).json({ error: "Provide a load object, an array of loads, or {loads:[...]}" });
  if (rows.length > MAX_ROWS_PER_CALL)
    return res.status(400).json({ error: `Too many rows: ${rows.length} (max ${MAX_ROWS_PER_CALL} per call)` });

  const { imported, errors, touched } = await ingestLoadRows(org.id, rows);
  const batchId = await auditIngestBatch(org.id, "webhook", "loads", imported, errors);
  // A4 Task 1 / L8: this ingestion writes LoadStop/Load rows directly (never
  // through applyLoadChange — see lib/loadIngest.ts), so there is no writer
  // `changed` list to report the way the board routes do — but loadIngest.ts
  // now computes its own diff (`fieldsChanged`/`stopChanged`) for exactly
  // this reason. "created" for a brand-new row; the real field names
  // (`fields.ts`'s SCALAR_KEYS, plus "pickup"/"delivery" for a stop this push
  // rewrote) for an existing one a re-push actually changed — never the
  // "imported" sentinel, which is outside `loadEvents.ts`'s documented
  // vocabulary and told the Cockpit's activity feed nothing about what moved.
  emitLoadsChanged(org.id, touched.map((t) => ({ loadId: t.loadId, version: t.version, fields: t.fields })));
  res.status(errors.length && imported === 0 ? 422 : 200).json({ batchId, imported, errors });
}));
