import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { parseCsv } from "../lib/csv.js";
import { isUsStateCode } from "../lib/stateOf.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere, outsideCallerOrg } from "../middleware/orgScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Fuel-price CRUD + CSV import for the dispatcher portal (T4 Fuel and Stops,
// Task 6). Mounted (without its own prefix) at /api/dispatcher behind
// requireAuth + requireDispatcher + attachOrgScope — see app.ts's single
// structural gate. Copied from dispatcherRestStops.ts (T3 Task 6) for
// structure: same auth, same org scoping, same 404-not-403 shape. A
// cross-tenant id reads as 404, never 403 (Global Constraint 4 — 403 would
// confirm the row exists, the same leak by another name).
//
// FuelPrice.orgId is NOT nullable (prisma/schema.prisma), same as RestStop —
// there is no unscoped/pool price, so writing one requires an org-scoped
// dispatcher account.
//
// This table is NOT the costing assumption (Global Constraint 5).
// RateConfig.dieselCentsPerGal still prices every margin and every committed
// Rate snapshot; nothing in this router touches that. FuelPrice only answers
// "where should the driver buy", and feeds advice, never margin.
export const dispatcherFuelPricesRouter = Router();

// Real diesel has never priced anywhere near this even during the worst
// spikes on record — it exists purely to catch a fat-fingered entry (typing
// dollars into a cents field, an extra digit) rather than to model a
// plausible ceiling.
const CENTS_PER_GAL_MAX = 2000;

const stateCodeSchema = z.string().refine(isUsStateCode, {
  message: "state must be a valid two-letter US state code",
});

// FuelPrice.effectiveOn is a DAY ("the day this price was observed" —
// schema.prisma), not an instant, and the GET resolver below compares it
// against "today" as a UTC-midnight boundary. Both the JSON body and the CSV
// row share this one definition so a price entered either way lands on the
// exact same boundary: z.coerce.date() parses the string and rejects
// anything that isn't a real date (blank included — `new Date("")` is
// Invalid, which coerce.date() checks for), then the transform floors
// whatever time-of-day it parsed to to UTC midnight, so a caller who sends a
// full timestamp still lands on the same day-grid as one who sends a bare
// "YYYY-MM-DD".
const effectiveOnSchema = z.coerce.date().transform(
  (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
);

const fuelPriceSchema = z.object({
  state: stateCodeSchema,
  centsPerGal: z.number().int().positive().max(CENTS_PER_GAL_MAX),
  effectiveOn: effectiveOnSchema,
});

/** UTC-midnight "today" — the boundary the GET resolver below filters
 *  against. Every persisted effectiveOn is already floored to UTC midnight
 *  (effectiveOnSchema above), so a row dated "today" compares equal to this,
 *  and a row dated "tomorrow" compares greater — no end-of-day fudge needed. */
function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

dispatcherFuelPricesRouter.get("/fuel-prices", asyncRoute(async (req, res) => {
  const stateParam = typeof req.query.state === "string" ? req.query.state : undefined;

  if (stateParam !== undefined) {
    if (!isUsStateCode(stateParam)) {
      return res.status(400).json({ error: "state must be a valid two-letter US state code" });
    }
    // The one question this table answers for a single state: "what should
    // the driver pay today". The naive wrong answers this guards against —
    // both plausible-looking, both wrong — are `orderBy: { createdAt: "desc" }`
    // (picks whichever row was entered most recently, regardless of which day
    // it prices) and `orderBy: { effectiveOn: "desc" }` with no upper bound
    // (picks a future-dated row a dispatcher pre-entered for next week, and
    // answers "today" with a price that isn't in effect yet). The `lte`
    // filter plus ordering by effectiveOn itself is the only combination that
    // is right on both counts.
    const current = await prisma.fuelPrice.findFirst({
      where: { ...orgWhere(req), state: stateParam, effectiveOn: { lte: todayUtcMidnight() } },
      orderBy: { effectiveOn: "desc" },
    });
    // No error, no empty array standing in for "unpriced" — `null` is the
    // literal, unambiguous "we do not have a current price for this state"
    // answer (Global Constraint 1: absent must never render as measured).
    return res.json(current);
  }

  const prices = await prisma.fuelPrice.findMany({
    where: orgWhere(req),
    orderBy: [{ state: "asc" }, { effectiveOn: "desc" }],
  });
  res.json(prices);
}));

dispatcherFuelPricesRouter.post("/fuel-prices", validateBody(fuelPriceSchema), asyncRoute(async (req, res) => {
  if (!req.orgScope) {
    return res.status(400).json({ error: "Fuel prices require an org-scoped dispatcher account" });
  }
  const body = req.body as z.infer<typeof fuelPriceSchema>;
  try {
    const price = await prisma.fuelPrice.create({ data: { ...body, orgId: req.orgScope, source: "import" } });
    res.status(201).json(price);
  } catch (err) {
    // @@unique([orgId, state, effectiveOn]) — one observed price per state
    // per day per org. Caught explicitly: Express 4 never awaits an async
    // handler, so an uncaught rejection here would leave the caller with NO
    // response at all, not even a 500 (src/lib/processGuards.ts) — the exact
    // failure mode this codebase has already been bitten by on other unique
    // constraints (see dispatcherAuth.ts's P2002 handling).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "A price for this state and date already exists" });
    }
    throw err;
  }
}));

dispatcherFuelPricesRouter.delete("/fuel-prices/:id", asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.fuelPrice.findUnique({ where: { id }, select: { orgId: true } });
  // outsideCallerOrg 404s a cross-tenant id instead of 403ing it — see the
  // file header and Global Constraint 4.
  if (!existing || outsideCallerOrg(req, existing.orgId)) {
    return res.status(404).json({ error: "Fuel price not found" });
  }
  await prisma.fuelPrice.delete({ where: { id } });
  res.status(204).end();
}));

