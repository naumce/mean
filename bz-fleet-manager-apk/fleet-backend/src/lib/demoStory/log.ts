import type { Prisma } from "@prisma/client";

// Demo Mode: the presenter's own narration log, stored verbatim on
// DemoStory.log — never read by Night Shift, the dispatch engine, the
// simulation engine or the AI harness. One entry per stage-narrating event,
// newest last.

export interface DemoStoryLogEntry {
  atMs: number;
  stage: string;
  text: string;
}

/** `DemoStory.log` comes back from Prisma as `JsonValue` (unknown shape as
 *  far as the type system is concerned) — this is the one place that trusts
 *  it to already be an array of log entries, since nothing but this module
 *  ever writes to the column. */
export function logEntries(log: unknown): DemoStoryLogEntry[] {
  return Array.isArray(log) ? (log as DemoStoryLogEntry[]) : [];
}

/** Appends narration lines, all stamped with the same `atMs` (a single
 *  transition — e.g. entering "customer_updated" — can carry two lines) and
 *  the stage the story is landing on.
 *
 *  Dedupe rule: a line that already exists in the log under the same stage is
 *  dropped. Every line the story writes is unique within its stage by design,
 *  so a duplicate can only mean the same event was narrated twice — a second
 *  process racing the same poll, or a retry that must tell the presenter once
 *  and then stay quiet. Returns a new array, never mutating the caller's. */
export function appendLogs(currentLog: unknown, stage: string, texts: readonly string[], atMs: number = Date.now()): DemoStoryLogEntry[] {
  const existing = logEntries(currentLog);
  const seen = new Set(existing.filter((e) => e.stage === stage).map((e) => e.text));
  const added: DemoStoryLogEntry[] = [];
  for (const text of texts) {
    if (seen.has(text)) continue;
    seen.add(text);
    added.push({ atMs, stage, text });
  }
  return [...existing, ...added];
}

export function asJson(entries: readonly DemoStoryLogEntry[]): Prisma.InputJsonValue {
  return entries as unknown as Prisma.InputJsonValue;
}

export function firstLogEntry(stage: string, text: string): Prisma.InputJsonValue {
  return asJson(appendLogs([], stage, [text]));
}
