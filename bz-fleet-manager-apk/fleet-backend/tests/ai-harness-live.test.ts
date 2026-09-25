import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { seedWorld, ORG_NAME } from "../seed-world.mjs";
import { enqueueRun } from "../src/lib/aiHarness/runner.js";
import { DEFAULT_HARNESS_CONFIG } from "../src/lib/aiHarness/config.js";
import type { RunStats, TerminationReason } from "../src/lib/aiHarness/loop.js";
import type { Baseline } from "../src/lib/aiHarness/baseline.js";
import type { Proposal } from "../src/lib/aiHarness/decision.js";

// tests/ai-harness-live.test.ts (Qwen Harness v0.1, Task 8): the one test in
// this whole suite that reaches a REAL Ollama server instead of a scripted or
// deferred adapter double. Skipped unless BOTH OLLAMA_URL and AI_LIVE_TEST=1
// are set, so an ordinary `npx vitest run` (no env overrides — the default
// dev/CI command) never depends on a local model being installed and never
// adds several real minutes to a normal run. Enable it deliberately:
//
//   OLLAMA_URL=http://127.0.0.1:11434 AI_LIVE_TEST=1 \
//     npx vitest run tests/ai-harness-live.test.ts
//
// What this test asserts is deliberately narrow: STRUCTURE, not content. It
// never checks which driver qwen3:8b picked, how confident it was, or how
// many turns it took to get there — an 8B model's exact behavior on a given
// day is not something a unit test should pin down (see
// docs/qwen-harness-v0.1.md's evaluation section for where that judgment
// actually belongs: scripts/ai-eval-scenarios.mjs and a human). It only
// checks that the loop's own CONTRACT held: the run reached a real terminal
// status, it actually exchanged turns with the model and called tools, it
// recorded exactly one termination reason, and — if it proposed a driver —
// that driver was one the run's own feasibility guard would have allowed.
// validateProposal (aiHarness/decision.ts) already enforces that guard at
// runtime and would have rejected an infeasible pick before the run could
// ever reach "proposed"; this test re-derives the same feasible set from the
// run's PERSISTED transcript to confirm the stored result is consistent with
// that, not to re-implement the guard from scratch.
const LIVE = Boolean(process.env.OLLAMA_URL) && process.env.AI_LIVE_TEST === "1";

const SEED_TIMEOUT_MS = 180_000; // matches tests/seed-world.test.ts's own SEED_TIMEOUT_MS at this scale
const LIVE_TEST_TIMEOUT_MS = 600_000; // 10 minutes — matches DEFAULT_HARNESS_CONFIG.maxRunMs
const SCALE = 0.15;
const SCENARIO_A_EXTERNAL_ID = "W-A-RELIABLE";

// loop.ts's own TerminationReason union, restated here as a runtime list (a
// `type` has no runtime form to import) purely so this test can assert
// membership instead of just "is a non-empty string" — includes the
// internal_error amendment fix round 1 added to the design spec.
const TERMINATION_REASONS: readonly string[] = [
  "proposed", "no_decision", "max_turns", "max_tool_calls", "repeated_calls",
  "consecutive_invalid", "tool_bytes_exceeded", "timeout", "model_error", "cancelled", "internal_error",
];
const TERMINAL_STATUSES: readonly string[] = ["proposed", "incomplete", "failed", "cancelled"];

interface RunStepLike {
  kind: string;
  name: string | null;
  payload: unknown;
}

/**
 * Every feasible driver id the run's PERSISTED transcript can account for —
 * the baseline snapshot's own `feasibleDriverIds`, plus any id a
 * `findFeasibleDrivers` call made FOR THIS LOAD recorded as feasible in its
 * `tool_result` step. Mirrors exactly what loopHandlers.ts's `handleToolCall`
 * builds into the live run's own `state.feasibleSet` (baseline seed + widened
 * per successful, same-load `findFeasibleDrivers` call) — reconstructed here
 * from `steps` rather than re-querying the engine, so this test is honest
 * about what the run actually saw, not what a fresh query would say now.
 */
function feasibleIdsFromRun(loadId: string, baseline: Baseline | null, steps: RunStepLike[]): Set<string> {
  const ids = new Set<string>();
  if (baseline) for (const id of baseline.feasibleDriverIds) ids.add(id);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind !== "tool_result" || step.name !== "findFeasibleDrivers") continue;
    // The tool_call step for this exact invocation is always the immediately
    // preceding one (loopHandlers.ts persists tool_call then tool_result back
    // to back, nothing else in between) — read its arguments.loadId to apply
    // the same "only THIS run's own load ever widens the guard" gate the loop
    // itself applies.
    const call = steps[i - 1];
    const calledForThisLoad =
      call?.kind === "tool_call" &&
      call.name === "findFeasibleDrivers" &&
      (call.payload as { arguments?: { loadId?: unknown } } | null)?.arguments?.loadId === loadId;
    if (!calledForThisLoad) continue;

    const feasibility = (step.payload as { feasibility?: unknown } | null)?.feasibility;
    if (!Array.isArray(feasibility)) continue;
    for (const row of feasibility as { driverId?: unknown; feasible?: unknown }[]) {
      if (row?.feasible === true && typeof row.driverId === "string") ids.add(row.driverId);
    }
  }
  return ids;
}

