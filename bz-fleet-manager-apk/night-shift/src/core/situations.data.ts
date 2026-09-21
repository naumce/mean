// GENERATED FILE — do not edit by hand.
//
// `npm run library:compile` writes this from library/situations.md, and
// tests/library-drift.test.ts fails the build if the two disagree. To change
// what the agent hears, edit the notebook and re-run the compile.
//
// Only blocks marked `Status: approved` are here. Proposed blocks stay in the
// notebook, reviewable and inert, until a human approves them.
import type { Situation } from "./types.js";

/** Order is the notebook's order, and it is load-bearing: on a tie the
 *  earlier situation wins, which is why `all_good` is last. */
export const SITUATIONS: readonly Situation[] = [
  {
    key: "breakdown", level: 3,
    response: "Understood. Are you safe? Dispatch is being notified now.",
    dispatcherNote: "Driver reports a breakdown.",
    examples: ["breakdown", "broke down", "broken down", "flat", "tire", "engine", "check engine", "won't start", "wont start", "tow", "mechanic", "overheating", "overheat"],
  },
  {
    key: "accident", level: 3,
    response: "Are you OK? Dispatch is being notified now.",
    dispatcherNote: "Driver reports an accident.",
    examples: ["accident", "crash", "crashed", "collision", "wreck", "ambulance", "hit a car", "got hit", "hit by", "rollover", "rolled the truck"],
  },
  {
    key: "inspection", level: 2,
    response: "Understood. Message me when you're rolling.",
    dispatcherNote: "Driver is stopped for police or a DOT inspection.",
    examples: ["police", "cop", "cops", "dot", "inspection", "weigh station", "scale", "scales", "pulled over"],
  },
  {
    key: "customer", level: 2,
    response: "Understood, I'm telling dispatch.",
    dispatcherNote: "Customer not ready, or wrong address.",
    examples: ["not ready", "nobody here", "no one here", "wrong address", "can't find", "cant find", "no dock", "waiting to unload", "waiting to load", "waiting on them", "is closed", "they are closed", "they're closed", "closed until", "close for lunch"],
  },
  {
    key: "traffic", level: 1,
    response: "Thanks — I'll update the ETA.",
    dispatcherNote: "Driver reports traffic or weather.",
    examples: ["traffic", "jam", "backed up", "construction", "weather", "snow", "ice", "rain", "fog", "wind", "road closed", "detour", "accident ahead", "up ahead", "waiting in queue", "moving very slow", "very slow", "closed the highway", "highway ahead"],
  },
  {
    key: "rest", level: 0,
    response: "Got it, thanks.",
    dispatcherNote: "Driver stopped for rest, bathroom, or food.",
    examples: ["bathroom", "restroom", "pee", "rest", "nap", "sleep", "sleeping", "coffee", "food", "eat", "eating", "lunch", "breakfast", "dinner", "taking a break", "on my break", "on break"],
  },
  {
    key: "fuel", level: 0,
    response: "Got it.",
    dispatcherNote: "Driver stopped for fuel.",
    examples: ["fuel", "fueling", "gas", "diesel", "fill up", "filling up", "pump"],
  },
  {
    key: "all_good", level: 0,
    response: "Thanks, drive safe.",
    dispatcherNote: "Driver says all is well.",
    examples: ["all good", "on my way", "rolling", "fine", "ok", "okay", "yes", "yep", "good", "no problem"],
  },
];