// --- CSV import --------------------------------------------------------------

const MAX_IMPORT_ROWS = 2000;

interface RowError {
  row: number;
  error: string;
}

// parseCsv (lib/csv.ts) hands back every field as a string, so centsPerGal
// needs explicit coercion — and, critically, explicit REJECTION when it
// isn't actually a number. `Number("")` is 0 and `Number("abc")` is NaN;
// neither is safe to pass straight to z.coerce.number(), which would turn a
// blank cell into a "valid" 0-cent price instead of refusing the row. This
// preprocessor (copied from dispatcherRestStops.ts's numberFromCsv, same
// reasoning) maps blank -> undefined (so the required field fails as
// "missing") and any other unparsable string -> NaN, which z.number()
// rejects on its own — unlike z.coerce.number() fed a non-numeric string,
// which would silently coerce it.
const numberFromCsv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, schema);

const fuelPriceCsvRowSchema = z.object({
  state: stateCodeSchema,
  centsPerGal: numberFromCsv(z.number().int().positive().max(CENTS_PER_GAL_MAX)),
  // effectiveOnSchema's z.coerce.date() already rejects a blank cell (an
  // empty string is not a parseable date) and any other unparsable string,
  // so — unlike centsPerGal above — no extra CSV-specific preprocessing is
  // needed here; one definition serves the JSON body and the CSV row alike.
  effectiveOn: effectiveOnSchema,
});

const importBodySchema = z.object({ csv: z.string().min(1) });

dispatcherFuelPricesRouter.post("/fuel-prices/import", asyncRoute(async (req, res) => {
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
    const parsed = fuelPriceCsvRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      continue;
    }
    try {
      await prisma.fuelPrice.create({ data: { ...parsed.data, orgId, source: "import" } });
      imported++;
    } catch (err) {
      // Same P2002-can-hang-the-request hazard as the single-create route
      // above, folded into the per-row error report instead of a 409: a
      // duplicate (state, effectiveOn) row in a batch is just one more bad
      // row, not a reason to fail rows that parsed and inserted fine.
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : "import failed" });
    }
  }

  res.status(errors.length && imported === 0 ? 422 : 200).json({ imported, errors });
}));
