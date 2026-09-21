// Public surface of the dispatch rules engine. The route/DB layer imports from
// here; internal modules stay small and independently testable.
export * from "./types.js";
export { evaluate, snap15 } from "./evaluate.js";
export { breaksRequired, evaluateHos } from "./hos.js";
export { interpolate } from "./breakGeo.js";
export { haversineMi, roadMiles, driveMinutes } from "./distance.js";
export {
  computeEconomics,
  DEFAULT_RATE_CONFIG,
  type RateConfig,
  type RateBreakdown,
} from "./economics.js";
export {
  suggest,
  DEFAULT_WEIGHTS,
  type SuggestWeights,
  type SuggestConfig,
  type Candidate,
  type SuggestRow,
} from "./suggest.js";
export {
  checkEquipment,
  checkHazmat,
  checkDriverAvailable,
  checkTractorAvailable,
  checkTrailerAvailable,
  checkOverlap,
} from "./checks.js";
export {
  rankRestOptions,
  REST_SEARCH_RADIUS_MI,
  type RestCandidate,
  type RestOption,
} from "./restOptions.js";
export {
  restConflict,
  COVERAGE_RADIUS_MI,
  type RestCoverage,
} from "./restConflict.js";
export { fuelBurn, type FuelBurn } from "./fuel.js";
export {
  fuelAdvice,
  MIN_SAVING_CENTS,
  type PricedStop,
  type FuelAdvice,
} from "./fuelAdvice.js";
export {
  attributeGallons,
  type AttributionLeg,
  type StateGallons,
  type IftaAttribution,
} from "./iftaAttribution.js";
