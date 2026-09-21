import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { seal, open } from "../lib/secretBox.js";
import { consentUrl, exchangeCode, clientFor } from "../lib/sheet/googleAuth.js";
import { replyGoogleError } from "../lib/sheet/googleError.js";
import { connectorFor } from "../lib/sheet/connectorFor.js";
import { proposeSheetMapping, validateMapping, SHEET_COLUMN_KEYS, type SheetMapping } from "../lib/sheet/mapping.js";
import { layoutFromMapping } from "../lib/sheet/layoutFromMapping.js";
import { saveLayout } from "../lib/boardLayout.js";
import { installAgentColumns } from "../lib/sheet/installColumns.js";
import { syncBinding } from "../lib/sheet/sync.js";

// Night Shift sheet slices (task 7, spec §5): connect a Google Sheet, pick
// its tab and header row, confirm a column mapping, and hold the resulting
// binding. Mounted under dispatcherRouter with attachOrgScope (app.ts),
// after dispatcherNightShiftRouter — every route here follows that router's
// org-scoping and 404-not-403 conventions (outsideOrg, actorOf are not
// needed here: nothing writes an actor-attributed change, only the binding
// itself).
//
// ONE exception: `/sheet/oauth/callback` is Google redirecting a bare
// browser — it carries no bearer token at all, so it CANNOT sit behind this
// router's normal mount (which app.ts puts behind requireAuth +
// requireDispatcher + attachOrgScope). `sheetOauthCallback` below is
// exported separately and mounted by app.ts as its own `app.get(...)`,
// ABOVE the "/api/dispatcher" gate, wrapped in asyncRoute exactly like every
// other handler here (tests/no-silent-hang.test.ts scans src/routes as a
// whole file, not just this router's own registrations).
export const dispatcherSheetRouter = Router();

const NO_ORG = "Sheet connect requires an org-scoped dispatcher account";
const NOT_CONNECTED = "No sheet is connected for this org";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const validationMessage = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

// Never selects refreshToken — the sealed token must not leave this process
// in a response body (Global Constraint), the same explicit-select pattern
// dispatcherAuth.ts's /auth/me uses for its own sensitive columns.
const SAFE_BINDING_SELECT = {
  id: true, orgId: true, provider: true, spreadsheetId: true, spreadsheetTitle: true, tabId: true,
  tabTitle: true, headerRow: true, columns: true, agentSwitchCol: true,
  agentStatusCol: true, accountEmail: true, lastVersion: true, lastSyncAt: true,
  lastError: true, status: true, createdAt: true, updatedAt: true,
} satisfies Prisma.SheetBindingSelect;

type SafeBinding = Prisma.SheetBindingGetPayload<{ select: typeof SAFE_BINDING_SELECT }>;

/** Full row (token included, for internal use only — never sent in a
 *  response) for whichever binding currently "speaks for" this org: a
 *  connected one if there is any, else a pending one (status "paused",
 *  spreadsheetId/tabId ""), else null. A pending row is what oauth/callback
 *  leaves behind before the dispatcher has picked a spreadsheet/tab, and it
 *  is the only row that can supply a connector during that window. */
async function activeBindingFor(orgId: string) {
  const rows = await prisma.sheetBinding.findMany({ where: { orgId }, orderBy: { updatedAt: "desc" } });
  return rows.find((b) => b.status !== "paused") ?? rows[0] ?? null;
}

// --- OAuth ----------------------------------------------------------------

dispatcherSheetRouter.get("/sheet/oauth/start", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const dispatcherId = req.auth?.dispatcherId ?? null;
  const state = seal(JSON.stringify({ orgId, dispatcherId, at: Date.now() }));
  res.json({ url: consentUrl(state) });
}));

interface OAuthState {
  orgId: string;
  dispatcherId: string | null;
  at: number;
}

function isOAuthState(v: unknown): v is OAuthState {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { orgId?: unknown }).orgId === "string" &&
    typeof (v as { at?: unknown }).at === "number" &&
    (typeof (v as { dispatcherId?: unknown }).dispatcherId === "string" || (v as { dispatcherId?: unknown }).dispatcherId === null)
  );
}

