import type { DemoStory } from "@prisma/client";

// Demo Mode: shared types for the story orchestrator. Everything here
// describes the PRESENTER's own view of state that Night Shift, the dispatch
// engine, the simulation engine and the AI harness already own — nothing in
// this module is read by any of them.

/** Every value `DemoStory.stage` can hold, in the order the story actually
 *  moves through them. A few of these have no card of their own in `STAGES`
 *  below — see each one's comment there for which card shows it. */
export type Stage =
  | "uncovered"
  | "ai_recommendation"
  | "awaiting_approval"
  | "in_transit"
  | "breakdown_detected"
  | "driver_contacted"
  | "awaiting_driver_reply"
  | "escalated"
  | "awaiting_customer_update"
  | "customer_updated"
  | "resolved"
  | "delivering"
  | "delivered"
  | "error";

export interface StageCard {
  id: string;
  title: string;
  narration: string;
}

/** The presenter's ten business-language cards. Static — returned the same
 *  way on every GET; which card is "current" is for the caller to read off
 *  `story.stage` against the aliases noted below, not something this list
 *  marks itself.
 *
 *  Three `stage` values share a neighbour's card rather than getting their
 *  own: `awaiting_driver_reply` shows on `driver_contacted`,
 *  `awaiting_customer_update` shows on `escalated`, and `delivering` shows on
 *  `delivered`. */
export const STAGES: readonly StageCard[] = [
  { id: "uncovered", title: "Uncovered load", narration: "A load has no driver assigned yet." },
  { id: "ai_recommendation", title: "Driver recommendation", narration: "Deciding who should run this load." },
  { id: "awaiting_approval", title: "Human approval", narration: "A dispatcher reviews the recommendation before anything is booked." },
  { id: "in_transit", title: "In transit", narration: "The truck is on the road toward delivery." },
  { id: "breakdown_detected", title: "Breakdown detected", narration: "Night Shift noticed the truck stopped somewhere unplanned." },
  { id: "driver_contacted", title: "Driver contacted", narration: "Night Shift reached out to the driver and is waiting to hear back." },
  { id: "escalated", title: "Escalated", narration: "Night Shift told the dispatcher what it found and what it recommends." },
  { id: "customer_updated", title: "Customer update", narration: "The customer has been told about the delay." },
  { id: "resolved", title: "Resolved", narration: "The truck is moving again and the load is back on track." },
  { id: "delivered", title: "Delivered", narration: "The load has arrived." },
];

/** One story write (a heartbeat transition or a human action): what changes
 *  on the DemoStory row, and what the presenter's log gains. `undefined` on
 *  any field means "leave it alone"; a stage-less patch (only `logTexts`) is
 *  how the scripted breakdown narrates without moving the story off
 *  "in_transit". Applied through `applyPatch` (patch.ts); the one direct
 *  write is observe's own error capture, which must land whatever else
 *  happened. */
export interface Patch {
  stage?: Stage;
  logTexts?: string[];
  recommendedDriverId?: string | null;
  recommendationSource?: string | null;
  holdStartedAt?: Date | null;
  breakdownTriggeredAt?: Date | null;
  runId?: string | null;
  assignmentId?: string | null;
  driverId?: string | null;
  error?: string | null;
}

export interface DemoStoryLinks {
  cockpitLoadId: string | null;
  aiRunId: string | null;
  driverId: string | null;
  agentTimelineLoadId: string | null;
}

export interface DemoStoryResponse {
  /** null only before the very first Reset for this org — nothing has been
   *  fixtured yet, so there is nothing to observe. */
  story: DemoStory | null;
  stages: readonly StageCard[];
  waitingOn: string | null;
  links: DemoStoryLinks;
  worker: { configured: boolean };
  sim: { running: boolean; speed: number | null; simNowMs: number };
  pill: string | null;
}

/** The actions `POST /demo/story/action` accepts. */
export const DEMO_ACTIONS = [
  "ask_ai",
  "approve",
  "driver_reply",
  "customer_update_sent",
  "resolve",
  "skip_arrival",
  "next",
] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];

/** An action that does not fit the story's current stage — the route answers
 *  409 with the stage the story is actually on. */
export class WrongStage extends Error {
  constructor(public readonly stage: string) {
    super(`action does not fit stage "${stage}"`);
  }
}

/** `driverReply`'s proxy has nothing to reach, or the worker refused: no
 *  `WORKER_URL`, no Night Shift trip for the load yet, a network failure, or
 *  any non-2xx answer. The route answers 503; nothing is logged as sent. */
export class WorkerUnavailable extends Error {}

/** An action whose stage fits but whose input does not — an assignment that
 *  is not this demo load's, a story with nothing to ask about. The route
 *  answers 400 with the message. */
export class InvalidAction extends Error {}

/** Approval refused because the worker may still be releasing the previous
 *  run (agentGate.ts). The route answers 409 with this message. */
export class NightShiftReleasing extends Error {
  constructor() {
    super("Night Shift is still releasing the previous demo — try again in a minute.");
  }
}

export type { DemoStory };
