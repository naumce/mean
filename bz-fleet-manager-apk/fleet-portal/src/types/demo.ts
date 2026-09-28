// Demo Mode (2026-09-28 plan, Task 2): wire types for the backend
// orchestrator's /api/dispatcher/demo/story routes (Task 1, built
// concurrently against this same contract — see
// docs/superpowers/plans/2026-09-28-demo-mode.md). Every /demo/story* route
// 404s unless the server runs with DEMO_MODE=true; stores/demo.ts's probe()
// is the only place that sees and swallows that, same convention
// stores/sim.ts and stores/aiLab.ts already use for their own gated
// surfaces.
//
// PRESENTER SURFACE: `stages[].title`/`.narration` and every label this
// store derives from them are shown to a room, not a developer — plain
// business language only (DemoView.spec's forbidden-word check covers this
// text too).

/** The full stage vocabulary the backend can report on `story.stage`. Three
 *  of these collapse onto a different tile's presenter stage (see
 *  PRESENTER_STAGE_ALIAS in stores/demo.ts): `awaiting_driver_reply` ->
 *  driver_contacted, `awaiting_customer_update` -> escalated, `delivering`
 *  -> delivered. `error` never appears on the rail at all — DemoView shows
 *  it as a dedicated banner instead. */
export type DemoStage =
  | 'uncovered'
  | 'ai_recommendation'
  | 'awaiting_approval'
  | 'in_transit'
  | 'breakdown_detected'
  | 'driver_contacted'
  | 'awaiting_driver_reply'
  | 'escalated'
  | 'awaiting_customer_update'
  | 'customer_updated'
  | 'resolved'
  | 'delivering'
  | 'delivered'
  | 'error'

export interface DemoStoryLogEntry {
  atMs: number
  stage: string
  text: string
}

/** The DemoStory row (fleet-backend's Prisma model, Task 1) — every id
 *  besides `orgId` is nullable because the story starts with none of them
 *  set (`uncovered`) and fills in as the presenter walks the load through
 *  the real systems. */
export interface DemoStory {
  orgId: string
  stage: DemoStage
  loadId: string | null
  driverId: string | null
  assignmentId: string | null
  runId: string | null
  experimentId: string | null
  policyId: string | null
  customerId: string | null
  recommendedDriverId: string | null
  recommendationSource: 'ai' | 'engine' | null
  breakdownAtFraction: number
  /** Fix round 1 addition (Task 1): when the scripted breakdown actually
   *  fired. Not read anywhere in the portal UI — only `story.log`'s own
   *  narration text describes the breakdown to the presenter; this is here
   *  purely so the type mirrors the wire shape completely. */
  breakdownTriggeredAt: string | null
  holdStartedAt: string | null
  log: DemoStoryLogEntry[]
  error: string | null
  startedAt: string | null
  updatedAt: string
}

/** One tile of the ten-stage presenter rail, straight off `stages[]`. */
export interface DemoPresenterStageDef {
  id: string
  title: string
  narration: string
}

export interface DemoLinks {
  cockpitLoadId: string | null
  aiRunId: string | null
  driverId: string | null
  agentTimelineLoadId: string | null
}

export interface DemoWorkerInfo {
  configured: boolean
}

export interface DemoSimInfo {
  running: boolean
  speed: number | null
  simNowMs: number
}

/** GET /dispatcher/demo/story. `story` is null only before the very first
 *  Reset this org has ever run — nothing has been fixtured yet, so there is
 *  nothing to observe (the route still answers 200, not 404: DEMO_MODE is
 *  on, the story just hasn't started). There is no `recommendedDriverName`
 *  field on the wire — observeStory only ever names the recommended driver
 *  inside a log line ("AI recommends John Carter (confidence 0.85)." /
 *  "AI unavailable — using the deterministic recommendation: John
 *  Carter."), so stores/demo.ts reads it back out of `story.log` instead. */
export interface DemoStoryResponse {
  story: DemoStory | null
  stages: DemoPresenterStageDef[]
  waitingOn: string | null
  links: DemoLinks
  worker: DemoWorkerInfo
  sim: DemoSimInfo
  pill: string | null
}

/** POST /dispatcher/demo/story/reset and /demo/story/action both answer
 *  just the row — never the full GET shape above, which is why every write
 *  action in stores/demo.ts refetches afterward instead of hand-merging
 *  this into `data`. */
export interface DemoStoryActionResponse {
  story: DemoStory
}

export type DemoActionKind =
  | 'ask_ai'
  | 'approve'
  | 'driver_reply'
  | 'customer_update_sent'
  | 'resolve'
  | 'skip_arrival'
  | 'next'

/** POST /dispatcher/demo/story/action's body. A 409 answers
 *  `{ error: "WRONG_STAGE", stage }` when `action` no longer fits
 *  `story.stage`; a 503 answers `{ error: "WORKER_UNAVAILABLE", message }`
 *  for `driver_reply` when WORKER_URL is unset or the trip is missing. */
export interface DemoActionBody {
  action: DemoActionKind
  assignmentId?: string
  driverId?: string
  text?: string
}

/** A rail tile annotated with its position relative to the story's current
 *  stage — StageRail's only prop. */
export interface PresenterStageView extends DemoPresenterStageDef {
  status: 'done' | 'current' | 'upcoming'
}

/** The single action StageCard offers for the current stage, or null when
 *  the story is between human turns (nothing to click — Night Shift or the
 *  simulation is doing the next bit of work on its own). */
export interface DemoStageAction {
  kind: DemoActionKind
  label: string
  /** Secondary line under the button — the AI-vs-engine attribution, the
   *  "nothing leaves the system" sink notice, etc. */
  subline?: string
}
