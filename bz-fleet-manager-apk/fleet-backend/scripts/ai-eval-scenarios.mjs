#!/usr/bin/env node
// scripts/ai-eval-scenarios.mjs (Qwen Harness v0.1, Task 8): drives the eight
// dispatch scenarios (W-A-RELIABLE … W-H-PRIORITY) through a running backend
// and a real Ollama server, then prints and saves the resulting evaluation
// table. Plain Node ESM — no ts-node/tsx, no Prisma import — so it only ever
// needs a backend to talk HTTP to, never a direct database connection of its
// own. Usage:
//
//   node scripts/ai-eval-scenarios.mjs
//
// Env (all optional):
//   BASE_URL          backend origin (default http://localhost:3001)
//   AI_EVAL_EMAIL      dispatcher login email (default w@fleet.com)
//   AI_EVAL_PASSWORD   dispatcher login password (default pass123)
//   AI_EVAL_MODEL      Ollama model tag (default qwen3:8b)
//   AI_EVAL_PROMPT     prompt version to run (default dispatch-v1) — must be
//                      one GET /ai/status.promptVersions lists
//   AI_EVAL_RUN_LABEL  distinguishes repeat runs of the same prompt/model
//                      (default "1") — folded into the experiment name and
//                      the output filename, never the experiment's identity
//                      otherwise (two runs with the same label reuse one
//                      experiment, same as before this label existed)
//   AI_EVAL_EXPERIMENT_NAME  overrides the generated experiment name outright
//   AI_EVAL_MAX_WAIT_MS  safety ceiling on the whole polling phase
//                        (default 5400000 = 90 minutes; the 8 scenarios run
//                        one at a time, so this is generous headroom over
//                        8 x maxRunMs at the harness's own 600000ms default)
//
// Prerequisites: the world must already be seeded (`node seed-world.mjs`)
// and the backend must be running with OLLAMA_URL set and pointed at a
// reachable Ollama server that has AI_EVAL_MODEL pulled.
//
// This script never prints AI_EVAL_PASSWORD, the login token, or any
// Authorization header value.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../seed-world/scenarios.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// fleet-backend/scripts -> fleet-backend -> bz-fleet-manager-apk -> docs/...
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
const EMAIL = process.env.AI_EVAL_EMAIL ?? "w@fleet.com";
const PASSWORD = process.env.AI_EVAL_PASSWORD ?? "pass123";
const MODEL = process.env.AI_EVAL_MODEL ?? "qwen3:8b";
const PROMPT_VERSION = process.env.AI_EVAL_PROMPT ?? "dispatch-v1";
const RUN_LABEL = process.env.AI_EVAL_RUN_LABEL ?? "1";
const EXPERIMENT_NAME_OVERRIDE = process.env.AI_EVAL_EXPERIMENT_NAME;
const MAX_WAIT_MS = Number(process.env.AI_EVAL_MAX_WAIT_MS ?? 90 * 60 * 1000);

const POLL_INTERVAL_MS = 3000;
const ENQUEUE_RETRY_DELAY_MS = 3000;
const MAX_ENQUEUE_ATTEMPTS = 5;
const TERMINAL_STATUSES = new Set(["proposed", "incomplete", "failed", "cancelled"]);
// A-H only — I..N are in-progress/completed scenarios with no uncovered load
// of their own to run a dispatch decision against.
const SCENARIO_CODES_A_TO_H = ["A", "B", "C", "D", "E", "F", "G", "H"];

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_DISABLED_OR_UNREACHABLE = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message, code = EXIT_ERROR) {
  console.error(message);
  process.exit(code);
}

/** One HTTP call against the backend. Never logs `body` (which may carry the
 *  login password on the one call that sends it) or the Authorization header
 *  it builds from `token`. */
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

/** Logs in as AI_EVAL_EMAIL and returns the bearer token — the exact path and
 *  field dispatcherAuth.ts's POST /dispatcher/login and the portal's own
 *  login call both use. */
async function login() {
  const res = await request("POST", "/api/auth/dispatcher/login", { body: { email: EMAIL, password: PASSWORD } });
  if (!res.ok || typeof res.body?.token !== "string") {
    fail(`Login failed for ${EMAIL} against ${BASE_URL} (HTTP ${res.status}). Check AI_EVAL_EMAIL/AI_EVAL_PASSWORD/BASE_URL and that the backend is running.`);
  }
  return res.body.token;
}

/** GET /ai/status, or a clean exit(2) if the harness is disabled (the whole
 *  /ai/* surface 404s when OLLAMA_URL is unset on the backend) or Ollama is
 *  unreachable from it. */
