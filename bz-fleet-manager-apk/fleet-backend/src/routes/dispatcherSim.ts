import { spawn } from "node:child_process";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { demoModeEnabled } from "./dispatcherDemo.js";
import { tick } from "../lib/simulation/engine.js";
import { startRunner, stopRunner, runnerState } from "../lib/simulation/runner.js";
import { eastOffsetDeg } from "../lib/simulation/movement.js";
import { WORLD_ORG_NAME } from "../../seed-world.mjs";

// Simulation controls (AI Dispatch Foundation Task 8): trucks move along
// their committed plans, loads start and complete, availability follows —
// so the Night Shift agent and every existing dispatcher view see the demo
// world exactly as if it were real (see lib/simulation/engine.ts for the
// tick itself). GATED BY DEMO_MODE exactly like dispatcherDemo.ts's /demo
// routes (read at request time, not import time): off means ABSENT — a 404,
// the same answer an unknown path gets — never merely refused, so nothing
// here hints at existing on a real tenant.
export const dispatcherSimRouter = Router();

dispatcherSimRouter.use("/sim", (req, res, next) => {
  if (!demoModeEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

/** Every /sim handler is one org's fiction, never all of them at once — a
 *  400 (not a silent "every org", and not a 500) is what an unscoped
 *  legacy/dev dispatcher token gets here. Already responded when this
 *  returns null. */
function orgOrRefuse(req: Request, res: Response): string | null {
  if (!req.orgScope) {
    res.status(400).json({ error: "ORG_REQUIRED" });
    return null;
  }
  return req.orgScope;
}

dispatcherSimRouter.get(
  "/sim/state",
  asyncRoute(async (req, res) => {
    const orgId = orgOrRefuse(req, res);
    if (!orgId) return;

    const [state, drivers] = await Promise.all([
      prisma.simulationState.findUnique({ where: { orgId } }),
      // Non-auto only: an "auto" row is indistinguishable from no row at
      // all, and most drivers will never have either.
      prisma.simDriverState.findMany({ where: { mode: { not: "auto" }, driver: { orgId } } }),
    ]);
    // `running`/`speed` come from the LIVE in-process runner, never blindly
    // from the DB column: a restarted process has no timer for any org, and
    // must say so even though the last-persisted row may still read `true`.
    const live = runnerState(orgId);
    const simMinutesAdvanced = state?.simMinutesAdvanced ?? 0;

    res.json({
      running: live.running,
      speed: live.running ? live.speed : (state?.speed ?? 1),
      simMinutesAdvanced,
      simNowMs: Date.now() + simMinutesAdvanced * 60_000,
      lastTickAt: state?.lastTickAt ?? null,
      drivers,
    });
  }),
);

const tickSchema = z.object({ minutes: z.number().int().min(1).max(1440) });
dispatcherSimRouter.post(
  "/sim/tick",
  validateBody(tickSchema),
  asyncRoute(async (req, res) => {
    const orgId = orgOrRefuse(req, res);
    if (!orgId) return;
    const { minutes } = req.body as z.infer<typeof tickSchema>;
    res.json(await tick(orgId, minutes));
  }),
);

const startSchema = z.object({ speed: z.number().int().min(1).max(120) });
dispatcherSimRouter.post(
  "/sim/start",
  validateBody(startSchema),
  asyncRoute(async (req, res) => {
    const orgId = orgOrRefuse(req, res);
    if (!orgId) return;
    const { speed } = req.body as z.infer<typeof startSchema>;
    startRunner(orgId, speed);
    await prisma.simulationState.upsert({
      where: { orgId },
      update: { running: true, speed },
      create: { orgId, running: true, speed },
    });
    res.json({ running: true, speed });
  }),
);

dispatcherSimRouter.post(
  "/sim/stop",
  asyncRoute(async (req, res) => {
    const orgId = orgOrRefuse(req, res);
    if (!orgId) return;
    stopRunner(orgId);
    await prisma.simulationState.upsert({
      where: { orgId },
      update: { running: false },
      create: { orgId, running: false },
    });
    res.json({ running: false });
  }),
);

const SIM_MODES = ["auto", "stopped", "dark", "offroute", "idle"] as const;
const modeSchema = z.object({
  mode: z.enum(SIM_MODES),
  minutes: z.number().int().min(1).max(1440).optional(),
  offsetMi: z.number().min(0).max(50).optional(),
});
dispatcherSimRouter.post(
  "/sim/drivers/:id/mode",
  validateBody(modeSchema),
  asyncRoute(async (req, res) => {
    const orgId = orgOrRefuse(req, res);
    if (!orgId) return;
    const body = req.body as z.infer<typeof modeSchema>;
    const driver = await prisma.driver.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, orgId: true, lastLat: true },
    });
    // Cross-tenant read as "not found" — same rule as every other
    // dispatcher-facing driver lookup in this codebase.
    if (!driver || driver.orgId !== orgId) return res.status(404).json({ error: "Driver not found" });

    // offsetMi only means anything for "offroute"; every other mode is
    // written with a clean zero offset rather than carrying a stale value
    // forward from whatever mode this driver was in before.
    const offset = body.mode === "offroute" && body.offsetMi != null
      ? eastOffsetDeg(driver.lastLat ?? 0, body.offsetMi)
      : { offsetLat: 0, offsetLng: 0 };
    const modeUntil = body.minutes != null ? new Date(Date.now() + body.minutes * 60_000) : null;

    const updated = await prisma.simDriverState.upsert({
      where: { driverId: driver.id },
      update: { mode: body.mode, modeUntil, offsetLat: offset.offsetLat, offsetLng: offset.offsetLng },
      create: { driverId: driver.id, mode: body.mode, modeUntil, offsetLat: offset.offsetLat, offsetLng: offset.offsetLng },
    });
    res.json(updated);
  }),
);

