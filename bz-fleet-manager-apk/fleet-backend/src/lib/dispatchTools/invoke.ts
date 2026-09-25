import { tools, TOOL_PARAMS, TOOL_NAMES, toolManifestJson, type ToolName } from "./manifest.js";
import type { SuggestResult, SuggestCandidateRow } from "../suggestForLoad.js";

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
//
// projectForModel: the 17 functions above stay untouched (the portal calls
// them directly and still needs everything they return, e.g. the picker's
// scenario label) — this is the one seam between "what a tool function
// returns" and "what a model turn actually reads back", so a fact the tools
// legitimately expose to the rest of the codebase can still be kept out of
// the model's own context.

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

/** `value` is a plain JSON-shaped object (not `null`, not an array, not a
 *  `Date`/other class instance with its own identity) — the only kind of
 *  value `stripExtrasDeep` should walk into. A `Date`'s own enumerable own
 *  properties are empty, so treating one as a plain object would silently
 *  turn it into `{}` instead of leaving it alone. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A deep copy of `value` with every `extras` key removed, at any depth — the
 * seeded demo world keeps its scenario answer key at `Load.extras.scenario`
 * (`hint` names the expected driver), and no model turn may read it even
 * though `getLoad`/`searchLoads`/`getUncoveredLoads` still return it verbatim
 * to every other (non-model) caller. Deep rather than a top-level-only strip:
 * a `load`/`loads` field nested inside some OTHER tool's result must never
 * become a back door for the same data. `extras` exists on exactly one model
 * (`Load`, per the schema) so this never touches anything else.
 */
function stripExtrasDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExtrasDeep);
  if (!isPlainObject(value)) return value;

  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "extras") continue;
    projected[key] = stripExtrasDeep(child);
  }
  return projected;
}

/** `findFeasibleDrivers`'s compact, model-facing row shape — everything a
 *  dispatch decision actually weighs (deadhead, score, availability,
 *  lane/on-time/response history, HOS) without the ~1.6 KB/row the engine's
 *  full `SuggestCandidateRow` (+ its nested `CandidateContext`) costs.
 *  `marginCents`/`etaMs` are deliberately NOT here (round 2): with real
 *  driver ids/names and a realistic long `blockedReason`, keeping them
 *  pushed the worst case for `MAX_FEASIBLE_ROWS` + `MAX_BLOCKED_ROWS` rows
 *  past the 8192-byte per-result cap (measured 8351 B); dropping these two
 *  (an alternative's own margin/ETA is one `getDispatchCandidateDetails`
 *  call away) keeps the worst case under it with room to spare (measured
 *  7491 B — see tests/ai-harness-invoke.test.ts). `score`/`deadheadMi`/rate
 *  fields are rounded — a model has no use for floating-point noise, and it
 *  keeps the wire form compact. */
interface CompactFeasibleRow {
  driverId: string;
  driverName: string | null;
  score: number | null;
  deadheadMi: number;
  availabilityStatus: string | null;
  laneRuns: number | null;
  onTimeRate: number | null;
  responseRate: number | null;
  hosKnown: boolean | null;
}

interface CompactBlockedRow {
  driverId: string;
  driverName: string | null;
  blockedReason: string | null;
}

export interface CompactFeasibilityResult {
  loadId: string;
  requiredEquip: string;
  note: string | null;
  counts: { feasible: number; blocked: number; shownFeasible: number; shownBlocked: number };
  feasible: CompactFeasibleRow[];
  blocked: CompactBlockedRow[];
}

/** Caps on `feasible`/`blocked` (round 2: lowered from one shared 25 so the
 *  worst-case 165-driver payload fits the 8192-byte per-result cap — see the
 *  `CompactFeasibleRow` comment above) — a demo org's 165-driver pool would
 *  otherwise still cost the model everything the raw truncation used to,
 *  just reshaped; `counts` always says how many rows exist beyond what was
 *  shown, so a model that needs a specific driver outside the shown rows
 *  still knows to ask `getDispatchCandidateDetails` for it by id rather than
 *  assume the shown rows are the whole fleet. */
const MAX_FEASIBLE_ROWS = 20;
const MAX_BLOCKED_ROWS = 15;

function round2(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function toCompactFeasibleRow(row: SuggestCandidateRow): CompactFeasibleRow {
  return {
    driverId: row.driverId,
    driverName: row.driverName,
    score: round2(row.score),
    deadheadMi: round2(row.deadheadMi) ?? row.deadheadMi,
    availabilityStatus: row.context?.availability.status ?? null,
    laneRuns: row.context?.laneRuns ?? null,
    onTimeRate: round2(row.context?.onTimeRate),
    responseRate: round2(row.context?.responseRate),
    hosKnown: row.hosKnown ?? null,
  };
}

function toCompactBlockedRow(row: SuggestCandidateRow): CompactBlockedRow {
  return { driverId: row.driverId, driverName: row.driverName, blockedReason: row.blockedReason ?? null };
}

function isSuggestResultShape(value: unknown): value is SuggestResult {
  return value !== null && typeof value === "object" && Array.isArray((value as { candidates?: unknown }).candidates);
}

/** `findFeasibleDrivers`'s raw `SuggestResult` (every org driver, feasible
 *  and blocked, ~1.6 KB/row) reshaped into `CompactFeasibilityResult` — the
 *  model never sees the engine's own candidate array. `null`/an unrecognised
 *  shape passes through unchanged (mirrors `stripExtrasDeep`'s own
 *  never-throws discipline; a test double or an org with no result at all
 *  must not crash the harness loop). Rows keep the engine's own order
 *  (feasible-first, already how `suggestForLoad` builds `candidates`) —
 *  never re-sorted here. */
function projectFeasibleDrivers(value: unknown): unknown {
  if (!isSuggestResultShape(value)) return value;

  const feasibleRows = value.candidates.filter((c) => c.feasible);
  const blockedRows = value.candidates.filter((c) => !c.feasible);
  const result: CompactFeasibilityResult = {
    loadId: value.loadId,
    requiredEquip: value.requiredEquip,
    note: value.note ?? null,
    counts: {
      feasible: feasibleRows.length,
      blocked: blockedRows.length,
      shownFeasible: Math.min(feasibleRows.length, MAX_FEASIBLE_ROWS),
      shownBlocked: Math.min(blockedRows.length, MAX_BLOCKED_ROWS),
    },
    feasible: feasibleRows.slice(0, MAX_FEASIBLE_ROWS).map(toCompactFeasibleRow),
    blocked: blockedRows.slice(0, MAX_BLOCKED_ROWS).map(toCompactBlockedRow),
  };
  return result;
}

/**
 * The model-facing projection of a successful tool result — applied to EVERY
 * tool's value before it ever reaches the harness loop (`invokeTool` below),
 * never to what the 17 tool functions themselves return to any other caller.
 * `findFeasibleDrivers` gets the compact reshape (I2); everything else gets
 * `extras` stripped (C1) — a no-op for the 15 tools whose results were never
 * `Load`-shaped to begin with.
 */
export function projectForModel(name: string, value: unknown): unknown {
  if (name === "findFeasibleDrivers") return projectFeasibleDrivers(value);
  return stripExtrasDeep(value);
}

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
    return { ok: true, value: projectForModel(name, value) };
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
