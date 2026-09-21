import { Router } from "express";
import { prisma } from "../db.js";
import { acquireLoadLock, heldBy, releaseLoadLock, snapshotLoadLocks, sweepLoadLocks } from "../lib/loadLocks.js";
import { emitToDispatchers } from "../realtime.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Load locks over HTTP (spec §13): acquire/heartbeat are one call — the
// holder re-affirming extends the TTL and announces nothing; a fresh hold
// tells the org. Release tells the org too. Expiry is silent: clients
// synthesize `expiresAt` from `since`, and the sweeper only tidies rows.
export const dispatcherLoadLocksRouter = Router();

const sweeper = setInterval(() => { void sweepLoadLocks().catch(() => { /* next tick */ }); }, 15_000);
sweeper.unref?.();

async function ownLoad(orgId: string, id: string): Promise<{ id: string } | null> {
  return prisma.load.findFirst({ where: { id, orgId }, select: { id: true } });
}

async function acquireFor(req: { orgScope?: string | null; auth?: { dispatcherId?: string } }, loadId: string) {
  const orgId = req.orgScope!;
  const dispatcherId = req.auth!.dispatcherId!;
  const me = await prisma.dispatcher.findUnique({ where: { id: dispatcherId }, select: { name: true } });
  const r = await acquireLoadLock(prisma, { loadId, orgId, dispatcherId, dispatcherName: me?.name ?? "Dispatcher" });
  if (r.ok && r.fresh) emitToDispatchers(orgId, "load_lock", { orgId, loadId, by: r.lock.by, dispatcherId, since: r.lock.since });
  return r;
}

for (const path of ["/loads/:id/lock", "/loads/:id/lock/heartbeat"]) {
  dispatcherLoadLocksRouter.post(path, asyncRoute(async (req, res) => {
    const orgId = req.orgScope;
    if (!orgId) return res.status(400).json({ error: "Locks require an org-scoped dispatcher account" });
    const load = await ownLoad(orgId, req.params.id as string);
    if (!load) return res.status(404).json({ error: "Load not found" });
    const r = await acquireFor(req, load.id);
    if (!r.ok) return res.status(409).json({ error: "LOAD_LOCKED", lock: r.lock, message: `${r.lock.by} is editing this load` });
    res.json({ lock: r.lock });
  }));
}

dispatcherLoadLocksRouter.delete("/loads/:id/lock", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Locks require an org-scoped dispatcher account" });
  const load = await ownLoad(orgId, req.params.id as string);
  if (!load) return res.status(404).json({ error: "Load not found" });
  const dispatcherId = req.auth!.dispatcherId!;
  const held = await heldBy(prisma, load.id);
  if (!(await releaseLoadLock(prisma, load.id, dispatcherId))) {
    return res.status(409).json({ error: "LOAD_LOCKED", lock: held, message: `${held?.by ?? "Someone"} is editing this load` });
  }
  if (held) emitToDispatchers(orgId, "load_unlock", { loadId: load.id });
  res.status(204).end();
}));

dispatcherLoadLocksRouter.get("/load-locks", asyncRoute(async (req, res) => {
  const orgId = req.orgScope;
  if (!orgId) return res.status(400).json({ error: "Locks require an org-scoped dispatcher account" });
  res.json({ locks: await snapshotLoadLocks(orgId) });
}));
