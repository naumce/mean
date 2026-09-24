import { tick } from "./engine.js";

// The org-scoped ticking clock behind POST /sim/start|stop. Module-level, one
// entry per org, so a process restart forgets every running simulation —
// documented (not a bug): nothing here auto-starts on boot, and
// GET /sim/state reports `running: false` until a dispatcher presses Start
// again. Persisting "was running" across a restart would let a demo silently
// resume ticking against a database an operator is mid-way through resetting.

interface RunnerEntry {
  timer: ReturnType<typeof setInterval>;
  speed: number;
  /** A tick still running when the next 1s interval fires is SKIPPED, not
   *  queued — two overlapping ticks on the same org would race each other's
   *  reads of "the current SimulationState.simMinutesAdvanced". */
  inFlight: boolean;
}

const runners = new Map<string, RunnerEntry>();

/** 1 real second = `speed` simulated minutes. Replaces any timer already
 *  running for this org rather than stacking a second one alongside it. */
export function startRunner(orgId: string, speed: number): void {
  stopRunner(orgId);
  const entry: RunnerEntry = {
    speed,
    inFlight: false,
    timer: setInterval(() => {
      if (entry.inFlight) return;
      entry.inFlight = true;
      tick(orgId, entry.speed)
        .catch((err: unknown) => console.error(`simulation tick failed for org ${orgId}`, err))
        .finally(() => { entry.inFlight = false; });
    }, 1000),
  };
  entry.timer.unref?.();
  runners.set(orgId, entry);
}

export function stopRunner(orgId: string): void {
  const entry = runners.get(orgId);
  if (!entry) return;
  clearInterval(entry.timer);
  runners.delete(orgId);
}

/** The live, in-process truth — never the database's last-persisted
 *  `SimulationState.running`, which would still read `true` after a crash
 *  that left no timer actually running. */
export function runnerState(orgId: string): { running: boolean; speed: number | null } {
  const entry = runners.get(orgId);
  return entry ? { running: true, speed: entry.speed } : { running: false, speed: null };
}
