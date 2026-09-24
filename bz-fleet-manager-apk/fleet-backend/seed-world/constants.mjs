// Small shared constants with no natural home in targets.mjs (a single
// baseline-numbers file) or any one scenario builder — re-exported through
// seed-world.mjs so a caller outside this folder (routes/dispatcherSim.ts)
// can import the org name without reaching into seed-world/* directly.
export { ORG_NAME as WORLD_ORG_NAME } from "./targets.mjs";

// driverAvailability.ts's own AVAILABLE_SOON_WINDOW_MS, mirrored here (no
// cross-package import from fleet-backend/src into this plain-JS folder):
// an active assignment reads as AVAILABLE_SOON rather than ON_LOAD once its
// planned end is within this many ms of now. current.mjs and
// scenarioLoads.mjs both import this one constant instead of each hand-
// copying the value.
export const AVAILABLE_SOON_WINDOW_MS = 4 * 60 * 60 * 1000;