/** Polls `AiDecisionRecord.status` until it is terminal — this run is driven
 *  by a real Ollama server that can genuinely take minutes, so (unlike the
 *  10ms polling `tests/helpers/aiHarnessFixture.ts` uses against instant
 *  scripted adapters) this checks every couple of seconds instead of
 *  hammering the database for the run's whole duration. */
async function waitForTerminalRun(runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.aiDecisionRecord.findUnique({ where: { id: runId } });
    if (row && TERMINAL_STATUSES.includes(row.status)) return row;
    if (Date.now() >= deadline) {
      throw new Error(
        `Live run ${runId} did not reach a terminal status within ${timeoutMs}ms (last status: ${row?.status ?? "not found"}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

describe.skipIf(!LIVE)("ai-harness live smoke (real Ollama)", () => {
  beforeAll(async () => {
    // Real Date.now() (no fixed `now` override), deliberately unlike
    // tests/seed-world.test.ts's own fixed clock: this test's assertions are
    // purely structural, and seeding against the real clock keeps every
    // real-time-derived read this run touches (captureBaseline's own
    // suggestForLoad call, driver availability/HOS) consistent with the
    // moment the run actually happens, seconds later.
    await seedWorld(prisma, { scale: SCALE });
  }, SEED_TIMEOUT_MS);

  it(
    "runs one real dispatch decision against W-A-RELIABLE end to end",
    async () => {
      const org = await prisma.org.findFirstOrThrow({ where: { name: ORG_NAME } });
      const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: SCENARIO_A_EXTERNAL_ID } });

      const experiment = await prisma.aiExperiment.create({
        data: {
          orgId: org.id,
          name: `Live smoke — ${SCENARIO_A_EXTERNAL_ID}`,
          model: DEFAULT_HARNESS_CONFIG.model,
          // Spread into a fresh object literal rather than passing the named
          // HarnessConfig-typed constant directly — Prisma's InputJsonValue
          // needs a string index signature, which TypeScript infers for an
          // inline literal but not for a variable of a declared interface
          // type (the same reasoning aiHarness/runStore.ts's jsonColumn
          // documents for its own JSON writes).
          config: { ...DEFAULT_HARNESS_CONFIG },
        },
      });

      // Deliberately NOT calling setAdapterFactory: this is the one test in
      // the suite that wants the runner's real default factory
      // (createOllamaAdapter(ollamaBaseUrl())), so enqueueRun here drives an
      // actual HTTP round trip to the Ollama server at OLLAMA_URL.
      const enqueued = await enqueueRun({
        orgId: org.id,
        experimentId: experiment.id,
        loadId: load.id,
        requestedById: null,
      });
      if ("error" in enqueued) {
        throw new Error(`enqueueRun failed unexpectedly against a freshly seeded org: ${enqueued.error}`);
      }

      // A little under the test's own timeout so a genuine hang still throws
      // a clear, attributable error instead of racing vitest's own cutoff.
      const record = await waitForTerminalRun(enqueued.runId, LIVE_TEST_TIMEOUT_MS - 15_000);
      const steps = await prisma.aiRunStep.findMany({ where: { decisionId: record.id }, orderBy: { seq: "asc" } });

      const stats = record.stats as unknown as RunStats | null;
      const toolCallSteps = steps.filter((s) => s.kind === "tool_call");
      const assistantSteps = steps.filter((s) => s.kind === "assistant");

      // Required by the task brief: a one-line summary the controller can
      // read straight out of the test log without opening the database.
      // eslint-disable-next-line no-console -- intentional test-run summary, not app logging
      console.log(
        `[ai-harness-live] status=${record.status} termination=${record.terminationReason ?? "none"} ` +
          `turns=${stats?.modelCalls ?? "?"} toolCalls=${stats?.toolCalls ?? "?"}`,
      );

      expect(["proposed", "incomplete", "failed"]).toContain(record.status);
      expect(record.terminationReason).not.toBeNull();
      expect(TERMINATION_REASONS).toContain(record.terminationReason as TerminationReason);
      expect(toolCallSteps.length).toBeGreaterThanOrEqual(1);
      expect(assistantSteps.length).toBeGreaterThanOrEqual(1);
      expect(stats?.modelCalls ?? 0).toBeGreaterThanOrEqual(1);
      expect(record.completedAt).not.toBeNull();

      if (record.status === "proposed") {
        const proposal = record.proposedDecision as unknown as Proposal | null;
        const proposedDriverId = proposal?.driverId ?? null;
        // A null driverId ("no feasible driver is appropriate") trivially
        // satisfies the guard — there is no id it could have hallucinated.
        if (proposedDriverId !== null) {
          const baseline = record.baseline as unknown as Baseline | null;
          const feasibleIds = feasibleIdsFromRun(load.id, baseline, steps);
          expect(feasibleIds.has(proposedDriverId)).toBe(true);
        }
      }
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