// --- reset ------------------------------------------------------------
// Re-runs `node seed-world.mjs` — the exact same CLI a human runs — as a
// child process rather than importing its `seedWorld()` in-process: the
// script opens its own PrismaClient and is exercised daily as a standalone
// process, so spawning it is testing the real path, not a second one.
// Module-level and GLOBAL (not per-org): seed-world.mjs always rebuilds the
// one fixed demo org, so two reseeds racing each other is one hazard
// regardless of which org's dispatcher pressed the button.
let resetInFlight = false;

// A hung reseed (a stuck migration, a wedged DB connection) must not hold
// `resetInFlight` — and therefore every future reset — until the process
// restarts.
const RESET_TIMEOUT_MS = 5 * 60_000;

/** The fixed demo org's id, looked up by its seed-assigned name rather than
 *  trusted from the caller: seed-world.mjs always rebuilds THIS one org
 *  regardless of which tenant's dispatcher pressed the button, so keying the
 *  runner stop and the post-exit SimulationState reset to the CALLER's own
 *  org would target the wrong row whenever the two differ — a runner left
 *  ticking on the demo org through its own purge, or a reset that clears an
 *  unrelated org's clock instead. Falls back to the caller's org only when no
 *  org named WORLD_ORG_NAME exists yet (a fresh database that has never been
 *  seeded) — there is no demo org id to key to in that case. */
async function demoOrgId(fallbackOrgId: string): Promise<string> {
  const org = await prisma.org.findFirst({ where: { name: WORLD_ORG_NAME }, select: { id: true } });
  return org?.id ?? fallbackOrgId;
}

dispatcherSimRouter.post(
  "/sim/reset",
  asyncRoute(async (req, res) => {
    const orgId = orgOrRefuse(req, res);
    if (!orgId) return;
    if (resetInFlight) return res.status(409).json({ error: "RESET_RUNNING" });

    const targetOrgId = await demoOrgId(orgId);

    resetInFlight = true;
    stopRunner(targetOrgId);
    const child = spawn("node", ["seed-world.mjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    const timeoutHandle = setTimeout(() => {
      console.error(
        `seed-world.mjs timed out after ${RESET_TIMEOUT_MS / 60_000} min for org ${targetOrgId} — killing it and releasing the reset lock`,
      );
      resetInFlight = false;
      child.kill();
    }, RESET_TIMEOUT_MS);
    timeoutHandle.unref?.();

    // Node throws an unhandled exception (crashing the whole process, every
    // tenant's requests included) if a ChildProcess emits 'error' with no
    // listener attached — this one fires when the OS could not even start
    // the child (missing binary, bad cwd), before any exit code exists. The
    // lock releases so a retry is possible; SimulationState is left alone,
    // same as a non-zero exit below, because nothing was actually reseeded.
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      resetInFlight = false;
      console.error(`seed-world.mjs failed to start for org ${targetOrgId}`, err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeoutHandle);
      resetInFlight = false;
      // A non-zero exit means the reseed did not actually complete — resetting
      // SimulationState to defaults here would claim a fresh scenario exists
      // when the org's real data was never touched. A killed-by-timeout child
      // also lands here (a non-zero/null code), so it is never double-counted
      // against the lock the timeout already released.
      if (code !== 0) {
        console.warn(`seed-world.mjs exited with code ${code} for org ${targetOrgId} — SimulationState left untouched`);
        return;
      }
      // The reseed rewrote every row under this org from scratch — a
      // pre-reset SimulationState row describing a scenario that no longer
      // exists must not survive it. Fire-and-forget from an event handler
      // that has no request to answer; a failure here is logged, not thrown.
      prisma.simulationState
        .upsert({
          where: { orgId: targetOrgId },
          update: { running: false, speed: 1, simMinutesAdvanced: 0, lastTickAt: null },
          create: { orgId: targetOrgId },
        })
        .catch((err: unknown) => console.error(`post-reset SimulationState reset failed for org ${targetOrgId}`, err));
    });
    res.status(202).json({ started: true });
  }),
);
