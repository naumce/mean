import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { Baseline } from "./baseline.js";
import type { Proposal } from "./decision.js";
import type { HarnessConfig } from "./config.js";
import type { Evidence } from "./evidence.js";
import type { RunStatus, TerminationReason, RunStats } from "./loop.js";

// aiHarness/runStore.ts (Qwen Harness v0.1, Task 5): the loop's only door to
// the database — every AiRunStep row and every AiDecisionRecord column the
// loop owns goes through this interface, never through `prisma` directly
// from loop.ts itself, so a test can swap in an in-memory double and never
// touch Postgres. `RunStatus`/`TerminationReason`/`RunStats` are defined in
// loop.ts (the algorithm that produces them); the type-only imports back from
// there never create a runtime cycle — only loop.ts imports VALUES from this
// file, never the other way around.

export type StepKind =
  | "system"
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "final"
  | "error"
  | "nudge";

export interface AppendStepInput {
  kind: StepKind;
  name?: string | null;
  payload: unknown;
  atMs: number;
  durationMs?: number | null;
}

/** What `listSteps` returns, and the shape `evidence.ts` reconstructs a
 *  proposal's evidence from — deliberately the same shape whether it came
 *  from `prismaRunStore` or a test's in-memory double. */
export interface StoredStep {
  seq: number;
  kind: StepKind;
  name: string | null;
  payload: unknown;
  atMs: number;
  durationMs: number | null;
}

/** `AiDecisionRecord.toolCalls`/`toolResults` (required Json columns since
 *  Task 1) — one summary entry per step of that kind, written once at the end
 *  of a run. Kept minimal on purpose: the full detail already lives in
 *  AiRunStep; these two columns exist only so a list view can show "3 tool
 *  calls, 1 truncated" without joining/parsing every step. */
export interface ToolCallSummary {
  seq: number;
  name: string;
}

export interface ToolResultSummary {
  seq: number;
  name: string;
  ok: boolean;
  truncated: boolean;
}

/**
 * Every field `runDispatchDecision` may update on a run's `AiDecisionRecord`,
 * across its lifecycle (start, baseline capture, end) — a caller passes only
 * the fields that changed for that call; everything else is left untouched.
 * `null` on a nullable Json field (`baseline`/`evidence`/`proposedDecision`)
 * means "this run genuinely has none" (persisted as real SQL NULL); omitting
 * the key entirely means "don't touch this column right now" — the two are
 * NOT the same and `prismaRunStore.updateRun` below tells them apart.
 */
export interface UpdateRunData {
  status?: RunStatus;
  startedAt?: Date;
  completedAt?: Date;
  terminationReason?: TerminationReason;
  error?: string | null;
  stats?: RunStats;
  baseline?: Baseline | null;
  evidence?: Evidence | null;
  proposedDecision?: Proposal | null;
  reason?: string | null;
  confidence?: number | null;
  driverId?: string | null;
  modelConfig?: HarnessConfig;
  promptVersion?: string;
  toolCalls?: ToolCallSummary[];
  toolResults?: ToolResultSummary[];
}

export interface RunStore {
  /** Appends one row to the run's transcript and returns its assigned `seq`
   *  (1-based, gapless, per decisionId). */
  appendStep(decisionId: string, step: AppendStepInput): Promise<number>;
  /** Patches the run's own record — see `UpdateRunData` above for what
   *  "patches" means for a nullable Json field. */
  updateRun(decisionId: string, data: UpdateRunData): Promise<void>;
  /** The full transcript, oldest first. */
  listSteps(decisionId: string): Promise<StoredStep[]>;
}

/** `value` is `undefined` (skip this column entirely), `null` (a nullable
 *  Json column's real SQL NULL — the same convention `loadWriter.ts` uses for
 *  its own nullable `extras` column), or an actual JSON-shaped value.
 *  Prisma requires the `Prisma.DbNull` sentinel rather than a bare `null` for
 *  the middle case — passing a raw `null` on a `Json?` field is a type error
 *  precisely so a caller has to say which kind of "empty" it means. */
function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

