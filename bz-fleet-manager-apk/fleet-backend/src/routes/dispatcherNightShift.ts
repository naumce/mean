import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { outsideOrg } from "../middleware/orgScope.js";
import { actorOf } from "../lib/actor.js";
import { agentPolicySchema, STANDARD_POLICY } from "../lib/agentPolicies.js";
import { LoadNotFound, StaleVersion } from "../lib/loadWriter.js";
import { applyAgentSwitch, PolicyNotFound } from "../lib/agentSwitch.js";
import { LoadLocked } from "../lib/loadLocks.js";
import { emitLoadChanged } from "../lib/loadEvents.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { installAgentColumns } from "../lib/sheet/installColumns.js";
import { timelineFor } from "../lib/agentTimeline.js";
import { queueCommand } from "../lib/agentCommands.js";

// Night Shift on the Board (spec §17): policies, the switch, the timeline and
// the supervision drawer. Mounted under dispatcherRouter with attachOrgScope
// (app.ts), after dispatcherLoadboardRouter.
export const dispatcherNightShiftRouter = Router();

const NO_ORG = "Night Shift requires an org-scoped dispatcher account";
const POLICY_NOT_FOUND = "Policy not found";
const LOAD_NOT_FOUND = "Load not found";

const validationMessage = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string }).code === "P2002";

// PATCH /night-shift/policies/:id (fix round 1): the merge happens INSIDE
// the transaction below, keyed off a fresh read of the row — thrown, not
// returned, so it can cross the `prisma.$transaction` boundary and still
// pick the right HTTP status once caught outside it.
class PatchPolicyNotFound extends Error {}
class PatchMergeInvalid extends Error {}

const agentPolicyPatchSchema = agentPolicySchema.partial();

/** A policy's name is one of the two dropdown-relevant things the connected
 *  sheet's Night Shift column shows (spec: the switch's data validation list
 *  is "OFF" + every policy name) — a create or a rename must not leave that
 *  dropdown stale. Best-effort: a Google failure here is this org's sheet
 *  connection's problem, never a reason to fail the policy write itself
 *  (`binding.lastError` is where a dispatcher already looks for that). */
async function reinstallSheetColumnsIfConnected(orgId: string): Promise<void> {
  const binding = await prisma.sheetBinding.findFirst({ where: { orgId, status: "connected" } });
  if (!binding) return;
  try {
    await installAgentColumns(binding.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("night-shift: could not re-install sheet columns after a policy write", { bindingId: binding.id, error: message });
    await prisma.sheetBinding.update({ where: { id: binding.id }, data: { lastError: message } });
  }
}

// --- Policies ----------------------------------------------------------------

dispatcherNightShiftRouter.get("/night-shift/policies", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const policies = await prisma.agentPolicy.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  // Only loads that name a policy explicitly — a load with no agentPolicyId
  // runs Standard by fallback (lib/agentPolicies.ts's policyFor), which is a
  // different fact from "this load was assigned Standard" and would make
  // Standard's own count include every load that never chose a policy at all.
  const counts = await prisma.load.groupBy({
    by: ["agentPolicyId"],
    where: { orgId, agentPolicyId: { not: null } },
    _count: { _all: true },
  });
  const loadsByPolicy: Record<string, number> = {};
  for (const c of counts) if (c.agentPolicyId) loadsByPolicy[c.agentPolicyId] = c._count._all;
  res.json({ policies, loadsByPolicy });
}));

dispatcherNightShiftRouter.post("/night-shift/policies", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const parsed = agentPolicySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  try {
    const policy = await prisma.agentPolicy.create({ data: { ...parsed.data, orgId } });
    await reinstallSheetColumnsIfConnected(orgId);
    res.status(201).json({ policy });
  } catch (e) {
    // AgentPolicy is unique on (orgId, name) (prisma/schema.prisma) — a name
    // this org already has is a conflict, not a server error.
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A policy with that name already exists" });
    throw e;
  }
}));

dispatcherNightShiftRouter.put("/night-shift/policies/:id", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const existing = await prisma.agentPolicy.findUnique({ where: { id: req.params.id as string } });
  // 404, never 403: a policy belonging to another org must read exactly like
  // one that does not exist, so a caller can never use the status code to
  // learn that a foreign id is real.
  if (!existing || outsideOrg(req, existing.orgId)) return res.status(404).json({ error: POLICY_NOT_FOUND });
  const parsed = agentPolicySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });
  // Task 5 / controller ruling: an API-key caller (the MCP server's
  // set_policy tool) can edit every other field of a policy but can never
  // flip shadow — that stays a click on the Night Shift page with its own
  // confirmation sentence (spec §10/§13). The MCP tool already refuses
  // locally when its patch touches shadow at all; this is the route's own
  // backstop for any other key caller, checked against the STORED value so
  // a patch that merely repeats the current value is not refused.
  if (req.viaApiKey && parsed.data.shadow !== existing.shadow) {
    return res.status(403).json({ error: "FORBIDDEN", message: "shadow can only be changed from the Night Shift page" });
  }
  const actor = await actorOf(req);
  try {
    const policy = await prisma.agentPolicy.update({ where: { id: existing.id }, data: parsed.data });
    // Flipping shadow off is a permission change — the agent may now act for
    // real instead of only logging what it would have done — not a Load
    // write, so a LoadChange row is the wrong place for it (brief, Task 3).
    // A plain audit line naming the org and the actor instead.
    if (existing.shadow && !policy.shadow) {
      console.info(`night-shift: shadow OFF — policy "${policy.name}" (${policy.id}), org ${orgId}, by ${actor.name}`);
    }
    if (existing.name !== policy.name) await reinstallSheetColumnsIfConnected(orgId);
    res.json({ policy });
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A policy with that name already exists" });
    throw e;
  }
}));