async function checkStatus(token) {
  const res = await request("GET", "/api/dispatcher/ai/status", { token });
  if (res.status === 404) {
    fail(
      "AI harness is disabled on this backend (OLLAMA_URL is not set). Set OLLAMA_URL and restart the backend, then re-run this script.",
      EXIT_DISABLED_OR_UNREACHABLE,
    );
  }
  if (!res.ok) {
    fail(`GET /api/dispatcher/ai/status returned HTTP ${res.status} — cannot continue.`);
  }
  const status = res.body;
  if (!status?.ollama?.reachable) {
    fail(
      `Ollama is not reachable from the backend (${status?.ollama?.error ?? "unknown error"}). Start Ollama and confirm OLLAMA_URL points at it, then re-run this script.`,
      EXIT_DISABLED_OR_UNREACHABLE,
    );
  }
  const knownModels = Array.isArray(status.ollama.models) ? status.ollama.models : [];
  if (!knownModels.includes(MODEL)) {
    console.warn(
      `Warning: Ollama does not list "${MODEL}" among its pulled models (${knownModels.join(", ") || "none"}). ` +
        `Continuing anyway — \`ollama pull ${MODEL}\` if the runs below fail with a model error.`,
    );
  }
  const knownPromptVersions = Array.isArray(status.promptVersions) ? status.promptVersions : [];
  if (!knownPromptVersions.includes(PROMPT_VERSION)) {
    fail(`AI_EVAL_PROMPT "${PROMPT_VERSION}" is not one of this backend's promptVersions (${knownPromptVersions.join(", ") || "none"}).`);
  }
  return status;
}

/** The one experiment this script always targets: found by exact name if it
 *  already exists (a prior run of this script), created otherwise. Naming the
 *  model AND the run label into the experiment name means a different
 *  AI_EVAL_MODEL or a repeat run under a new AI_EVAL_RUN_LABEL is always a
 *  different experiment — never a config (or a previous run's own results)
 *  hiding inside a shared one. AI_EVAL_EXPERIMENT_NAME overrides the
 *  generated name outright, for a caller that wants to target/create a
 *  specific experiment by name regardless of this naming scheme. */
async function findOrCreateExperiment(token, promptVersion) {
  const name = EXPERIMENT_NAME_OVERRIDE ?? `Scenarios A–H · ${promptVersion} · ${MODEL} · run ${RUN_LABEL}`;

  const list = await request("GET", "/api/dispatcher/ai/experiments", { token });
  if (!list.ok) throw new Error(`GET /api/dispatcher/ai/experiments failed (HTTP ${list.status}).`);
  const existing = (list.body?.experiments ?? []).find((e) => e.name === name);
  if (existing) {
    // A found-by-name reuse (most likely via AI_EVAL_EXPERIMENT_NAME, which
    // bypasses this script's own naming scheme) must still match what THIS
    // invocation asked for — otherwise the output file/header would claim a
    // prompt or model the runs never actually used.
    if (existing.promptVersion !== promptVersion) {
      fail(
        `Experiment "${name}" (${existing.id}) already exists with promptVersion "${existing.promptVersion}", ` +
          `not the requested "${promptVersion}". Use a different AI_EVAL_EXPERIMENT_NAME/AI_EVAL_RUN_LABEL or fix AI_EVAL_PROMPT.`,
        EXIT_DISABLED_OR_UNREACHABLE,
      );
    }
    if (existing.model !== MODEL) {
      fail(
        `Experiment "${name}" (${existing.id}) already exists with model "${existing.model}", not the requested ` +
          `"${MODEL}" (AI_EVAL_MODEL). Use a different AI_EVAL_EXPERIMENT_NAME/AI_EVAL_RUN_LABEL or fix AI_EVAL_MODEL.`,
        EXIT_DISABLED_OR_UNREACHABLE,
      );
    }
    console.log(`Using existing experiment "${name}" (${existing.id}).`);
    return existing;
  }

  const created = await request("POST", "/api/dispatcher/ai/experiments", {
    token,
    body: { name, promptVersion, config: { model: MODEL } },
  });
  if (!created.ok) {
    throw new Error(`POST /api/dispatcher/ai/experiments failed (HTTP ${created.status}): ${JSON.stringify(created.body)}`);
  }
  console.log(`Created experiment "${name}" (${created.body.experiment.id}).`);
  return created.body.experiment;
}

/** `externalId` -> loadId. Primary path: GET /ai/uncovered-loads, which is
 *  what scenarios A-H actually are (open, no active assignment) — filtered
 *  client-side by externalId. Fallback: dispatcherLoads.ts's own by-ref
 *  lookup, GET /loads/lookup?ref=, which resolves boardLoadNo OR orderRef
 *  (seed-world's scenario loads set only externalId, so this fallback will
 *  typically miss for them — it is kept because it is the only other by-ref
 *  route this backend exposes, for a load whose externalId was also copied
 *  onto orderRef/boardLoadNo, or for a scenario load that aged out of
 *  uncovered-loads' 24h-past-pickup cutoff). Returns null, never throws, so
 *  one unresolvable scenario does not abort the other seven. */