/** Not mounted on `dispatcherSheetRouter` — see the comment at the top of
 *  this file. Google redirects the browser here with no Authorization
 *  header, so this is the one handler in the whole sheet feature that trusts
 *  its own sealed `state` instead of `req.orgScope`.
 *
 *  Named function expression, not an anonymous arrow — `no-silent-hang.test.ts`
 *  cannot pattern-match this handler the way it matches every other
 *  `async (req...) =>` route (its regex deliberately excludes named-function
 *  handlers; see that file's comment on `attachOrgScope`), so it instead pins
 *  this one specifically by asserting the exported source is wrapped in
 *  `asyncRoute(async function sheetOauthCallback(...))`.
 *
 *  Exported via an alias (`export { sheetOauthCallbackHandler as
 *  sheetOauthCallback }`), not `export const sheetOauthCallback =
 *  asyncRoute(async function sheetOauthCallback ...)`, for the exact reason
 *  `orgScope.ts` documents for `attachOrgScope`: under vitest's esbuild-based
 *  SSR transform, a top-level `const`/`export const` binding whose name
 *  textually matches a nested named-function-expression's own name gets
 *  silently renamed ("sheetOauthCallback" -> "sheetOauthCallback2"), which
 *  would make the pinned test below pass or fail for the wrong reason. */
const sheetOauthCallbackHandler = asyncRoute(async function sheetOauthCallback(req, res) {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const rawState = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !rawState) return res.status(400).json({ error: "code and state are required" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(open(rawState));
  } catch {
    // A tampered/foreign state fails to `open` (secretBox authenticates the
    // ciphertext) or fails to parse — both read the same to the caller.
    return res.status(400).json({ error: "invalid state" });
  }
  if (!isOAuthState(parsed)) return res.status(400).json({ error: "invalid state" });
  if (Date.now() - parsed.at > STATE_MAX_AGE_MS) return res.status(400).json({ error: "state expired" });

  const { refreshToken, accountEmail } = await exchangeCode(code);
  const sealedToken = seal(refreshToken);

  // Pending binding: unique on [orgId, spreadsheetId "", tabId ""]. Holds the
  // sealed token until POST /mapping moves it onto the real spreadsheet/tab.
  await prisma.sheetBinding.upsert({
    where: { orgId_spreadsheetId_tabId: { orgId: parsed.orgId, spreadsheetId: "", tabId: "" } },
    create: {
      orgId: parsed.orgId, provider: "google", spreadsheetId: "", tabId: "", tabTitle: "",
      headerRow: 1, columns: {}, refreshToken: sealedToken, accountEmail, status: "paused",
    },
    update: {
      provider: "google", refreshToken: sealedToken, accountEmail, status: "paused",
      tabTitle: "", headerRow: 1, columns: {},
    },
  });

  res.redirect(302, `${process.env.PORTAL_URL}/night-shift?tab=connect&step=2`);
});
export { sheetOauthCallbackHandler as sheetOauthCallback };

// --- Opening one spreadsheet by id ---------------------------------------------
//
// Final fix wave, C1: there is no `GET /sheet/spreadsheets` — no Drive scope,
// no account-wide listing. The dispatcher pastes the sheet's link; the portal
// pulls the id out of it and asks here for the title and tabs.

/** A spreadsheet id, or a full Sheets URL it is pulled out of (residual
 *  fix 3) — the portal already extracts it, but the server tolerates the
 *  raw link too. A bare id passes through untouched. */
const spreadsheetIdField = z.string().min(1).transform((raw) => /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? raw);

const spreadsheetIdQuerySchema = z.object({ spreadsheetId: spreadsheetIdField });

dispatcherSheetRouter.get("/sheet/tabs", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsedQuery = spreadsheetIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: validationMessage(parsedQuery.error) });
  const binding = await activeBindingFor(orgId);
  if (!binding) return res.status(404).json({ error: NOT_CONNECTED });
  let info;
  try { info = await connectorFor(binding).spreadsheetInfo(parsedQuery.data.spreadsheetId); }
  catch (e) { if (replyGoogleError(res, e)) return; throw e; }
  const { title, tabs } = info;
  res.json({ title, tabs });
}));

const headerQuerySchema = z.object({
  spreadsheetId: spreadsheetIdField,
  tabId: z.string().min(1),
  headerRow: z.coerce.number().int().positive().optional().default(1),
});

