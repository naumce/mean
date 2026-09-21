// Lifecycle presentation derived from the assignment status — no event log
// exists yet (spec §7.4: "lifecycle stepper is derived"). Checklist-driven
// refinements (POD) arrive with S3; `podOk` is the hook for them.
export type StepState = 'done' | 'current' | 'pending'

export const STEP_TITLES = ['Dispatched', 'Loaded @ pickup', 'In Transit', 'Delivered']
export const STEPS8 = ['Booked', 'Dispatched', 'At pickup', 'Loaded', 'Rolling', 'At delivery', 'Delivered', 'POD']

export function stepSegs(status: string | null | undefined): StepState[] {
  switch (status) {
    case 'completed':
    case 'delivered':
      return ['done', 'done', 'done', 'done']
    case 'in_progress':
      return ['done', 'done', 'current', 'pending']
    case 'assigned':
      return ['done', 'current', 'pending', 'pending']
    case 'tendered':
      return ['current', 'pending', 'pending', 'pending']
    default:
      return ['pending', 'pending', 'pending', 'pending']
  }
}

export function stepIndex(
  status: string | null | undefined,
  plannedStartMs: number | null,
  nowMs: number,
  podOk = false,
): number {
  switch (status) {
    case 'completed':
    case 'delivered':
      return podOk ? 7 : 6
    case 'in_progress':
      return 4
    case 'assigned':
      return plannedStartMs != null && plannedStartMs <= nowMs ? 2 : 1
    default:
      return 0
  }
}

/** Elapsed share of the planned window (0..1) for a rolling leg. */
export function progressShare(status: string | null | undefined, startMs: number, endMs: number, nowMs: number): number {
  if (status === 'completed' || status === 'delivered') return 1
  if (status !== 'in_progress') return 0
  if (endMs <= startMs) return 1
  return Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
}
