import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { parseCsv } from "../lib/csv.js";
import { MAX_ROWS_PER_CALL, auditIngestBatch, ingestLoadRows } from "../lib/loadIngest.js";
import type { RowError } from "../lib/loadIngest.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The ingestion contract (Control Tower §5): the onboarding wedge is "connect
// your loads and see tomorrow's dispatch". Three entities — loads, drivers,
// hos — each accepting either JSON rows ({rows:[...]}, source=api) or pasted
// CSV ({csv:"..."}, source=csv). Every row is validated independently; good
// rows import, bad rows come back in a row-level error report; an ImportBatch
// row audits each call. Requires an org-scoped dispatcher — imports without a
// tenant would be unattributable.
export const dispatcherImportRouter = Router();

const bodySchema = z.union([
  z.object({ rows: z.array(z.record(z.unknown())).min(1) }),
  z.object({ csv: z.string().min(1) }),
]);

function extractRows(body: unknown): { rows: Record<string, unknown>[]; source: "api" | "csv" } | { error: string } | null {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return null;
  const out = "rows" in parsed.data
    ? { rows: parsed.data.rows, source: "api" as const }
    : { rows: parseCsv(parsed.data.csv), source: "csv" as const };
  if (out.rows.length > MAX_ROWS_PER_CALL)
    return { error: `Too many rows: ${out.rows.length} (max ${MAX_ROWS_PER_CALL} per call)` };
  return out;
}

// Audit + loads row logic live in lib/loadIngest.ts (shared with the public
// webhook route); drivers/hos remain local to this route.
const audit = auditIngestBatch;

const optionalNumber = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce.number().optional(),
);
// --- loads ------------------------------------------------------------------

dispatcherImportRouter.post("/import/loads", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Import requires an org-scoped dispatcher account" });
  const input = extractRows(req.body);
  if (!input) return res.status(400).json({ error: "Provide {rows:[...]} or {csv:\"...\"}" });
  if ("error" in input) return res.status(400).json({ error: input.error });

  const { imported, errors } = await ingestLoadRows(orgId, input.rows);
  const batchId = await audit(orgId, input.source, "loads", imported, errors);
  res.status(errors.length && imported === 0 ? 422 : 200).json({ batchId, imported, errors });
}));

// --- drivers (incl. position) ----------------------------------------------

const driverRowSchema = z.object({
  email: z.coerce.string().email(),
  name: z.coerce.string().min(1),
  externalId: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.string().optional()),
  phone: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.string().optional()),
  hazmatEndorsed: z.preprocess(
    (v) => (typeof v === "string" ? ["true", "1", "yes"].includes(v.toLowerCase()) : v),
    z.coerce.boolean().optional(),
  ),
  lat: optionalNumber,
  lng: optionalNumber,
});

// Imported drivers can't log in until a real password is set; bcrypt will
// never verify against this marker.
const IMPORTED_NO_LOGIN = "!imported-no-login!";

dispatcherImportRouter.post("/import/drivers", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Import requires an org-scoped dispatcher account" });
  const input = extractRows(req.body);
  if (!input) return res.status(400).json({ error: "Provide {rows:[...]} or {csv:\"...\"}" });
  if ("error" in input) return res.status(400).json({ error: input.error });

  const errors: RowError[] = [];
  let imported = 0;

  for (const [i, raw] of input.rows.entries()) {
    const parsed = driverRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      continue;
    }
    const row = parsed.data;
    try {
      const position =
        row.lat != null && row.lng != null
          ? { lastLat: row.lat, lastLng: row.lng, lastLocationAt: new Date() }
          : {};
      await prisma.driver.upsert({
        where: { email: row.email },
        update: {
          name: row.name, orgId, externalId: row.externalId, phone: row.phone,
          ...(row.hazmatEndorsed != null ? { hazmatEndorsed: row.hazmatEndorsed } : {}),
          ...position,
        },
        create: {
          email: row.email, name: row.name, orgId, externalId: row.externalId, phone: row.phone,
          hazmatEndorsed: row.hazmatEndorsed ?? false, passwordHash: IMPORTED_NO_LOGIN,
          ...position,
        },
      });
      imported++;
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : "import failed" });
    }
  }

  const batchId = await audit(orgId, input.source, "drivers", imported, errors);
  res.status(errors.length && imported === 0 ? 422 : 200).json({ batchId, imported, errors });
}));

// --- hos --------------------------------------------------------------------

const hosRowSchema = z.object({
  email: z.coerce.string().email(),
  driveRemainingMin: z.coerce.number().int().min(0).max(660),
  windowRemainingMin: z.coerce.number().int().min(0).max(840),
  cycleRemainingMin: z.coerce.number().int().min(0).max(4200),
  minutesSinceBreak: optionalNumber.pipe(z.number().int().min(0).optional()).default(0),
});

dispatcherImportRouter.post("/import/hos", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Import requires an org-scoped dispatcher account" });
  const input = extractRows(req.body);
  if (!input) return res.status(400).json({ error: "Provide {rows:[...]} or {csv:\"...\"}" });
  if ("error" in input) return res.status(400).json({ error: input.error });

  const errors: RowError[] = [];
  let imported = 0;

  for (const [i, raw] of input.rows.entries()) {
    const parsed = hosRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      continue;
    }
    const row = parsed.data;
    try {
      const driver = await prisma.driver.findFirst({ where: { email: row.email, orgId } });
      if (!driver) {
        errors.push({ row: i + 1, error: `no driver ${row.email} in this org` });
        continue;
      }
      const clocks = {
        driveRemainingMin: row.driveRemainingMin,
        windowRemainingMin: row.windowRemainingMin,
        cycleRemainingMin: row.cycleRemainingMin,
        minutesSinceBreak: row.minutesSinceBreak ?? 0,
        updatedAt: new Date(),
        // Real clock data arrived — this is the ONLY writer of importedAt
        // (commit-time planning decrements must never fake freshness).
        importedAt: new Date(),
      };
      await prisma.hosState.upsert({
        where: { driverId: driver.id },
        update: clocks,
        create: { driverId: driver.id, ...clocks },
      });
      imported++;
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : "import failed" });
    }
  }

  const batchId = await audit(orgId, input.source, "hos", imported, errors);
  res.status(errors.length && imported === 0 ? 422 : 200).json({ batchId, imported, errors });
}));