dispatcherSheetRouter.get("/sheet/header", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsedQuery = headerQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: validationMessage(parsedQuery.error) });
  const binding = await activeBindingFor(orgId);
  if (!binding) return res.status(404).json({ error: NOT_CONNECTED });
  const { spreadsheetId, tabId, headerRow } = parsedQuery.data;
  let header: string[];
  try { header = await connectorFor(binding).readHeader({ spreadsheetId, tabId }, headerRow); }
  catch (e) { if (replyGoogleError(res, e)) return; throw e; }
  const proposal = proposeSheetMapping(header);
  res.json({ header, proposal });
}));

// --- Confirming the mapping --------------------------------------------------

// Rejects an unknown key at the boundary (e.g. a typo, or a stale client
// sending a key this version of `SheetColumnKey` no longer has) instead of
// silently letting it into a `SheetMapping` that `validateMapping`/
// `layoutFromMapping` were never written to expect.
const sheetMappingSchema = z.record(
  z.enum(SHEET_COLUMN_KEYS as [string, ...string[]]),
  z.string(),
) as z.ZodType<SheetMapping>;

const mappingBodySchema = z.object({
  spreadsheetId: spreadsheetIdField,
  tabId: z.string().min(1),
  tabTitle: z.string().min(1),
  headerRow: z.number().int().positive(),
  mapping: sheetMappingSchema,
});

dispatcherSheetRouter.post("/sheet/mapping", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsedBody = mappingBodySchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: validationMessage(parsedBody.error) });
  const { spreadsheetId, tabId, tabTitle, headerRow, mapping } = parsedBody.data;

  const pending = await activeBindingFor(orgId);
  if (!pending) return res.status(404).json({ error: NOT_CONNECTED });

  const connector = connectorFor(pending);
  let header: string[];
  try { header = await connector.readHeader({ spreadsheetId, tabId }, headerRow); }
  catch (e) { if (replyGoogleError(res, e)) return; throw e; }
  const validation = validateMapping(header, mapping);
  if (!validation.ok) return res.status(400).json({ error: validation.errors.join("; ") });
  // The spreadsheet's own title, read here rather than trusted from the
  // client (final fix wave, C1) — the summary card shows it.
  const { title: spreadsheetTitle } = await connector.spreadsheetInfo(spreadsheetId);

  const usedHeaders = new Set(Object.values(mapping));
  const extras = header.filter((h) => h.trim() && !usedHeaders.has(h));
  const columnsJson = mapping as unknown as Prisma.InputJsonValue;
  const layout = layoutFromMapping(mapping, extras);

  // Move the pending row (spreadsheetId "", tabId "") onto the real
  // spreadsheet/tab — the common case, since a fresh OAuth callback always
  // leaves exactly one pending row per org. A real binding for that exact
  // tab can already exist (re-running setup against a tab this org
  // connected, disconnected, and is reconnecting): that row is the one that
  // keeps living, updated with the new mapping and the pending row's fresh
  // token, and the now-redundant pending row is dropped.
  //
  // Look-before-write, not catch-a-P2002: fix round 1 tried
  // `tx.sheetBinding.update(...)` on the pending row first and only fell
  // back to updating the real row inside a `catch` on the unique-constraint
  // violation — but Postgres aborts the WHOLE transaction on any failed
  // statement, so every `tx.*` call issued after that catch was guaranteed
  // to fail with "current transaction is aborted" and the fallback path
  // could never actually succeed (fix round 2, code review). `findUnique`
  // first, then exactly one `update` (plus a `delete` in the reconnect
  // case), keeps every statement on `tx` a statement that is expected to
  // succeed.
  //
  // A race between this `findUnique` and its `update` (two dispatchers
  // promoting the same org's pending row at once) is accepted rather than
  // locked against: the loser's `update`/`delete` hits the real unique
  // constraint, Postgres aborts ITS transaction, and asyncRoute's `.catch`
  // turns that into a plain 500 — nothing half-written, just a request the
  // dispatcher can safely retry.
  //
  // The binding write(s) AND the BoardLayout save are one `$transaction`:
  // without it, a crash between "binding connected" and "layout saved" left
  // a connected binding with a stale/absent BoardLayout (fix round 1, code
  // review).
  //
  // Final fix wave, C4: the agent column indexes and the last version
  // describe ONE tab. When the binding moves to a different spreadsheet/tab
  // (the pending row's "" -> real promotion included) they are forgotten so
  // the sync never writes a status cell into a column index that belonged
  // to the previous tab; a same-tab re-map keeps them, and the sync's own
  // by-header-name lookup re-validates them every changed tick anyway.
  const bindingId = await prisma.$transaction(async (tx) => {
    const existing = await tx.sheetBinding.findUnique({
      where: { orgId_spreadsheetId_tabId: { orgId, spreadsheetId, tabId } },
      select: { id: true },
    });

    let id: string;
    if (existing && existing.id !== pending.id) {
      // Reconnecting a tab this org already has a (now-stale) binding for:
      // that row keeps its id, gains the new mapping and the pending row's
      // fresh credentials; the pending placeholder is no longer needed.
      const target = await tx.sheetBinding.update({
        where: { id: existing.id },
        data: {
          tabTitle, spreadsheetTitle, headerRow, columns: columnsJson, status: "connected",
          provider: pending.provider, refreshToken: pending.refreshToken, accountEmail: pending.accountEmail,
        },
        select: { id: true },
      });
      await tx.sheetBinding.delete({ where: { id: pending.id } });
      id = target.id;
    } else {
      const sameTab = pending.spreadsheetId === spreadsheetId && pending.tabId === tabId;
      const updated = await tx.sheetBinding.update({
        where: { id: pending.id },
        data: {
          spreadsheetId, tabId, tabTitle, spreadsheetTitle, headerRow, columns: columnsJson, status: "connected",
          ...(sameTab ? {} : { agentSwitchCol: null, agentStatusCol: null, lastVersion: null }),
        },
        select: { id: true },
      });
      id = updated.id;
    }
    await saveLayout(orgId, layout, tx);
    return id;
  });

  const binding: SafeBinding = await prisma.sheetBinding.findUniqueOrThrow({
    where: { id: bindingId },
    select: SAFE_BINDING_SELECT,
  });
  res.json({ binding });
}));