// Fix round 1: the MCP `set_policy` tool used to GET the policy, merge the
// patch onto it in the MCP process, and PUT the whole merged object back —
// a dispatcher (or a second tool call) editing any OTHER field in between
// those two round trips got silently reverted by the stale copy the tool
// was still holding. The merge now happens here, inside one transaction
// against a FRESH read, so nothing can land between "read" and "write".
// Session and key callers both use this the same way; the Night Shift
// page itself keeps using PUT (whole-object) — this exists for a caller
// that only knows what it wants to CHANGE. `shadow` is refused outright,
// unconditionally, for either caller: PUT already lets a dispatcher's own
// session flip it (that page IS "the Night Shift page" the message points
// to), so a session has no reason to reach for this route to do the same
// thing, and a key can never do it from anywhere.
dispatcherNightShiftRouter.patch("/night-shift/policies/:id", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  if (req.body && typeof req.body === "object" && Object.prototype.hasOwnProperty.call(req.body, "shadow")) {
    return res.status(403).json({ error: "FORBIDDEN", message: "shadow can only be changed from the Night Shift page" });
  }
  const parsed = agentPolicyPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });

  let renamed = false;
  let policy;
  try {
    policy = await prisma.$transaction(async (tx) => {
      const existing = await tx.agentPolicy.findUnique({ where: { id: req.params.id as string } });
      if (!existing || outsideOrg(req, existing.orgId)) throw new PatchPolicyNotFound();
      // Merge onto the FRESH row this transaction just read, not onto
      // whatever the caller might have cached — the entire point of moving
      // this server-side.
      const merged = { ...existing, ...parsed.data };
      const validated = agentPolicySchema.safeParse(merged);
      if (!validated.success) throw new PatchMergeInvalid(validationMessage(validated.error));
      renamed = existing.name !== validated.data.name;
      return tx.agentPolicy.update({ where: { id: existing.id }, data: validated.data });
    });
  } catch (e) {
    if (e instanceof PatchPolicyNotFound) return res.status(404).json({ error: POLICY_NOT_FOUND });
    if (e instanceof PatchMergeInvalid) return res.status(400).json({ error: e.message });
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A policy with that name already exists" });
    throw e;
  }
  if (renamed) await reinstallSheetColumnsIfConnected(orgId);
  res.json({ policy });
}));

dispatcherNightShiftRouter.delete("/night-shift/policies/:id", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  const existing = await prisma.agentPolicy.findUnique({ where: { id: req.params.id as string } });
  if (!existing || outsideOrg(req, existing.orgId)) return res.status(404).json({ error: POLICY_NOT_FOUND });
  // Matched by name, the same way lib/agentPolicies.ts's policyFor() resolves
  // "the org's Standard" — there is no separate boolean column marking it,
  // the name IS the reserved concept.
  if (existing.name === STANDARD_POLICY.name) {
    return res.status(409).json({ error: "The Standard policy cannot be deleted" });
  }
  const inUse = await prisma.load.count({ where: { orgId, agentPolicyId: existing.id } });
  if (inUse > 0) {
    return res.status(409).json({ error: `${inUse} load${inUse === 1 ? "" : "s"} still use this policy` });
  }
  await prisma.agentPolicy.delete({ where: { id: existing.id } });
  res.status(204).end();
}));

// --- The switch ----------------------------------------------------------------

const agentSwitchSchema = z.object({
  enabled: z.boolean(),
  policyId: z.string().min(1).optional(),
  // The version the caller rendered (spec §7.4). Without it two dispatchers
  // flipping the same load are last-write-wins with no 409 — found by the
  // Task 3 review and, independently, by the Task 5 implementer. Optional so
  // a caller that has not rendered the row (a script, a test) can still flip.
  baseVersion: z.number().int().nonnegative().optional(),
});