async function resolveLoadId(token, externalId, uncoveredLoadsCache) {
  if (!uncoveredLoadsCache.loaded) {
    const res = await request("GET", "/api/dispatcher/ai/uncovered-loads", { token });
    uncoveredLoadsCache.loaded = true;
    uncoveredLoadsCache.loads = res.ok && Array.isArray(res.body?.loads) ? res.body.loads : [];
  }
  const match = uncoveredLoadsCache.loads.find((l) => l.externalId === externalId);
  if (match) return match.id;

  const lookup = await request("GET", `/api/dispatcher/loads/lookup?ref=${encodeURIComponent(externalId)}`, { token });
  if (lookup.ok && lookup.body?.load?.id) return lookup.body.load.id;
  return null;
}

/** POSTs one run, retrying on 429 QUEUE_FULL (the cap is 10 pending per org;
 *  8 scenarios normally fit under it in one breath, but a previous run's
 *  leftovers or a shared dev org could still be occupying slots). */
async function enqueueWithRetry(token, experimentId, loadId, label) {
  for (let attempt = 1; attempt <= MAX_ENQUEUE_ATTEMPTS; attempt++) {
    const res = await request("POST", `/api/dispatcher/ai/experiments/${experimentId}/runs`, { token, body: { loadId } });
    if (res.status === 202 && typeof res.body?.runId === "string") return res.body.runId;
    if (res.status === 429) {
      console.log(`Queue full enqueuing ${label} — waiting ${ENQUEUE_RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_ENQUEUE_ATTEMPTS})…`);
      await sleep(ENQUEUE_RETRY_DELAY_MS);
      continue;
    }
    throw new Error(`POST .../runs failed for ${label} (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  throw new Error(`Could not enqueue ${label} after ${MAX_ENQUEUE_ATTEMPTS} attempts — the queue stayed full (cap: 10 pending per org).`);
}

/** Polls one run every 3s until it reaches a terminal status, or throws once
 *  `deadlineMs` passes — the safety ceiling `AI_EVAL_MAX_WAIT_MS` guards the
 *  whole batch against a genuinely stuck run rather than hanging forever. */
async function pollUntilTerminal(token, runId, label, deadlineMs) {
  for (;;) {
    const res = await request("GET", `/api/dispatcher/ai/runs/${runId}`, { token });
    if (!res.ok) throw new Error(`GET /api/dispatcher/ai/runs/${runId} failed (HTTP ${res.status}) while polling ${label}.`);
    if (TERMINAL_STATUSES.has(res.body.run.status)) return res.body.run;
    if (Date.now() >= deadlineMs) {
      throw new Error(`${label} (run ${runId}) did not reach a terminal status within the ${MAX_WAIT_MS}ms safety ceiling (last status: ${res.body.run.status}).`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function fetchEvaluation(token, experimentId) {
  const res = await request("GET", `/api/dispatcher/ai/experiments/${experimentId}/evaluation`, { token });
  if (!res.ok) throw new Error(`GET .../evaluation failed (HTTP ${res.status}).`);
  return res.body.evaluation;
}

function fmt(value, digits) {
  if (value === null || value === undefined) return "—";
  return typeof digits === "number" ? value.toFixed(digits) : String(value);
}

function fmtName(pick) {
  if (!pick) return "—";
  return pick.name ?? pick.driverId ?? "—";
}

const TABLE_HEADER = [
  "Scenario", "Load ref", "Prompt", "Deterministic top", "Pick", "Confidence", "Rank of pick",
  "Investigated", "Human verdict", "Turns", "Tool calls", "Unique/Repeated/Invalid", "Latency (s)",
  "Tokens (prompt+completion)", "Termination",
];

function tableRow(code, row) {
  return [
    code,
    row.loadRef ?? "—",
    row.promptVersion ?? "—",
    fmtName(row.deterministicTop),
    fmtName(row.pick),
    fmt(row.confidence, 2),
    fmt(row.deterministicRankOfPick),
    fmt(row.candidatesInvestigated),
    row.humanVerdict ?? "—",
    fmt(row.turns),
    fmt(row.toolCalls),
    `${fmt(row.uniqueTools)}/${fmt(row.repeatedCalls)}/${fmt(row.invalidCalls)}`,
    row.latencyMs != null ? (row.latencyMs / 1000).toFixed(1) : "—",
    `${fmt(row.promptTokens)}+${fmt(row.completionTokens)}`,
    row.terminationReason ?? "—",
  ];
}

function toMarkdownTable(rows) {
  const header = `| ${TABLE_HEADER.join(" | ")} |`;
  const divider = `| ${TABLE_HEADER.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

/** The batch summary line — computed over THIS invocation's own rows only
 *  (never the experiment's full history), the same fields
 *  aiHarness/evaluation.ts's own EvaluationSummary reports for one run. */
function summarize(evalRows) {
  const proposed = evalRows.filter((r) => r.status === "proposed");
  const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
  const byTermination = {};
  for (const r of evalRows) {
    if (!r.terminationReason) continue;
    byTermination[r.terminationReason] = (byTermination[r.terminationReason] ?? 0) + 1;
  }
  const terminationBits = Object.entries(byTermination).map(([reason, count]) => `${reason}=${count}`).join(", ");
  const matched = evalRows.filter((r) => r.matchesDeterministicTop === true).length;
  const meanTurns = mean(proposed.map((r) => r.turns));
  const meanLatencyS = mean(proposed.map((r) => r.latencyMs).filter((v) => v != null));
  return (
    `${evalRows.length} runs (${terminationBits || "none terminal"}) — ` +
    `${matched}/${evalRows.length} matched the deterministic top — ` +
    `mean turns ${meanTurns != null ? meanTurns.toFixed(1) : "—"}, ` +
    `mean latency ${meanLatencyS != null ? (meanLatencyS / 1000).toFixed(1) + "s" : "—"}`
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  console.log(`Logging in as ${EMAIL} against ${BASE_URL}…`);
  const token = await login();

  await checkStatus(token);
  const promptVersion = PROMPT_VERSION;

  const experiment = await findOrCreateExperiment(token, promptVersion);

  const scenarios = SCENARIO_CODES_A_TO_H.map((code) => SCENARIOS.find((s) => s.code === code));
  const uncoveredLoadsCache = { loaded: false, loads: [] };

  console.log("Resolving scenario loads by externalId…");
  const resolved = [];
  const skipped = [];
  for (const scenario of scenarios) {
    const loadId = await resolveLoadId(token, scenario.externalId, uncoveredLoadsCache);
    if (loadId) {
      resolved.push({ scenario, loadId });
    } else {
      skipped.push(scenario);
      console.warn(`Could not resolve a load for scenario ${scenario.code} (${scenario.externalId}) — skipping it.`);
    }
  }
  if (resolved.length === 0) {
    fail("None of the eight scenario loads could be resolved — is the world seeded (node seed-world.mjs)?");
  }

  console.log(`Enqueuing ${resolved.length} run(s)…`);
  const enqueued = [];
  for (const { scenario, loadId } of resolved) {
    const runId = await enqueueWithRetry(token, experiment.id, loadId, `scenario ${scenario.code}`);
    enqueued.push({ scenario, loadId, runId });
  }

  console.log(`Waiting for ${enqueued.length} run(s) to finish (polling every ${POLL_INTERVAL_MS / 1000}s)…`);
  const deadlineMs = Date.now() + MAX_WAIT_MS;
  await Promise.all(
    enqueued.map(({ scenario, runId }) => pollUntilTerminal(token, runId, `scenario ${scenario.code}`, deadlineMs)),
  );

  const evaluation = await fetchEvaluation(token, experiment.id);
  const rowsByRunId = new Map(evaluation.rows.map((r) => [r.runId, r]));
  const evalRows = enqueued
    .map(({ scenario, runId }) => ({ scenario, row: rowsByRunId.get(runId) }))
    .filter(({ row }) => row !== undefined);

  const tableRows = evalRows.map(({ scenario, row }) => tableRow(scenario.code, row));
  const summaryLine = summarize(evalRows.map(({ row }) => row));

  const skippedNote = skipped.length > 0
    ? `\nSkipped (no load could be resolved for this externalId): ${skipped.map((s) => `${s.code} (${s.externalId})`).join(", ")}.\n`
    : "";

  const doc = [
    `# Scenarios A–H evaluation — ${todayIso()}`,
    "",
    `- Model: ${MODEL}`,
    `- Prompt version: ${promptVersion}`,
    `- Run label: ${RUN_LABEL}`,
    `- Experiment: ${experiment.name} (${experiment.id})`,
    "- Config:",
    "",
    "```json",
    JSON.stringify(experiment.config, null, 2),
    "```",
    "",
    "Matching the deterministic ⚡Suggest top candidate, or a scenario's own seeded expectation, is shown below as " +
      "reference data — it is not a definition of correctness. A different pick can be the right call for reasons " +
      "the deterministic engine does not weigh, and a match does not by itself prove the model reasoned well.",
    skippedNote,
    toMarkdownTable(tableRows),
    "",
    summaryLine,
    "",
  ].join("\n");

  console.log("");
  console.log(doc);

  const outDir = join(REPO_ROOT, "docs", "evaluations");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${todayIso()}-${promptVersion}-run${RUN_LABEL}.md`);
  await writeFile(outPath, doc, "utf8");
  console.log(`Wrote ${outPath}`);

  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(EXIT_ERROR);
});
