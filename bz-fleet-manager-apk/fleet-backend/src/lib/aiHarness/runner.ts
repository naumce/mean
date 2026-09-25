import { prisma } from "../../db.js";
import { emitToDispatchers } from "../../realtime.js";
import { resolveHarnessConfig, harnessEnabled, ollamaBaseUrl, type HarnessConfig } from "./config.js";
import { createOllamaAdapter } from "./ollamaAdapter.js";
import type { ModelAdapter } from "./types.js";
import { runDispatchDecision, type TerminationReason } from "./loop.js";
import { prismaRunStore } from "./runStore.js";
import { loadRefOfContext } from "./runView.js";

// aiHarness/runner.ts (Qwen Harness v0.1, Task 6): the in-process queue that
// turns an enqueued AiDecisionRecord into an actual runDispatchDecision call,
// one run at a time PER ORG (an org's own experiments compete for its one
// slot; two different orgs run concurrently). All state here is in-memory —
// nothing survives a process restart. A "queued" row left behind by a
// restart is NOT auto-resumed: it just sits there until a dispatcher cancels
// it or the process that queued it is running again and enqueues something
// new for that org (which does not touch the orphaned row either). GET
// /ai/runs still shows it as "queued" — that is the honest state, not a bug.

export const MAX_QUEUED_PER_ORG = 10;

export type EnqueueError = "QUEUE_FULL" | "EXPERIMENT_NOT_FOUND" | "LOAD_NOT_FOUND" | "HARNESS_DISABLED";

interface OrgRunnerState {
  /** RunIds waiting their turn, FIFO — index 0 runs next. */
  queue: string[];
  /** The runId currently inside runDispatchDecision for this org, or null. */
  running: string | null;
  /** The running run's own abort controller, so cancelRun can signal it. */
  controller: AbortController | null;
}

const orgStates = new Map<string, OrgRunnerState>();
// One promise chain per org — scheduleDrain always appends onto whatever is
// already there, so two enqueues arriving back-to-back never start two
// overlapping drain loops for the same org. A drain call that finds nothing
// left in the queue (the previous call in the chain already emptied it)
// simply resolves immediately.
const drainChains = new Map<string, Promise<void>>();

function stateFor(orgId: string): OrgRunnerState {
  let state = orgStates.get(orgId);
  if (!state) {
    state = { queue: [], running: null, controller: null };
    orgStates.set(orgId, state);
  }
  return state;
}

let adapterFactory: (config: HarnessConfig) => ModelAdapter = (_config) => createOllamaAdapter(ollamaBaseUrl());

/** Tests inject a scripted adapter here instead of ever reaching a real
 *  Ollama server; the default builds the one real adapter this harness ships,
 *  lazily (ollamaBaseUrl() is only called once a run actually drains, never
 *  at import time). */
export function setAdapterFactory(factory: (config: HarnessConfig) => ModelAdapter): void {
  adapterFactory = factory;
}

// loop.ts's own TerminationReason carries "internal_error" (fix round 1) for
// exactly this situation there (an unexpected throw inside
// runDispatchDecision itself); this runner reuses the same literal for ITS
// OWN catch-all below (a thrown adapter factory, a missing experiment, or any
// other rejection that happens BEFORE ever reaching runDispatchDecision) so
// the two failure paths are indistinguishable to a reader of the run.
const INTERNAL_ERROR_TERMINATION: TerminationReason = "internal_error";

export function runnerState(orgId: string): { running: string | null; queued: string[] } {
  const state = orgStates.get(orgId);
  return state ? { running: state.running, queued: [...state.queue] } : { running: null, queued: [] };
}

export async function enqueueRun(args: {
  orgId: string;
  experimentId: string;
  loadId: string;
  requestedById: string | null;
  parentRunId?: string | null;
}): Promise<{ runId: string } | { error: EnqueueError }> {
  if (!harnessEnabled()) return { error: "HARNESS_DISABLED" };

  const experiment = await prisma.aiExperiment.findUnique({ where: { id: args.experimentId } });
  if (!experiment || experiment.orgId !== args.orgId) return { error: "EXPERIMENT_NOT_FOUND" };

  const load = await prisma.load.findUnique({
    where: { id: args.loadId },
    select: { id: true, orgId: true, externalId: true, orderRef: true },
  });
  if (!load || load.orgId !== args.orgId) return { error: "LOAD_NOT_FOUND" };

  // Fix round 1 ruling: MAX_QUEUED_PER_ORG counts QUEUED runs only — the
  // spec's "refuses more than 10 pending runs" means the wait line, not the
  // one already running. 10 already queued refuses the next enqueue
  // regardless of whether something is running; 9 queued + 1 running still
  // accepts one more (bringing the queue to 10).
  const state = stateFor(args.orgId);
  if (state.queue.length >= MAX_QUEUED_PER_ORG) return { error: "QUEUE_FULL" };

  const loadRef = load.externalId ?? load.orderRef ?? load.id;
  const record = await prisma.aiDecisionRecord.create({
    data: {
      experimentId: experiment.id,
      orgId: args.orgId,
      loadId: load.id,
      kind: "dispatch_candidate",
      status: "queued",
      context: { loadRef, requestedAt: new Date().toISOString() },
      toolCalls: [],
      toolResults: [],
      requestedById: args.requestedById,
      parentRunId: args.parentRunId ?? null,
      promptVersion: experiment.promptVersion,
    },
    select: { id: true },
  });

  state.queue.push(record.id);
  scheduleDrain(args.orgId);

  return { runId: record.id };
}