dispatcherNightShiftRouter.post("/loads/:id/agent", asyncRoute(async (req, res) => {
  const parsed = agentSwitchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });

  const load = await prisma.load.findUnique({ where: { id: req.params.id as string } });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: LOAD_NOT_FOUND });
  const orgId = load.orgId;

  const actor = await actorOf(req);

  // Thin wrapper (Task 9): validate, resolve the load, and hand off to
  // applyAgentSwitch (lib/agentSwitch.ts) inside this route's own
  // transaction — the sheet sync path (sync.ts) calls the exact same
  // function with `source: "sheet"` instead of a second copy of this logic.
  let result;
  try {
    result = await prisma.$transaction((tx) => applyAgentSwitch(tx, {
      loadId: load.id, orgId, actor, source: "loadboard",
      enabled: parsed.data.enabled, policyId: parsed.data.policyId, baseVersion: parsed.data.baseVersion,
    }));
  } catch (e) {
    if (e instanceof PolicyNotFound) return res.status(404).json({ error: POLICY_NOT_FOUND });
    if (e instanceof LoadNotFound) return res.status(404).json({ error: LOAD_NOT_FOUND });
    if (e instanceof LoadLocked) return res.status(409).json({ error: "LOAD_LOCKED", lock: e.lock, message: e.message });
    if (e instanceof StaleVersion) return res.status(409).json({ error: "STALE_VERSION", current: e.current });
    console.error("POST /loads/:id/agent failed", e);
    return res.status(500).json({ error: "INTERNAL", message: "That did not go through — try again" });
  }

  // F7 (loadWriter's own rule, followed by every writer route): nothing
  // changed, nothing to say. Re-disabling an already-off load is the one
  // case this actually happens for the switch itself.
  if (result.changed.length > 0) {
    emitLoadChanged(orgId, { loadId: load.id, version: result.version, fields: result.changed });
  }
  const fresh = await prisma.load.findUnique({ where: { id: load.id } });
  res.json({ load: fresh, version: result.version });
}));

// --- The timeline ----------------------------------------------------------------

dispatcherNightShiftRouter.get("/loads/:id/agent", asyncRoute(async (req, res) => {
  // Task 10: the body itself now lives in lib/agentTimeline.ts, shared with
  // the token-authenticated deep link (routes/nightShiftLink.ts). orgScope
  // null (an unscoped legacy/dev account) is passed through as-is —
  // timelineFor's null-orgId branch matches outsideOrg's own "unscoped sees
  // everything" rule exactly.
  const body = await timelineFor(req.params.id as string, req.orgScope ?? null);
  if (!body) return res.status(404).json({ error: LOAD_NOT_FOUND });
  res.json(body);
}));

// --- Supervision commands ----------------------------------------------------------------

const COMMAND_KINDS = ["stop", "call", "reply", "correct", "takeover", "handback", "send_customer_email"] as const;
const commandSchema = z.object({
  kind: z.enum(COMMAND_KINDS),
  payload: z.unknown().optional(),
});

dispatcherNightShiftRouter.post("/loads/:id/agent/commands", asyncRoute(async (req, res) => {
  const parsed = commandSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error) });

  const load = await prisma.load.findUnique({ where: { id: req.params.id as string }, select: { id: true, orgId: true } });
  if (!load || outsideOrg(req, load.orgId)) return res.status(404).json({ error: LOAD_NOT_FOUND });

  const actor = await actorOf(req);
  // Task 10: the write itself is lib/agentCommands.ts's queueCommand, shared
  // with the token-authenticated deep link (routes/nightShiftLink.ts), which
  // passes actorName: "link" instead of a dispatcher's name.
  const command = await queueCommand({ loadId: load.id, kind: parsed.data.kind, payload: parsed.data.payload, actorName: actor.name });
  res.status(202).json({ command });
}));

// --- Watched loads (Task 5: the MCP list_watched_loads tool) -----------------

dispatcherNightShiftRouter.get("/night-shift/loads", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  // "Watched" = the switch is on, org-wide — not filtered to any one policy.
  // agentUpdates newest-first, same source timelineFor()/dispatcherBrokerBoard
  // already use for "the load's current line": the newest entry that is not
  // an attention line.
  const loads = await prisma.load.findMany({
    where: { orgId, agentEnabled: true },
    include: { agentPolicy: { select: { name: true } }, agentUpdates: { orderBy: { atMs: "desc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    loads: loads.map((l) => ({
      id: l.id,
      boardLoadNo: l.boardLoadNo,
      orderRef: l.orderRef,
      agentPill: l.agentPill,
      agentLine: l.agentUpdates.find((u) => u.kind !== "attention")?.text ?? null,
      policyName: l.agentPolicy?.name ?? null,
    })),
  });
}));

// --- Usage (Task 5: the MCP usage tool; placeholder ahead of the wallet) ----

dispatcherNightShiftRouter.get("/night-shift/usage", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: NO_ORG });
  // The wallet/metering ledger (spec §8, OrgWallet/WalletEntry) is the next
  // plan's work, not this one's — this route exists now only so the MCP
  // usage(range?) tool and the Settings page have something real to call
  // rather than a 404, and returns an honestly-empty list until that ledger
  // lands.
  res.json({ nights: [] });
}));