/**
 * The Prisma-backed `RunStore` — the only writer of `AiRunStep` rows, and (per
 * the run lifecycle columns Task 1 added) of `AiDecisionRecord`'s
 * status/termination/stats/baseline/evidence/modelConfig fields. Never used
 * directly by loop tests (an in-memory double stands in there); exercised
 * end-to-end by one test against a real `AiDecisionRecord` fixture.
 */
export const prismaRunStore: RunStore = {
  async appendStep(decisionId, step) {
    // seq = count+1, not a stored counter: AiRunStep is append-only (nothing
    // in this feature ever deletes a step), so COUNT and "1 + MAX(seq)" agree.
    // The @@unique([decisionId, seq]) index is the actual race guard — two
    // concurrent appends computing the same seq means one of them hits P2002
    // and simply recomputes against what the other just committed.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const seq = (await prisma.aiRunStep.count({ where: { decisionId } })) + 1;
      try {
        await prisma.aiRunStep.create({
          data: {
            decisionId,
            seq,
            kind: step.kind,
            name: step.name ?? null,
            payload: step.payload as Prisma.InputJsonValue,
            // Math.trunc first: an injected `now()` (e.g. one based on
            // performance.now() in a test) can be non-integer, and
            // `BigInt()` throws a RangeError on anything but a safe integer.
            atMs: BigInt(Math.trunc(step.atMs)),
            durationMs: step.durationMs ?? null,
          },
        });
        return seq;
      } catch (err) {
        const isSeqRace = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (isSeqRace && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
    /* istanbul ignore next -- the loop above always returns or throws */
    throw new Error(`appendStep: could not allocate a seq for decision ${decisionId} after retrying once.`);
  },

  async updateRun(decisionId, data) {
    const update: Prisma.AiDecisionRecordUpdateInput = {};

    if (data.status !== undefined) update.status = data.status;
    if (data.startedAt !== undefined) update.startedAt = data.startedAt;
    if (data.completedAt !== undefined) update.completedAt = data.completedAt;
    if (data.terminationReason !== undefined) update.terminationReason = data.terminationReason;
    if (data.error !== undefined) update.error = data.error;
    if (data.reason !== undefined) update.reason = data.reason;
    if (data.confidence !== undefined) update.confidence = data.confidence;
    if (data.driverId !== undefined) update.driverId = data.driverId;
    if (data.promptVersion !== undefined) update.promptVersion = data.promptVersion;

    const stats = jsonColumn(data.stats);
    if (stats !== undefined) update.stats = stats;
    const baseline = jsonColumn(data.baseline);
    if (baseline !== undefined) update.baseline = baseline;
    const evidence = jsonColumn(data.evidence);
    if (evidence !== undefined) update.evidence = evidence;
    const proposedDecision = jsonColumn(data.proposedDecision);
    if (proposedDecision !== undefined) update.proposedDecision = proposedDecision;
    const modelConfig = jsonColumn(data.modelConfig);
    if (modelConfig !== undefined) update.modelConfig = modelConfig;
    // toolCalls/toolResults are REQUIRED Json columns (never null, unlike the
    // five above) — `UpdateRunData` never offers `null` for them either, so
    // they skip `jsonColumn`'s DbNull branch entirely and go in as-is.
    if (data.toolCalls !== undefined) update.toolCalls = data.toolCalls as unknown as Prisma.InputJsonValue;
    if (data.toolResults !== undefined) update.toolResults = data.toolResults as unknown as Prisma.InputJsonValue;

    await prisma.aiDecisionRecord.update({ where: { id: decisionId }, data: update });
  },

  async listSteps(decisionId) {
    const rows = await prisma.aiRunStep.findMany({ where: { decisionId }, orderBy: { seq: "asc" } });
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind as StepKind,
      name: row.name,
      payload: row.payload,
      // AiRunStep.atMs is BigInt in Postgres (schema, Task 1) so it can hold a
      // raw epoch-ms value with no precision ceiling; every producer/consumer
      // above this line works in plain `number` epoch-ms, well inside
      // Number.MAX_SAFE_INTEGER for any real timestamp, so converting back
      // here loses nothing.
      atMs: Number(row.atMs),
      durationMs: row.durationMs,
    }));
  },
};
