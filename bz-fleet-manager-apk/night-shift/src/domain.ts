// The one door into fleet-backend's domain logic.
//
// The agent's differentiator — telling a legal break from an unplanned stop,
// pricing a route on real road — IS the dispatch platform's domain code. It is
// imported, never copied: a copy is a second definition, and this codebase has
// paid for that mistake repeatedly. Every other file in this package imports
// domain functions from here and nowhere else, so if the path ever moves it
// moves in one place.
//
// Only PURE modules are bridged. Nothing here may pull in prisma, express or
// a network client; the core must run in a test with no environment at all.
export {
  dwellSegments,
  DWELL_RADIUS_MI,
  type DwellSegment,
} from "../../fleet-backend/src/domain/dwell/segments.js";
export {
  breaksRequired,
  BREAK_THRESHOLD_MIN,
  BREAK_DURATION_MIN,
} from "../../fleet-backend/src/domain/dispatch/hos.js";
export { interpolate } from "../../fleet-backend/src/domain/dispatch/breakGeo.js";
export { haversineMi } from "../../fleet-backend/src/domain/dispatch/distance.js";
