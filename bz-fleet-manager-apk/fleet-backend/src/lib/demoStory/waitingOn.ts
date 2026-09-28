import type { DemoStory } from "@prisma/client";
import { isNightShiftReleasing } from "./agentGate.js";
import { evidenceOf, latest, tripsAndEvents } from "./observeEvents.js";

// Demo Mode: what GET /demo/story tells the presenter is the pending human
// action, if any. One string per stage that actually waits on a person;
// every automatic or terminal stage answers null. "night_shift_releasing" is
// the one value that is not an action: approval would be refused right now
// (agentGate.ts), so the presenter is told to wait a moment instead.

export async function waitingOnFor(story: DemoStory, nowMs: number = Date.now()): Promise<string | null> {
  switch (story.stage) {
    case "uncovered": return "ask_ai";
    case "awaiting_approval": {
      if (story.loadId && (await isNightShiftReleasing(story.loadId, nowMs))) return "night_shift_releasing";
      return "approve";
    }
    case "awaiting_driver_reply": return "driver_reply";
    case "awaiting_customer_update": {
      // No draft attached leaves the story waiting on "Resolve" directly
      // rather than on a send it cannot make.
      if (!story.loadId) return "resolve";
      const { events } = await tripsAndEvents(story.loadId);
      const escalation = latest(events, (e) => e.kind === "escalation");
      const draftAttached = escalation ? Boolean(evidenceOf(escalation).draftAttached) : false;
      return draftAttached ? "customer_update_sent" : "resolve";
    }
    case "customer_updated": return "resolve";
    case "delivering": return "skip_arrival";
    default: return null;
  }
}
