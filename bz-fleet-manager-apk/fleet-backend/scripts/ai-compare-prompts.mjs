#!/usr/bin/env node
// scripts/ai-compare-prompts.mjs (dispatch-v2 A/B experiment, Task 1): reads
// two (or more) already-run experiments' evaluations — one set run under
// dispatch-v1, one under dispatch-v2 — and prints/writes a side-by-side
// behavioural comparison. This script never enqueues a run of its own; it
// only reads GET /ai/experiments/:id/evaluation for experiment ids the
// caller already ran to completion (ai-eval-scenarios.mjs, or the AI Lab UI).
//
// Usage:
//   AI_COMPARE_V1_IDS=<id1,id2,...> AI_COMPARE_V2_IDS=<id1,id2,...> \
//     node scripts/ai-compare-prompts.mjs
//
// Env:
//   BASE_URL           backend origin (default http://localhost:3001)
//   AI_EVAL_EMAIL      dispatcher login email (default w@fleet.com)
//   AI_EVAL_PASSWORD   dispatcher login password (default pass123)
//   AI_COMPARE_V1_IDS  comma-separated dispatch-v1 experiment ids (required)
//   AI_COMPARE_V2_IDS  comma-separated dispatch-v2 experiment ids (required)
//
// Either env may list more than one experiment id (e.g. several run labels
// of the same prompt) — every row from every listed experiment is folded
// into that prompt's own combined table/aggregates.
//
// This script never prints AI_EVAL_PASSWORD, the login token, or any
// Authorization header value.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// fleet-backend/scripts -> fleet-backend -> bz-fleet-manager-apk -> docs/...
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
const EMAIL = process.env.AI_EVAL_EMAIL ?? "w@fleet.com";
const PASSWORD = process.env.AI_EVAL_PASSWORD ?? "pass123";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
// A misconfigured comparison (wrong ids, mismatched config) — distinct from
// EXIT_ERROR's "something broke" so a caller's script can tell "fix your
// inputs" apart from "the backend/network failed".
const EXIT_MISMATCH = 2;

function fail(message, code = EXIT_ERROR) {
  console.error(message);
  process.exit(code);
}

function idsFrom(envValue, label) {
  const ids = (envValue ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) fail(`${label} must list at least one experiment id (comma-separated).`);
  return ids;
}

/** One HTTP call against the backend. Never logs `body` (which may carry the
 *  login password on the one call that sends it) or the Authorization header
 *  it builds from `token` — same discipline as ai-eval-scenarios.mjs's own
 *  `request` helper. */
async function request(method, path, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`${method} ${path} could not reach ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // No/invalid JSON body — callers that need one check for it themselves.
  }
  return { status: res.status, ok: res.ok, body: json };
}

async function login() {
  const res = await request("POST", "/api/auth/dispatcher/login", { body: { email: EMAIL, password: PASSWORD } });
  if (!res.ok || typeof res.body?.token !== "string") {
    fail(`Login failed for ${EMAIL} against ${BASE_URL} (HTTP ${res.status}). Check AI_EVAL_EMAIL/AI_EVAL_PASSWORD/BASE_URL and that the backend is running.`);
  }
  return res.body.token;
}

async function fetchExperiment(token, experimentId) {
  const res = await request("GET", `/api/dispatcher/ai/experiments/${experimentId}`, { token });
  if (!res.ok) throw new Error(`GET .../experiments/${experimentId} failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.experiment;
}

