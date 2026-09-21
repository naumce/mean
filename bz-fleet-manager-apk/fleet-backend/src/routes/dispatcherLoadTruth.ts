import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { actorOf } from "../lib/actor.js";
import { assertWritable, LoadLocked } from "../lib/loadLocks.js";
import { nextAtMs, rulesFor } from "../lib/loadWriter.js";
import { normalize } from "../lib/updateVocabulary.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { emitLoadChanged } from "../lib/loadEvents.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The org's words (spec §6.1), the trace (§5.2) and the undo (§6.4).
export const dispatcherLoadTruthRouter = Router();

const NO_ORG = "This requires an org-scoped dispatcher account";
const STATUSES = ["open", "assigned", "in_progress", "delivered", "canceled"] as const;
const rulesSchema = z.object({
  rules: z.array(z.object({ prefix: z.string().trim().min(1).max(40), status: z.enum(STATUSES), enabled: z.boolean().optional() })).max(100),
});

dispatcherLoadTruthRouter.get("/update-rules", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  // Seed the org's defaults if this is the first read (rulesFor's side
  // effect); the listing itself is a fresh query so the order below applies.
  await prisma.$transaction((tx) => rulesFor(tx, orgId));
  // RULING R3: ordered by prefix ascending, not createdAt — createMany
  // stamps every seeded/replaced row with the same transaction now(), so
  // createdAt order is undefined.
  const rules = await prisma.updateRule.findMany({ where: { orgId }, orderBy: { prefix: "asc" } });
  res.json({ rules: rules.map((r) => ({ prefix: r.prefix, status: r.status, enabled: r.enabled })) });
}));

dispatcherLoadTruthRouter.put("/update-rules", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsed = rulesSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const seen = new Set<string>();
  for (const r of parsed.data.rules) {
    // normalize(), not .toUpperCase() alone: matchRule() compares prefixes
    // with trim + upper + whitespace-collapse, so "PICKED UP" and
    // "PICKED  UP" (double space) are the SAME prefix to the matcher and
    // must be caught as a duplicate here too — .toUpperCase() alone would
    // let both through as visually-different strings. Storage below keeps
    // the trimmed-and-uppercased (not whitespace-collapsed) prefix as typed.
    const key = normalize(r.prefix);
    if (seen.has(key)) return res.status(400).json({ error: `"${r.prefix}" is listed twice` });
    seen.add(key);
  }
  // Their words are the whole set: PUT replaces, so a removed word is gone.
  // `rulesFor` inside the same transaction is what makes the answer honest:
  // an EMPTY set deletes everything and then re-seeds the defaults (that
  // re-seeding IS the documented semantics — "deleting every rule brings the
  // defaults back"), so answering `{rules: []}` described a state that never
  // existed for a moment. The reply is the set the org actually has.
  await prisma.$transaction(async (tx) => {
    await tx.updateRule.deleteMany({ where: { orgId } });
    await tx.updateRule.createMany({ data: parsed.data.rules.map((r) => ({ orgId, prefix: r.prefix.toUpperCase(), status: r.status, enabled: r.enabled ?? true })) });
    await rulesFor(tx, orgId);
  });
  // RULING R3: ordered by prefix ascending, not createdAt — see the GET
  // handler above for why createdAt order is undefined here.
  const rules = await prisma.updateRule.findMany({ where: { orgId }, orderBy: { prefix: "asc" } });
  res.json({ rules: rules.map((r) => ({ prefix: r.prefix, status: r.status, enabled: r.enabled })) });
}));

/** The org's load or a 404 — never a hint that another org's id exists. */
async function ownLoad(req: { orgScope?: string | null }, id: string) {
  const load = await prisma.load.findUnique({ where: { id }, include: { assignment: { select: { id: true } } } });
  return !load || outsideOrg(req, load.orgId) ? null : load;
}

dispatcherLoadTruthRouter.get("/loads/:id/changes", asyncRoute(async (req, res) => {
  const load = await ownLoad(req, req.params.id as string);
  if (!load) return res.status(404).json({ error: "Load not found" });
  const rows = await prisma.loadChange.findMany({ where: { loadId: load.id }, orderBy: [{ atMs: "desc" }, { id: "desc" }], take: 200 });
  res.json({ changes: rows.map((c) => ({ atMs: Number(c.atMs), actorName: c.actorName, source: c.source, field: c.field, before: c.before, after: c.after, note: c.note })) });
}));

/** Thrown from inside the undo transaction to abort it and carry the 409
 *  message out — every reason to refuse an undo lands here, so the catch
 *  below has exactly one shape to handle. */