// --- Night Shift columns and sync (Task 9) -----------------------------------

dispatcherSheetRouter.post("/sheet/install", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const binding = await activeBindingFor(orgId);
  if (!binding || binding.status !== "connected") return res.status(404).json({ error: NOT_CONNECTED });

  await installAgentColumns(binding.id);
  const fresh: SafeBinding = await prisma.sheetBinding.findUniqueOrThrow({
    where: { id: binding.id }, select: SAFE_BINDING_SELECT,
  });
  res.json({ binding: fresh });
}));

dispatcherSheetRouter.post("/sheet/sync-now", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const binding = await activeBindingFor(orgId);
  if (!binding || binding.status !== "connected") return res.status(404).json({ error: NOT_CONNECTED });

  const report = await syncBinding(binding.id, { connector: connectorFor(binding), nowMs: Date.now });
  res.json({ report });
}));

// --- The binding itself ------------------------------------------------------

dispatcherSheetRouter.get("/sheet", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const rows: SafeBinding[] = await prisma.sheetBinding.findMany({
    where: { orgId }, select: SAFE_BINDING_SELECT, orderBy: { updatedAt: "desc" },
  });
  // A pending row is also `status: "paused"` — when both a pending and a
  // connected row exist for an org, the connected one is the real answer to
  // "what is this org's sheet".
  const binding = rows.find((b) => b.status !== "paused") ?? rows[0] ?? null;
  res.json({ binding });
}));

dispatcherSheetRouter.delete("/sheet", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const binding = await activeBindingFor(orgId);
  if (!binding) return res.status(404).json({ error: NOT_CONNECTED });

  if (binding.provider === "google" && binding.refreshToken) {
    try {
      const plainToken = open(binding.refreshToken);
      await clientFor(plainToken).revokeToken(plainToken);
    } catch (e) {
      // Revocation is best-effort — Google may already consider the grant
      // gone, or be unreachable — and must never block us from disconnecting
      // our own side. Logged, not raised.
      console.error("sheet binding: revokeToken failed", e);
    }
  }

  const updated: SafeBinding = await prisma.sheetBinding.update({
    where: { id: binding.id },
    data: { status: "paused", refreshToken: "" },
    select: SAFE_BINDING_SELECT,
  });
  res.json({ binding: updated });
}));
