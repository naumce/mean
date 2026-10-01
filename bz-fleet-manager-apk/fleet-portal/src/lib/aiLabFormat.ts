import { formatPct } from './money'
import type { Baseline, EvaluationSummary, RunStatus, RunStepKind } from '../types/aiLab'

// AI Lab (Qwen Harness v0.1, Task 7): pure formatting/derivation helpers,
// same "small dependency-free functions" convention as lib/cockpit/format.ts
// and lib/money.ts — kept out of the store and components so ProposalCard's
// rank computation and the timeline's labels are unit-testable on their own.

/** 1-based rank of `driverId` within the baseline's own candidate order (the
 *  order `suggestForLoad` returned — never re-sorted here). `null` when
 *  there is no pick, or the pick never appeared in this run's baseline at
 *  all (a driver the model found through a tool the baseline didn't rank). */
export function rankOfDriver(baseline: Baseline | null, driverId: string | null): number | null {
  if (!baseline || !driverId) return null
  const index = baseline.candidates.findIndex((c) => c.driverId === driverId)
  return index === -1 ? null : index + 1
}

/** The baseline's own top feasible candidate row, looked up by id rather
 *  than assumed to be `candidates[0]` — `topFeasibleDriverId` is the
 *  contract's authoritative pointer. */
export function deterministicTopCandidate(baseline: Baseline | null) {
  if (!baseline?.topFeasibleDriverId) return null
  return baseline.candidates.find((c) => c.driverId === baseline.topFeasibleDriverId) ?? null
}

/** `ms == null` renders "—" (unknown), never `0s`. Sub-second durations show
 *  as milliseconds so a fast tool call doesn't misleadingly read as "0s". */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** Fix round 2: `EvaluationSummary`'s means are `null` when an experiment has
 *  no proposed runs yet (a fresh experiment) — "—", never a fabricated
 *  `0.0`, matching `formatDurationMs`/`formatBytes`'s own null convention. */
export function formatMean(n: number | null | undefined, decimals = 1): string {
  return n == null ? '—' : n.toFixed(decimals)
}

/** dispatch-v2 A/B experiment: same null convention as `formatMean`, for a
 *  mean that is itself a 0–1 fraction (`EvaluationSummary.meanConfidence`) —
 *  rendered as a whole-number percent like every other confidence value in
 *  the AI Lab (ProposalCard, ExperimentRunsTable), never a raw decimal. */
export function formatMeanPct(fraction: number | null | undefined): string {
  return fraction == null ? '—' : formatPct(fraction)
}

/** dispatch-v2 A/B experiment: "most picked: <name> in N% of proposed runs",
 *  or "—" when the experiment has no proposed runs yet, or no driver was
 *  ever proposed more than once — same null-safe convention as
 *  formatMean/formatDurationMs. Neutral wording: a tally, not a verdict. */
export function repeatedPickLabel(repeatedPick: EvaluationSummary['repeatedPick']): string {
  if (!repeatedPick) return '—'
  return `most picked: ${repeatedPick.name ?? repeatedPick.driverId} in ${formatPct(repeatedPick.share)} of proposed runs`
}

/** Wall time for a step card. Deliberately browser-local (same rationale as
 *  AgentDrawer's inline `hhmm`) — this is a debug timestamp inside one run's
 *  timeline, not an org-tz scheduling fact. */
export function formatWallTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The timeline's chain labels (design §8 / task-7 brief): USER REQUEST ->
 *  MODEL -> TOOL REQUEST -> TOOL RESULT -> ... -> FINAL PROPOSAL, plus
 *  THINKING/ERROR as their own distinct kinds. `system` isn't named in that
 *  chain but still needs an unambiguous label rather than falling through. */
export const STEP_KIND_LABELS: Record<RunStepKind, string> = {
  system: 'SYSTEM',
  user: 'USER REQUEST',
  // Fix round 1: a nudge is the harness's own correction ("finish by calling
  // propose_decision"), not a real user turn — sharing "USER REQUEST" made
  // the two indistinguishable when scanning just the label column.
  nudge: 'NUDGE',
  assistant: 'MODEL',
  thinking: 'THINKING',
  tool_call: 'TOOL REQUEST',
  tool_result: 'TOOL RESULT',
  final: 'FINAL PROPOSAL',
  error: 'ERROR',
}

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running']

export function isActiveRunStatus(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status)
}

export function runStatusLabel(status: RunStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export const RUN_STATUS_CLASSES: Record<RunStatus, string> = {
  queued: 'bg-surface-3 text-ink-2',
  running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200',
  proposed: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200',
  incomplete: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
  failed: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200',
  cancelled: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200',
}