class UndoRefused extends Error {}

dispatcherLoadTruthRouter.post("/loads/:id/undo-status", asyncRoute(async (req, res) => {
  const load = await ownLoad(req, req.params.id as string);
  if (!load) return res.status(404).json({ error: "Load not found" });
  // Fetched before the transaction (per the fix-round instruction) — actor
  // identity does not race with the load's own state the way status does.
  const actor = await actorOf(req);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      // §7.3 (A7/F5): a write to a load another dispatcher holds is refused —
      // an undo is a write like any other, and this route reached the record
      // straight past the gate every board route goes through. Inside the
      // transaction, on the same read as every other decision below.
      await assertWritable(tx, load.id, actor.dispatcherId);
      // Re-read INSIDE the transaction: ownLoad()'s read above, and the
      // await for actorOf(), both leave a window where another request can
      // change this load's status or assign a driver to it. Every 409
      // decision below is made on this fresh read, not the stale one — the
      // bug this fix-round exists to close was that the old code decided on
      // the stale `load.status`/`load.assignment` and then wrote
      // unconditionally, silently clobbering a concurrent change and
      // recording a false `before` on the trace row.
      const fresh = await tx.load.findUnique({
        where: { id: load.id },
        select: { status: true, version: true, assignment: { select: { id: true } } },
      });
      if (!fresh) throw new UndoRefused("record moved since — reload and try again");
      if (fresh.assignment) throw new UndoRefused("One of our drivers runs this load — change its status in the Cockpit");
      // `note: { not: "undo" }`: an undo writes its own status row, and the
      // next undo used to find THAT and revert it — two clicks ping-ponged a
      // load between two statuses forever. The newest row a human's UPDATE
      // text actually caused is the only thing there is to undo; after one
      // undo its `after` no longer matches the load, so the second undo is
      // honestly "nothing to undo".
      // (The explicit `note: null` arm is not decoration: a status row whose
      // note is NULL — a move the carrier caused rather than a word — is
      // still a real change to undo, and SQL's `<> 'undo'` is unknown, not
      // true, for NULL.)
      const last = await tx.loadChange.findFirst({
        where: { loadId: load.id, field: "status", OR: [{ note: null }, { note: { not: "undo" } }] },
        orderBy: [{ atMs: "desc" }, { id: "desc" }],
      });
      if (!last || last.after !== fresh.status) throw new UndoRefused("Nothing to undo — the status has not been set from UPDATE, or it moved since");
      const restored = last.before ?? "open";
      // Optimistic lock: only write if the status is still exactly what
      // `last` recorded as its "after". A write that lands in the gap
      // between the read above and this one (another dispatcher, the
      // board, an import) changes the row's status and makes this match
      // zero rows instead of silently overwriting whatever it set.
      const result = await tx.load.updateMany({
        where: { id: load.id, status: last.after },
        data: { status: restored, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new UndoRefused("record moved since — reload and try again");
      await tx.loadChange.create({
        data: {
          loadId: load.id, orgId: load.orgId, atMs: nextAtMs(), actorId: actor.dispatcherId, actorName: actor.name,
          source: "board", field: "status", before: fresh.status, after: restored, note: "undo",
        },
      });
      // L7: read the real value back rather than computing `fresh.version + 1`.
      // The `updateMany` above guards on `status`, not `version` — a
      // concurrent bump from anywhere else (a board edit, an import) between
      // the `fresh` read above and this write still lands (the WHERE only
      // cares that status is still `last.after`), and `fresh.version + 1`
      // would then be too low. Handing the client a `baseVersion` that is
      // stale on arrival gets it refused as STALE_VERSION with nothing in the
      // history explaining why.
      const after = await tx.load.findUniqueOrThrow({ where: { id: load.id }, select: { version: true } });
      return { status: restored, version: after.version };
    });
    emitLoadChanged(load.orgId, { loadId: load.id, version: updated.version, fields: ["status"] });
    res.json({ status: updated.status, version: updated.version });
  } catch (e) {
    if (e instanceof UndoRefused) return res.status(409).json({ error: e.message });
    // The same 409 body shape the board routes answer with, so one client
    // branch handles a locked load wherever it hits one.
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    // F5: same never-hang net as the board routes — found in the audit this
    // fix wave required. Express 4 does not await async handlers, so an
    // uncaught throw here would answer Undo with nothing at all, forever.
    console.error("POST /loads/:id/undo-status failed", e);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }
}));