async function fetchEvaluation(token, experimentId) {
  const res = await request("GET", `/api/dispatcher/ai/experiments/${experimentId}/evaluation`, { token });
  if (!res.ok) throw new Error(`GET .../experiments/${experimentId}/evaluation failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.evaluation;
}

/** The `run <label>` suffix ai-eval-scenarios.mjs's own generated experiment
 *  names carry (`Scenarios A–H · <prompt> · <model> · run <label>`) — falls
 *  back to the full name (still a stable, comparable string) for an
 *  experiment named some other way, e.g. via AI_EVAL_EXPERIMENT_NAME. */
function runLabelOf(name) {
  const match = /run\s+(\S+)\s*$/.exec(name ?? "");
  return match ? match[1] : (name ?? "");
}

/** Every row from every listed experiment id, combined into one array and
 *  sorted by scenario code then run label — each env var names one PROMPT's
 *  own set of already-run experiments (e.g. more than one run label), not a
 *  single experiment each, so without this sort the same scenario's rows
 *  from two different run labels would land far apart (each experiment's own
 *  rows arrive newest-first, one experiment's whole block before the next). */
async function loadPrompt(token, experimentIds) {
  const experiments = [];
  const rows = [];
  for (const id of experimentIds) {
    const [experiment, evaluation] = await Promise.all([fetchExperiment(token, id), fetchEvaluation(token, id)]);
    experiments.push(experiment);
    const runLabel = runLabelOf(experiment.name);
    for (const row of evaluation.rows) rows.push({ ...row, runLabel });
  }
  rows.sort((a, b) => {
    const byScenario = (a.scenario?.code ?? "").localeCompare(b.scenario?.code ?? "");
    return byScenario !== 0 ? byScenario : a.runLabel.localeCompare(b.runLabel);
  });
  return { experiments, rows };
}

/** Every V1 experiment must actually be a dispatch-v1 run and every V2 one a
 *  dispatch-v2 run — a swapped env var would otherwise produce a confidently
 *  mislabeled report with no indication anything was wrong. */
function verifyPromptVersions(experiments, expectedVersion, envName) {
  for (const e of experiments) {
    if (e.promptVersion !== expectedVersion) {
      fail(
        `${envName} experiment "${e.name}" (${e.id}) has promptVersion "${e.promptVersion}", not "${expectedVersion}".`,
        EXIT_MISMATCH,
      );
    }
  }
}

/** The keys where two harness configs differ, by shallow value comparison
 *  (every `HarnessConfig` field — model/temperature/numCtx/the caps — is a
 *  primitive, so `JSON.stringify` equality per key is exact, not an
 *  approximation) — empty when `configs` all match. */
function differingConfigKeys(configs) {
  const keys = new Set();
  for (const config of configs) for (const key of Object.keys(config ?? {})) keys.add(key);
  const differing = [];
  for (const key of keys) {
    const values = new Set(configs.map((c) => JSON.stringify(c?.[key])));
    if (values.size > 1) differing.push(key);
  }
  return differing.sort();
}

function fmt(value, digits) {
  if (value === null || value === undefined) return "—";
  return typeof digits === "number" ? value.toFixed(digits) : String(value);
}

function fmtPct(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

function fmtName(pick) {
  if (!pick) return "—";
  return pick.name ?? pick.driverId ?? "—";
}

const ROW_HEADER = [
  "Scenario", "Load ref", "Pick", "Deterministic top", "Confidence", "Turns", "Tool calls",
  "Unique tools", "Investigated", "Invalid calls", "Termination", "Duration (s)", "Tokens (prompt+completion)",
];

function rowLine(row) {
  return [
    row.scenario?.code ?? "—",
    row.loadRef ?? "—",
    fmtName(row.pick),
    fmtName(row.deterministicTop),
    fmt(row.confidence, 2),
    fmt(row.turns),
    fmt(row.toolCalls),
    fmt(row.uniqueTools),
    fmt(row.candidatesInvestigated),
    fmt(row.invalidCalls),
    row.terminationReason ?? "—",
    row.latencyMs != null ? (row.latencyMs / 1000).toFixed(1) : "—",
    `${fmt(row.promptTokens)}+${fmt(row.completionTokens)}`,
  ];
}

function toMarkdownTable(header, lines) {
  if (lines.length === 0) return "_No runs._";
  const head = `| ${header.join(" | ")} |`;
  const divider = `| ${header.map(() => "---").join(" | ")} |`;
  const body = lines.map((r) => `| ${r.join(" | ")} |`);
  return [head, divider, ...body].join("\n");
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** The eight aggregate figures the brief names, computed over ONE prompt's
 *  own combined rows — mirrors aiHarness/evaluation.ts's own EvaluationSummary
 *  fields, recomputed here (rather than averaging each source experiment's
 *  own summary) because a comparison can span MULTIPLE experiments per
 *  prompt, and an average of averages would weight a smaller experiment's
 *  runs the same as a larger one's. */
function aggregatesFor(rows) {
  const proposed = rows.filter((r) => r.status === "proposed");
  const matched = proposed.filter((r) => r.matchesDeterministicTop === true);

  const bands = { "≥0.90": 0, "0.70–0.89": 0, "0.50–0.69": 0, "<0.50": 0 };
  for (const r of proposed) {
    if (r.confidence === null || r.confidence === undefined) continue;
    if (r.confidence >= 0.9) bands["≥0.90"] += 1;
    else if (r.confidence >= 0.7) bands["0.70–0.89"] += 1;
    else if (r.confidence >= 0.5) bands["0.50–0.69"] += 1;
    else bands["<0.50"] += 1;
  }

  // Most-picked non-null driver's share of proposed runs — ties keep
  // whichever driver was picked first, by row order.
  const pickCounts = new Map();
  for (const r of proposed) {
    const id = r.pick?.driverId;
    if (!id) continue;
    if (!pickCounts.has(id)) pickCounts.set(id, { count: 0, name: r.pick?.name ?? null });
    pickCounts.get(id).count += 1;
  }
  let repeatedPick = null;
  let bestCount = 0;
  for (const [driverId, entry] of pickCounts) {
    if (entry.count > bestCount) {
      bestCount = entry.count;
      repeatedPick = { driverId, name: entry.name, share: entry.count / proposed.length };
    }
  }

  return {
    runs: rows.length,
    proposed: proposed.length,
    completionRate: rows.length === 0 ? null : proposed.length / rows.length,
    engineAgreementRate: proposed.length === 0 ? null : matched.length / proposed.length,
    meanCandidatesInvestigated: mean(proposed.map((r) => r.candidatesInvestigated).filter((v) => v !== null && v !== undefined)),
    meanTurns: mean(proposed.map((r) => r.turns)),
    meanToolCalls: mean(proposed.map((r) => r.toolCalls)),
    meanConfidence: mean(proposed.map((r) => r.confidence).filter((v) => v !== null && v !== undefined)),
    confidenceBands: bands,
    repeatedPick,
  };
}

function aggregatesSection(label, agg) {
  const bandsLine = Object.entries(agg.confidenceBands).map(([band, count]) => `${band}: ${count}`).join(", ");
  const repeatedLine = agg.repeatedPick
    ? `${agg.repeatedPick.name ?? agg.repeatedPick.driverId} — ${fmtPct(agg.repeatedPick.share)} of proposed runs`
    : "—";
  return [
    `### ${label}`,
    "",
    `- Runs: ${agg.runs} (${agg.proposed} proposed)`,
    `- Completion rate (proposed / runs): ${fmtPct(agg.completionRate)}`,
    `- Engine agreement rate (matched deterministic top / proposed): ${fmtPct(agg.engineAgreementRate)}`,
    `- Mean candidates investigated: ${fmt(agg.meanCandidatesInvestigated, 2)}`,
    `- Mean turns: ${fmt(agg.meanTurns, 1)}`,
    `- Mean tool calls: ${fmt(agg.meanToolCalls, 1)}`,
    `- Mean confidence: ${fmt(agg.meanConfidence, 2)}`,
    `- Confidence distribution: ${bandsLine}`,
    `- Repeated-driver-selection frequency: ${repeatedLine}`,
    "",
  ].join("\n");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const v1Ids = idsFrom(process.env.AI_COMPARE_V1_IDS, "AI_COMPARE_V1_IDS");
  const v2Ids = idsFrom(process.env.AI_COMPARE_V2_IDS, "AI_COMPARE_V2_IDS");

  console.log(`Logging in as ${EMAIL} against ${BASE_URL}…`);
  const token = await login();

  console.log(`Fetching dispatch-v1 evaluation(s): ${v1Ids.join(", ")}`);
  console.log(`Fetching dispatch-v2 evaluation(s): ${v2Ids.join(", ")}`);
  const [v1, v2] = await Promise.all([loadPrompt(token, v1Ids), loadPrompt(token, v2Ids)]);

  verifyPromptVersions(v1.experiments, "dispatch-v1", "AI_COMPARE_V1_IDS");
  verifyPromptVersions(v2.experiments, "dispatch-v2", "AI_COMPARE_V2_IDS");

  // "the same harness configuration" is a claim this report makes about the
  // comparison, not an assumption — verified across every experiment on
  // BOTH sides before it is printed, so a differently-configured experiment
  // fails loudly instead of quietly mislabeling the report as apples-to-apples.
  const allExperiments = [...v1.experiments, ...v2.experiments];
  const differingKeys = differingConfigKeys(allExperiments.map((e) => e.config));
  if (differingKeys.length > 0) {
    fail(
      `Experiments do not share the same harness config — differing key(s): ${differingKeys.join(", ")}. ` +
        `Compare experiments with matching config, or note the difference explicitly instead of using this script.`,
      EXIT_MISMATCH,
    );
  }
  const sharedConfig = allExperiments[0]?.config ?? null;

  const doc = [
    `# dispatch-v1 vs dispatch-v2 — ${todayIso()}`,
    "",
    "Both prompt versions ran against the same model and the same harness configuration (verified below); only " +
      "the prompt text, terminal schema, and protocol validation differ between them. The tables and figures " +
      "below are behavioural data recorded from each run — what each prompt version actually did — not a verdict " +
      "on which one is right for this fleet's own dispatch decisions.",
    "",
    `- dispatch-v1 experiment(s): ${v1Ids.join(", ")}`,
    `- dispatch-v2 experiment(s): ${v2Ids.join(", ")}`,
    "- Shared harness config:",
    "",
    "```json",
    JSON.stringify(sharedConfig, null, 2),
    "```",
    "",
    "## Per-scenario runs",
    "",
    "One row per run, grouped by prompt version.",
    "",
    "### dispatch-v1",
    "",
    toMarkdownTable(ROW_HEADER, v1.rows.map(rowLine)),
    "",
    "### dispatch-v2",
    "",
    toMarkdownTable(ROW_HEADER, v2.rows.map(rowLine)),
    "",
    "## Aggregates",
    "",
    aggregatesSection("dispatch-v1", aggregatesFor(v1.rows)),
    aggregatesSection("dispatch-v2", aggregatesFor(v2.rows)),
  ].join("\n");

  console.log("");
  console.log(doc);

  const outDir = join(REPO_ROOT, "docs", "evaluations");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${todayIso()}-dispatch-v1-vs-v2.md`);
  await writeFile(outPath, doc, "utf8");
  console.log(`Wrote ${outPath}`);

  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(EXIT_ERROR);
});
