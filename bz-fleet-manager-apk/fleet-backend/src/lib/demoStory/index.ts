// Demo Mode: the public surface `routes/dispatcherDemoStory.ts` calls.
// Everything else in this directory is an implementation detail.

export { resetDemo } from "./reset.js";
export { observeStory } from "./observe.js";
export { askAi, driverReply, next, recordApproval, recordCustomerUpdate, resolve, skipArrival } from "./actions.js";
export { waitingOnFor } from "./waitingOn.js";
export { STAGES, DEMO_ACTIONS, InvalidAction, NightShiftReleasing, WrongStage, WorkerUnavailable } from "./types.js";
export type { DemoAction, DemoStory, DemoStoryLinks, DemoStoryResponse, Stage, StageCard } from "./types.js";
