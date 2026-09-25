import { tools, TOOL_PARAMS, TOOL_NAMES, toolManifestJson, type ToolName } from "./manifest.js";

// dispatchTools/invoke.ts (Qwen Harness v0.1, Task 2): the one place a tool
// NAME (as a model, or later a route, names it) turns into an actual call
// against manifest.ts's `tools`. Everything here only reads what the 17
// functions in this directory already expose — no new query, no new business
// rule, and (like every other file under dispatchTools/) no write of any
// kind; tests/dispatch-tools.test.ts's static scan covers this file too.
//
// orgId is always the CALLER's own tenant (see manifest.ts's header comment)
// — it is never read out of `params`, so a model can never ask to read
// another org's data by naming a different orgId; none of the params schemas
// in manifest.ts even have an orgId field to attempt that with.

export type InvokeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code: "unknown_tool" | "invalid_params" | "tool_error" };

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as string[]).includes(name);
}

/** The first validation issue's field path plus its message — enough for a
 *  model (or a developer reading a failed run's transcript) to see exactly
 *  which argument was wrong, without dumping the whole ZodError. Typed
 *  structurally rather than against zod's `ZodError` so this file never has
 *  to pick a zod major version — it only reads the two properties every zod
 *  issue has had for years. */
function invalidParamsMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  // `.map(String)` first: `Array.prototype.join` coerces each element with
  // the same ToString that throws on a bare symbol, and a zod path's
  // PropertyKey type allows one even though none of this manifest's schemas
  // ever actually produces one.
  const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
  return `${field}: ${issue.message}`;
}

/** Each tool function's own positional signature, keyed the same way as
 *  `tools` — this is the thing that actually differs between the 17 (some
 *  take the whole validated params object, some pick specific fields off it,
 *  in a specific order). The `Record<ToolName, ...>` annotation makes
 *  forgetting one a compile error, the same discipline manifest.ts's own
 *  PARAMS/DESCRIPTIONS already use. */
const ARGS: Record<ToolName, (orgId: string, p: Record<string, unknown>) => unknown[]> = {
  getLoad: (orgId, p) => [orgId, p.loadId],
  searchLoads: (orgId, p) => [orgId, p],
  getUncoveredLoads: (orgId) => [orgId],
  getDriver: (orgId, p) => [orgId, p.driverId],
  searchDrivers: (orgId, p) => [orgId, p],
  getAvailableDrivers: (orgId) => [orgId],
  getDriverAvailability: (orgId, p) => [orgId, p.driverId],
  getDriverMetrics: (orgId, p) => [orgId, p.driverId],
  getDriverHistory: (orgId, p) => [orgId, p.driverId, p.limit],
  getDriverLocationHistory: (orgId, p) => [orgId, p.driverId, p.sinceMs],
  getCustomer: (orgId, p) => [orgId, p.customerId],
  getCustomerHistory: (orgId, p) => [orgId, p.customerId],
  getCurrentETA: (orgId, p) => [orgId, p.loadId],
  getLoadEvents: (orgId, p) => [orgId, p.loadId],
  getAgentEvents: (orgId, p) => [orgId, p.loadId],
  findFeasibleDrivers: (orgId, p) => [orgId, p.loadId],
  getDispatchCandidateDetails: (orgId, p) => [orgId, p.loadId, p.driverId],
};

/** Every tool function in `tools` takes its own specific positional args
 *  (see ARGS above) instead of one common shape, so calling one generically
 *  needs one escape hatch from that per-tool typing. Safe here because ARGS
 *  is what actually supplies the arguments, tool by tool, and every one of
 *  the 17 pairings is pinned by tests/ai-harness-invoke.test.ts. */
type AnyToolFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Validate `params` against the named tool's own schema, then call it with
 * `orgId` injected as the first argument. Never throws: a validation failure
 * or an error thrown by the tool itself both come back as a typed
 * `InvokeResult`, so a model-facing loop can hand either straight back to the
 * model as a tool result the same way it would a successful value.
 */
export async function invokeTool(orgId: string, name: string, params: unknown): Promise<InvokeResult> {
  if (!isToolName(name)) {
    return { ok: false, error: `Unknown tool "${name}".`, code: "unknown_tool" };
  }

  const parsed = TOOL_PARAMS[name].safeParse(params);
  if (!parsed.success) {
    return { ok: false, error: invalidParamsMessage(parsed.error), code: "invalid_params" };
  }

  try {
    const fn = tools[name] as AnyToolFn;
    const value = await fn(...ARGS[name](orgId, parsed.data as Record<string, unknown>));
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: "tool_error" };
  }
}

/** The manifest's JSON-schema tool definitions, reshaped into what a
 *  `ModelAdapter` sends as a `ChatRequest`'s `tools` (aiHarness/types.ts's
 *  `ToolDefinition[]`). The shape is repeated structurally instead of
 *  importing that type: dispatchTools/ sits BELOW aiHarness/ in this
 *  project's layering (the harness calls into the tool boundary, never the
 *  other way around), so this file cannot depend on it without inverting
 *  that. */
export function toolDefinitionsForModel(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return toolManifestJson().map((entry) => ({
    name: entry.name,
    description: entry.description,
    parameters: entry.params as Record<string, unknown>,
  }));
}