export async function cancelRun(orgId: string, runId: string): Promise<boolean> {
  const state = stateFor(orgId);

  if (state.running === runId) {
    // Fire the signal and return — runDispatchDecision's own stopIfNeeded
    // check (loop.ts) sees it, finishes the run as "cancelled", and the
    // status change reaches the caller through the same onStatus WS emit any
    // other termination would. Not awaited: "cancel" is a request, not a
    // wait-for-settled contract.
    state.controller?.abort();
    return true;
  }

  const queuedIndex = state.queue.indexOf(runId);
  if (queuedIndex !== -1) {
    // Never started at all — nothing for runDispatchDecision to abort, so
    // this writes the terminal state itself, the same fields finish() would
    // have written for a "cancelled" run.
    state.queue.splice(queuedIndex, 1);
    await prismaRunStore.updateRun(runId, {
      status: "cancelled",
      terminationReason: "cancelled",
      completedAt: new Date(),
    });
    emitToDispatchers(orgId, "ai_run_status", { runId, status: "cancelled" });
    return true;
  }

  // I1: this process's own in-memory state knows nothing about `runId` —
  // either it was queued/started by a process that has since restarted, or
  // the id is simply wrong. Only the former is this function's to fix: read
  // the row directly, and if the database still says `queued`/`running` (an
  // orphan nothing will ever finish), reclaim it as `cancelled` here rather
  // than leaving it stuck forever with no path out but a manual SQL update.
  // A row that is already terminal (or does not exist at all) still falls
  // through to `false`, unchanged from before. `orgId` is checked here too
  // (defense in depth, matching runView.ts's own convention): the route that
  // calls this already verified ownership, so this never changes a correct
  // caller's result — it only stops a future caller passing a mismatched
  // pair from reclaiming a row it does not own.
  const row = await prisma.aiDecisionRecord.findUnique({ where: { id: runId }, select: { id: true, orgId: true, status: true } });
  if (row && row.orgId === orgId && (row.status === "queued" || row.status === "running")) {
    await prismaRunStore.updateRun(runId, {
      status: "cancelled",
      terminationReason: "cancelled",
      completedAt: new Date(),
      error: "orphaned: no runner owns this run (process restarted?)",
    });
    emitToDispatchers(orgId, "ai_run_status", { runId, status: "cancelled" });
    return true;
  }

  return false;
}

/**
 * Rows this org's OWN database says are `queued`/`running` but that THIS
 * process's in-memory runner does not own (see this file's own header
 * comment on what a restart leaves behind) — the read-side count `GET
 * /ai/status` surfaces so a dispatcher can see there is something to
 * reclaim (via `cancelRun` above) before hunting for a stuck run by hand.
 * Never negative: a process that DOES own more rows than the database
 * currently reports (a write still in flight) clamps to 0 rather than
 * reporting a meaningless negative count.
 */
export async function orphanedCount(orgId: string): Promise<number> {
  const dbCount = await prisma.aiDecisionRecord.count({ where: { orgId, status: { in: ["queued", "running"] } } });
  const state = stateFor(orgId);
  const ownedCount = state.queue.length + (state.running ? 1 : 0);
  return Math.max(0, dbCount - ownedCount);
}

function scheduleDrain(orgId: string): void {
  const previous = drainChains.get(orgId) ?? Promise.resolve();
  const next = previous.then(() => drainQueue(orgId)).catch(() => {
    // drainQueue never rejects on its own (runOne swallows everything into a
    // "failed" run) — this only guards the chain itself against ever getting
    // stuck on a rejected promise if something still slips through.
  });
  drainChains.set(orgId, next);
}

async function drainQueue(orgId: string): Promise<void> {
  const state = stateFor(orgId);
  while (state.queue.length > 0) {
    const runId = state.queue.shift();
    if (runId === undefined) break;
    const controller = new AbortController();
    state.running = runId;
    state.controller = controller;
    try {
      await runOne(orgId, runId, controller.signal);
    } finally {
      // Always, even if runOne's own catch-block write below somehow also
      // threw (e.g. the database is genuinely unreachable) — otherwise this
      // org's queue would report a phantom "running" run forever and refuse
      // every future enqueue as QUEUE_FULL once enough of them pile up.
      state.running = null;
      state.controller = null;
    }
  }
}

async function runOne(orgId: string, runId: string, signal: AbortSignal): Promise<void> {
  try {
    const record = await prisma.aiDecisionRecord.findUnique({ where: { id: runId } });
    if (!record) return;
    if (!record.loadId) throw new Error(`AiDecisionRecord ${runId} has no loadId to run against.`);

    const experiment = await prisma.aiExperiment.findUnique({ where: { id: record.experimentId } });
    if (!experiment) throw new Error(`Experiment ${record.experimentId} no longer exists.`);

    const config = resolveHarnessConfig(experiment.config);
    const adapter = adapterFactory(config);
    const loadRef = loadRefOfContext(record.context);

    await runDispatchDecision({
      orgId,
      decisionId: runId,
      loadId: record.loadId,
      loadRef,
      config,
      adapter,
      store: prismaRunStore,
      signal,
      onStep: (seq, kind) => emitToDispatchers(orgId, "ai_run_step", { runId, seq, kind }),
      onStatus: (status) => emitToDispatchers(orgId, "ai_run_status", { runId, status }),
    });
  } catch (err) {
    // A thrown error here (a bad adapter factory, a missing experiment, an
    // unexpected rejection out of runDispatchDecision itself) must not stop
    // the queue: this run is marked failed and drainQueue's loop moves on to
    // whatever is next.
    const message = err instanceof Error ? err.message : String(err);
    await prismaRunStore.updateRun(runId, {
      status: "failed",
      terminationReason: INTERNAL_ERROR_TERMINATION,
      error: message,
      completedAt: new Date(),
    });
    emitToDispatchers(orgId, "ai_run_status", { runId, status: "failed" });
  }
}
