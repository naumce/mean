import { z } from "zod";

// aiHarness/config.ts (Qwen Harness v0.1, Task 3): the knobs one AiExperiment
// controls (AiExperiment.config, JSON) plus the two feature-gate reads for
// "is the harness even turned on" — a later task's router answers 404 for its
// whole /ai surface unless OLLAMA_URL is set, rather than half-working
// against a model that was never configured. zod v3 here, like every route
// in this codebase; only manifest.ts's tool params use v4.

export interface HarnessConfig {
  adapter: "ollama";
  model: string;
  think: boolean;
  temperature: number;
  numCtx: number;
  maxTurns: number;
  maxToolCalls: number;
  maxConsecutiveInvalid: number;
  maxToolResultBytes: number;
  maxRunMs: number;
  modelCallTimeoutMs: number;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  adapter: "ollama",
  model: "qwen3:8b",
  think: true,
  temperature: 0.2,
  numCtx: 16384,
  maxTurns: 12,
  maxToolCalls: 30,
  maxConsecutiveInvalid: 3,
  maxToolResultBytes: 65536,
  maxRunMs: 600_000,
  modelCallTimeoutMs: 120_000,
};

/**
 * Every field optional — an experiment's `config` only overrides what it
 * sets; `resolveHarnessConfig` below fills in the rest from
 * `DEFAULT_HARNESS_CONFIG`. Ranges are loop-safety bounds, not taste: e.g.
 * `maxRunMs`'s 30s floor keeps a run from being configured so short it could
 * never finish even one model round trip, and its 1h ceiling keeps a
 * misconfigured run from occupying its org's one-run-at-a-time queue slot
 * indefinitely.
 */
export const harnessConfigSchema: z.ZodType<Partial<HarnessConfig>> = z.object({
  adapter: z.literal("ollama").optional(),
  model: z.string().min(1).max(80).optional(),
  think: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  numCtx: z.number().int().min(2048).max(131072).optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
  maxToolCalls: z.number().int().min(1).max(200).optional(),
  maxConsecutiveInvalid: z.number().int().min(1).max(10).optional(),
  maxToolResultBytes: z.number().int().min(8192).max(1048576).optional(),
  maxRunMs: z.number().int().min(30_000).max(3_600_000).optional(),
  modelCallTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
});

/** `DEFAULT_HARNESS_CONFIG` with `partial` validated and merged over it — an
 *  out-of-range or wrong-type field throws (a `ZodError`) rather than being
 *  silently clamped or dropped, the same fail-fast rule this codebase applies
 *  at every other system boundary. */
export function resolveHarnessConfig(partial: unknown): HarnessConfig {
  const validated = harnessConfigSchema.parse(partial);
  return { ...DEFAULT_HARNESS_CONFIG, ...validated };
}

/** The harness's own feature gate, read at CALL time — never cached at import
 *  time — so a route can flip behavior within one running process purely by
 *  env var, and so a test can toggle it per-test via `process.env.OLLAMA_URL`
 *  with no module reload. */
export function harnessEnabled(): boolean {
  return Boolean(process.env.OLLAMA_URL);
}

/** The configured Ollama base URL. Throws rather than guessing a default:
 *  every real caller of this function sits behind a `harnessEnabled()` check
 *  (a later task's /ai router answers 404 before ever reaching one), so
 *  arriving here with no URL set is a caller bug, not a normal unconfigured
 *  state. */
export function ollamaBaseUrl(): string {
  const url = process.env.OLLAMA_URL;
  if (!url) throw new Error("OLLAMA_URL is not set.");
  return url;
}
