import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { parseCsv } from "../lib/csv.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere, outsideCallerOrg } from "../middleware/orgScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Rest-stop CRUD + CSV import for the dispatcher portal (T3 Break and Rest
// Planning, Task 6). Mounted (without its own prefix) at /api/dispatcher
// behind requireAuth + requireDispatcher + attachOrgScope — see app.ts's
// single structural gate. Follows dispatcherCarriers.ts exactly for auth, org
// scoping and the 404-not-403 shape: a cross-tenant id reads as 404, never
// 403 (403 would confirm the row exists — the same leak by another name).
//
// RestStop.orgId is NOT nullable (prisma/schema.prisma), same as Carrier —
// there is no "unscoped/pool" rest stop, so writing one requires an
// org-scoped dispatcher account.
//
// Global Constraint 1 ("absent must never render as measured") is this
// router's other load-bearing invariant: `spaces` is nullable with no
// @default, so an omitted value must reach Prisma as an omitted key (not an
// explicit 0) to persist as NULL. See the `spaces` handling below and in the
// CSV row schema — both paths must preserve the omitted/null distinction.
export const dispatcherRestStopsRouter = Router();

const REST_STOP_KINDS = ["truck_stop", "rest_area", "yard", "customer"] as const;

const restStopSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(REST_STOP_KINDS),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // NULL means "capacity unknown", 0 means "known to have no parking" — the
  // two must never collapse into each other. `.nullable().optional()` lets
  // Zod's parsed output distinguish "explicit null" (persists as NULL) from
  // "key omitted" (also persists as NULL, via Prisma's own
  // omitted-key-means-untouched/unset rule) from "a real number".
  spaces: z.number().int().min(0).max(5000).nullable().optional(),
  amenities: z.array(z.string().max(40)).max(20).default([]),
});

dispatcherRestStopsRouter.get("/rest-stops", asyncRoute(async (req, res) => {
  const stops = await prisma.restStop.findMany({ where: orgWhere(req), orderBy: { name: "asc" } });
  res.json(stops);
}));

dispatcherRestStopsRouter.post("/rest-stops", validateBody(restStopSchema), asyncRoute(async (req, res) => {
  if (!req.orgScope) {
    return res.status(400).json({ error: "Rest stops require an org-scoped dispatcher account" });
  }
  const body = req.body as z.infer<typeof restStopSchema>;
  const stop = await prisma.restStop.create({ data: { ...body, orgId: req.orgScope, source: "import" } });
  res.status(201).json(stop);
}));

dispatcherRestStopsRouter.delete("/rest-stops/:id", asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.restStop.findUnique({ where: { id }, select: { orgId: true } });
  // outsideCallerOrg 404s a cross-tenant id instead of 403ing it — see the
  // file header and Global Constraint 4.
  if (!existing || outsideCallerOrg(req, existing.orgId)) {
    return res.status(404).json({ error: "Rest stop not found" });
  }
  await prisma.restStop.delete({ where: { id } });
  res.status(204).end();
}));

// --- CSV import --------------------------------------------------------------

const MAX_IMPORT_ROWS = 2000;

interface RowError {
  row: number;
  error: string;
}

// parseCsv (lib/csv.ts) hands back every field as a string, so lat/lng/spaces
// need explicit coercion — and, critically, explicit REJECTION when they
// aren't actually numbers. `Number("")` is 0 and `Number("abc")` is NaN;
// neither is safe to pass straight to z.coerce.number(), which would turn a
// blank lat cell into a "valid" 0° latitude instead of refusing the row. This
// preprocessor maps blank -> undefined (required fields then fail as
// "missing"; the optional `spaces` field passes through as omitted, which is
// exactly the "unknown capacity" case) and any other unparsable string ->
// NaN, which z.number() rejects on its own (it treats NaN as invalid,
// unlike z.coerce.number() fed a non-numeric string that silently coerces).
const numberFromCsv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, schema);

// Amenities arrive as one CSV cell; a cell that itself contains commas must
// be quoted by the author (RFC-4180, same as `name`) for parseCsv to keep it
// intact as a single string here — this just splits that string back out.
const amenitiesFromCsv = z.preprocess((v) => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
}, z.array(z.string().max(40)).max(20).default([]));

const restStopCsvRowSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(REST_STOP_KINDS),
  lat: numberFromCsv(z.number().min(-90).max(90)),
  lng: numberFromCsv(z.number().min(-180).max(180)),
  // `.nullable().optional()` MUST be inside numberFromCsv's argument, not
  // chained after it: wrapping outside would make Zod check the RAW value
  // for undefined-ness (still the string "") before the preprocessor ever
  // runs, so a blank cell would hit z.number()'s "Required" error instead of
  // reaching the optional/nullable path at all.
  spaces: numberFromCsv(z.number().int().min(0).max(5000).nullable().optional()),
  amenities: amenitiesFromCsv,
});

const importBodySchema = z.object({ csv: z.string().min(1) });

dispatcherRestStopsRouter.post("/rest-stops/import", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Import requires an org-scoped dispatcher account" });

  const parsedBody = importBodySchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: 'Provide {csv: "..."}' });

  const rows = parseCsv(parsedBody.data.csv);
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ error: `Too many rows: ${rows.length} (max ${MAX_IMPORT_ROWS} per call)` });
  }

  const errors: RowError[] = [];
  let imported = 0;

  for (const [i, raw] of rows.entries()) {
    const parsed = restStopCsvRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      continue;
    }
    try {
      await prisma.restStop.create({ data: { ...parsed.data, orgId, source: "import" } });
      imported++;
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : "import failed" });
    }
  }

  res.status(errors.length && imported === 0 ? 422 : 200).json({ imported, errors });
}));
