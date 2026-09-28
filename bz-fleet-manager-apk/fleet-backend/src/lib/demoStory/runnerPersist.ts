import { prisma } from "../../db.js";
import { startRunner, stopRunner } from "../simulation/runner.js";

// The runner itself is purely in-memory (lib/simulation/runner.ts's own
// comment); GET /demo/story always reads the LIVE `runnerState()` regardless
// of what SimulationState says. Mirroring `/sim/start`/`/sim/stop`'s own
// persistence anyway keeps a direct read of the row from telling a stale
// story — best-effort, never lets a write failure here fail the caller's own
// transition.

export async function startRunnerAndPersist(orgId: string, speed: number): Promise<void> {
  startRunner(orgId, speed);
  await prisma.simulationState
    .upsert({ where: { orgId }, update: { running: true, speed }, create: { orgId, running: true, speed } })
    .catch((err: unknown) => console.warn(`demo story: could not persist SimulationState.running for org ${orgId}`, err));
}

export async function stopRunnerAndPersist(orgId: string): Promise<void> {
  stopRunner(orgId);
  await prisma.simulationState
    .updateMany({ where: { orgId }, data: { running: false } })
    .catch((err: unknown) => console.warn(`demo story: could not persist SimulationState.stopped for org ${orgId}`, err));
}
