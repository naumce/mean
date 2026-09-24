import { z } from "zod/v4";
import { getLoad, searchLoads, getUncoveredLoads } from "./loads.js";
import {
  getDriver,
  searchDrivers,
  getAvailableDrivers,
  getDriverAvailability,
  getDriverMetrics,
  getDriverHistory,
  getDriverLocationHistory,
} from "./drivers.js";
import { getCustomer, getCustomerHistory } from "./customers.js";
import { getCurrentETA } from "./eta.js";
import { getLoadEvents, getAgentEvents } from "./events.js";
import { findFeasibleDrivers, getDispatchCandidateDetails } from "./dispatch.js";
import { MAX_LIST_LIMIT } from "./limit.js";

// The read-only tool boundary's manifest (AI Dispatch Foundation, Task 5): a
// model-facing catalogue of the 17 functions below, published verbatim by
// GET /api/dispatcher/tools (routes/dispatcherTools.ts) so a future AI
// harness can discover what it may call before anything actually invokes one
// (no invoke endpoint exists yet — that is a later task).
//
// `params` deliberately never includes `orgId`: every function's first
// argument is the CALLER's own tenant, injected by the (future) server-side
// invoke layer from its authenticated session, exactly the way every
// existing dispatcher route reads `req.orgScope` — never a value the model
// itself supplies (letting a model choose its own orgId would turn this
// boundary into a cross-tenant read the moment an invoke endpoint exists).
// Nor does it include the `nowMs` override a couple of functions accept:
// that parameter exists so a TEST can fix "now", not so a model can pretend
// to call from a different moment. This is this task's own reasoned
// convention (not stated verbatim in the brief) — flagged in task-5-report.md.
//
// This file imports `zod/v4` (the v4 API zod 3.25 ships under a subpath) so
// `z.toJSONSchema` is available with no new dependency; every other file in
// this codebase keeps using v3's `import { z } from "zod"` — the two are
// never mixed in one file.

/** Every tool function, keyed by its own exported name — the one place this
 *  module lists all 17. `ToolName`/`TOOL_NAMES` and every `Record<ToolName,
 *  ...>` below are derived from this object, so adding or renaming a tool
 *  here is what the type checker uses to demand a matching description and
 *  params schema for it — forgetting either is a compile error, not just a
 *  failed test. */
export const tools = {
  getLoad,
  searchLoads,
  getUncoveredLoads,
  getDriver,
  searchDrivers,
  getAvailableDrivers,
  getDriverAvailability,
  getDriverMetrics,
  getDriverHistory,
  getDriverLocationHistory,
  getCustomer,
  getCustomerHistory,
  getCurrentETA,
  getLoadEvents,
  getAgentEvents,
  findFeasibleDrivers,
  getDispatchCandidateDetails,
} as const;

export type ToolName = keyof typeof tools;
export const TOOL_NAMES = Object.keys(tools) as ToolName[];

const LOAD_ID = z.string().min(1).describe("A Load's id.");
const DRIVER_ID = z.string().min(1).describe("A Driver's id.");
const CUSTOMER_ID = z.string().min(1).describe("A Customer's id.");
const LIMIT = z.number().int().min(1).max(MAX_LIST_LIMIT).describe(`Maximum rows to return (1-${MAX_LIST_LIMIT}).`);

const AVAILABILITY_STATUS = z.enum(["AVAILABLE", "AVAILABLE_SOON", "ON_LOAD", "OFF_DUTY", "UNAVAILABLE"]);

/** `z.ZodTypeAny` (zod v4's classic-API compat alias for `ZodType`,
 *  re-exported from `zod/v4` — see `node_modules/zod/v4/classic/compat.d.ts`)
 *  describes "any zod schema" without an `any`, so a shape of arbitrarily-typed
 *  fields (exactly what every entry below actually is) types as
 *  `Record<string, ZodTypeAny>` instead. */
type AnyParamsShape = Record<string, z.ZodTypeAny>;

/** One zod object per tool, keyed the same way as `tools` — the `Record<ToolName,
 *  ...>` annotation is what makes forgetting an entry (or misspelling one) a
 *  compile error instead of a silently-incomplete manifest. */
