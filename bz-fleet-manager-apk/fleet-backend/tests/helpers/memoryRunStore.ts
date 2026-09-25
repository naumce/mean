import type { AppendStepInput, RunStore, StoredStep, UpdateRunData } from "../../src/lib/aiHarness/runStore.js";

// tests/helpers/memoryRunStore.ts (Qwen Harness v0.1, Task 5): an in-memory
// `RunStore` double for loop tests — arrays keyed by decisionId, so a loop
// test never needs a seeded AiDecisionRecord/AiExperiment just to drive the
// algorithm (only `validateProposal`'s own real driver lookups still touch
// the database — this store never does). Not a `*.test.ts` file, so vitest's
// test glob never collects it; both ai-harness-loop.test.ts and
// ai-harness-loop-protection.test.ts import it, the same way scriptedAdapter
// (Task 3) is shared.

interface MemoryRun {
  steps: StoredStep[];
  updates: UpdateRunData[];
}

export interface MemoryRunStore extends RunStore {
  /** Every step actually appended for `decisionId`, in seq order. */
  stepsFor(decisionId: string): StoredStep[];
  /** Every `updateRun` call for `decisionId`, in call order — most tests want
   *  `latest`, but a test of `onStatus`/write ordering can want the raw
   *  sequence too. */
  updatesFor(decisionId: string): UpdateRunData[];
  /** All `updateRun` calls for `decisionId` merged in order (later calls
   *  overwrite earlier fields) — what a real "patch only the given fields"
   *  store ends up holding, so a test can assert the run's FINAL state with
   *  one plain object instead of scanning `updates` itself. */
  latest(decisionId: string): UpdateRunData;
}

export function memoryRunStore(): MemoryRunStore {
  const runs = new Map<string, MemoryRun>();

  function runFor(decisionId: string): MemoryRun {
    let run = runs.get(decisionId);
    if (!run) {
      run = { steps: [], updates: [] };
      runs.set(decisionId, run);
    }
    return run;
  }

  return {
    async appendStep(decisionId: string, step: AppendStepInput): Promise<number> {
      const run = runFor(decisionId);
      const seq = run.steps.length + 1;
      run.steps.push({
        seq,
        kind: step.kind,
        name: step.name ?? null,
        payload: step.payload,
        atMs: step.atMs,
        durationMs: step.durationMs ?? null,
      });
      return seq;
    },

    async updateRun(decisionId: string, data: UpdateRunData): Promise<void> {
      runFor(decisionId).updates.push(data);
    },

    async listSteps(decisionId: string): Promise<StoredStep[]> {
      return [...runFor(decisionId).steps];
    },

    stepsFor(decisionId: string): StoredStep[] {
      return [...runFor(decisionId).steps];
    },

    updatesFor(decisionId: string): UpdateRunData[] {
      return [...runFor(decisionId).updates];
    },

    latest(decisionId: string): UpdateRunData {
      return Object.assign({}, ...runFor(decisionId).updates);
    },
  };
}