const PARAMS: Record<ToolName, z.ZodObject<AnyParamsShape>> = {
  getLoad: z.object({ loadId: LOAD_ID }),
  searchLoads: z.object({
    status: z.string().optional().describe("Load status, e.g. open|assigned|in_progress|delivered|canceled."),
    customerId: CUSTOMER_ID.optional(),
    fromMs: z.number().optional().describe("Lower bound (epoch ms) on the first stop's pickup window."),
    toMs: z.number().optional().describe("Upper bound (epoch ms) on the first stop's pickup window."),
    uncovered: z.boolean().optional().describe("true = only loads with no active assignment."),
    limit: LIMIT.optional(),
  }),
  getUncoveredLoads: z.object({}),
  getDriver: z.object({ driverId: DRIVER_ID }),
  searchDrivers: z.object({
    status: AVAILABILITY_STATUS.optional().describe("Availability status to filter on."),
    equipment: z.string().optional().describe("Trailer type the driver must be qualified on, e.g. Reefer."),
    language: z.string().optional().describe("Language the driver speaks (spoken or preferred)."),
    state: z.string().optional().describe("Driver's home base state code, e.g. MO."),
    acceptingLoads: z.boolean().optional(),
    limit: LIMIT.optional(),
  }),
  getAvailableDrivers: z.object({}),
  getDriverAvailability: z.object({ driverId: DRIVER_ID }),
  getDriverMetrics: z.object({ driverId: DRIVER_ID }),
  getDriverHistory: z.object({ driverId: DRIVER_ID, limit: LIMIT.optional().describe("Defaults to 50.") }),
  getDriverLocationHistory: z.object({
    driverId: DRIVER_ID,
    sinceMs: z.number().describe("Only pings at or after this epoch ms."),
  }),
  getCustomer: z.object({ customerId: CUSTOMER_ID }),
  getCustomerHistory: z.object({ customerId: CUSTOMER_ID }),
  getCurrentETA: z.object({ loadId: LOAD_ID }),
  getLoadEvents: z.object({ loadId: LOAD_ID }),
  getAgentEvents: z.object({ loadId: LOAD_ID }),
  findFeasibleDrivers: z.object({ loadId: LOAD_ID }),
  getDispatchCandidateDetails: z.object({ loadId: LOAD_ID, driverId: DRIVER_ID }),
};

const DESCRIPTIONS: Record<ToolName, string> = {
  getLoad:
    "Returns one load with its ordered stops, appointments, linked customer, and current assignment; use when you already know the load's id and need its full detail. Returns null if the load does not exist.",
  searchLoads:
    "Returns loads matching optional status/customer/pickup-window/coverage filters, newest first; use to find loads by criteria rather than by id.",
  getUncoveredLoads:
    "Returns open loads with no active assignment whose pickup window has not been over for more than 24 hours, soonest pickup first; use to see what still needs a driver.",
  getDriver:
    "Returns one driver's profile (qualifications, home base, last known position) and current availability, without performance metrics; use when you already know the driver's id.",
  searchDrivers:
    "Returns drivers matching optional availability-status/equipment/language/state/accepting-loads filters; use to find drivers by criteria rather than by id.",
  getAvailableDrivers:
    "Returns drivers who are AVAILABLE or AVAILABLE_SOON and accepting loads, soonest-available first; use when looking for who could take a new load right now.",
  getDriverAvailability:
    "Returns one driver's current availability (status, where and when they will be free); use for a quick availability check without the rest of their profile.",
  getDriverMetrics:
    "Returns one driver's evidence-derived performance metrics (on-time rate, detention, response behavior, lane experience); use when judging how a driver has actually performed.",
  getDriverHistory:
    "Returns one driver's completed assignments, most recently completed first, each with lane and on-time detail; use to review what a driver has actually run.",
  getDriverLocationHistory:
    "Returns a driver's raw location pings since a given time, oldest first; use to trace where a driver has actually been.",
  getCustomer: "Returns one customer's profile and how many loads it has; use when you already know the customer's id.",
  getCustomerHistory:
    "Returns one customer's volume, on-time rate, common lanes, and detention history; use when judging a customer's track record.",
  getCurrentETA:
    "Returns the load's best-known current ETA — the agent's live itinerary when one exists, else the assignment's planned end while that assignment is still active or completed (never a canceled one), else none; use for the freshest delivery-time estimate.",
  getLoadEvents:
    "Returns a load's change history and agent status updates merged into one timeline, oldest first; use to see everything that has happened to a load.",
  getAgentEvents:
    "Returns the Night Shift agent's own trip and event trail for a load, newest trip first with its events oldest first; use to inspect the agent's raw evidence.",
  findFeasibleDrivers:
    "Returns every org driver ranked for a specific load — feasible candidates scored, infeasible ones with a reason; use when deciding who should take a load.",
  getDispatchCandidateDetails:
    "Returns one specific driver's ranking row for one specific load; use to inspect a single candidate after findFeasibleDrivers has already been called.",
};

export interface ToolSpec {
  name: ToolName;
  description: string;
  params: z.ZodObject<AnyParamsShape>;
  readOnly: true;
}

/** One manifest entry per tool in `tools`, in the same order. The
 *  `Record<ToolName, ...>` type of PARAMS/DESCRIPTIONS above already
 *  guarantees every name has both; this just assembles them into the
 *  published shape. */
export const TOOL_MANIFEST: ToolSpec[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  params: PARAMS[name],
  readOnly: true as const,
}));

/**
 * `TOOL_MANIFEST`, with each entry's zod schema replaced by its JSON Schema —
 * what `GET /api/dispatcher/tools` actually publishes. zod 3.25 ships zod v4
 * under the `zod/v4` subpath with a built-in `z.toJSONSchema`, so this needs
 * no new dependency and no hand-written schema mapper.
 */
export function toolManifestJson() {
  return TOOL_MANIFEST.map((spec) => ({
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    params: z.toJSONSchema(spec.params),
  }));
}
