// The notebook is the source of truth. This reads `library/situations.md`
// into data — nothing here knows about files, so the core stays pure and a
// test can parse a three-line fixture.
//
// Two lists per block, and they are NOT the same thing:
//   "Driver says"       — how drivers actually talk. The corpus the classifier
//                         is TESTED against. Sentences, broken English, noise.
//   "Agent listens for" — the curated lexicon the matcher keys on. Short,
//                         distinctive, trap-free. What becomes `examples`.
// Compiling the corpus into the matcher would drop the single-word triggers
// ("flat", "tire") the classifier is tuned on and match worse, not better.
import type { Level } from "../core/types.js";

export type BlockStatus = "approved" | "proposed";
/** `free` is the absence of a marker — a question whose author never said
 *  what to do with the answer. `text` is the deliberate one: write the words
 *  down. The notebook's house rules reject `free`. */
export type AskAnswer = "yes/no" | "number" | "text" | "free";

export interface ParsedAsk {
  text: string;
  answer: AskAnswer;
  /** what the number counts ("minutes"), when the block said so */
  unit: string | null;
}

export interface ParsedBlock {
  key: string;
  level: Level;
  /** `proposed` blocks are written, reviewable, and NOT in the matcher. */
  status: BlockStatus;
  response: string;
  dispatcherNote: string;
  /** the matcher's lexicon — "Agent listens for" */
  examples: string[];
  /** the phrasings the matcher is tested against — "Driver says" */
  corpus: string[];
  asks: ParsedAsk[];
  careful: string | null;
}

export interface ParsedTestLine {
  text: string;
  /** the key it must land on; null means it must match nothing at all */
  expect: string | null;
}

export interface ParsedLibrary {
  blocks: ParsedBlock[];
  testLines: ParsedTestLine[];
}

/** `## breakdown — level 3`. Prose headings ("## Scenario 1 — the flat…")
 *  and the empty template block do not match, so they are skipped. */
const HEADING = /^##\s+([a-z][a-z0-9_]*)\s+—\s+level\s+(\d+)\s*$/;
const TEST_LINES_HEADING = /^#\s+Test lines\s*$/;
const BULLET = /^-\s+(.+?)\s*$/;
const NUMBERED = /^\d+\.\s+(.+?)\s*$/;
const TABLE_DIVIDER = /^\|[\s\-:|]+\|$/;
const ANSWER_MARK = /\s*\[(yes\/no|text|number(?:\s*,\s*([a-z]+))?)\]\s*$/;

/** A function DECLARATION, not a const arrow: TypeScript only lets a call
 *  narrow control flow when the callee is a declared name, so `fail(...)`
 *  below has to end the branch for the compiler as well as at runtime. */
function fail(key: string, what: string): never {
  throw new Error(`situation "${key}": ${what}`);
}

function parseAsk(line: string): ParsedAsk {
  const mark = ANSWER_MARK.exec(line);
  if (!mark) return { text: line, answer: "free", unit: null };
  const text = line.slice(0, mark.index).trim();
  if (mark[1].startsWith("number")) return { text, answer: "number", unit: mark[2] ?? null };
  return { text, answer: mark[1] === "text" ? "text" : "yes/no", unit: null };
}

/** The bullets directly under a `Label:` line, stopping at the blank line. */
function listUnder(lines: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < lines.length; i += 1) {
    const m = BULLET.exec(lines[i]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

function parseBlock(key: string, level: number, body: string[]): ParsedBlock {
  if (!Number.isInteger(level) || level < 0 || level > 3) fail(key, `level ${level} is outside 0–3`);
  let status: BlockStatus | null = null;
  let response: string | null = null;
  let dispatcherNote: string | null = null;
  let careful: string | null = null;
  let corpus: string[] = [];
  let examples: string[] = [];
  let asks: ParsedAsk[] = [];

  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    if (line.startsWith("Status:")) {
      const raw = line.slice("Status:".length).trim();
      if (raw !== "approved" && raw !== "proposed") fail(key, `status "${raw}" is neither approved nor proposed`);
      status = raw;
    } else if (line.startsWith("Driver says:")) {
      corpus = listUnder(body, i + 1);
    } else if (line.startsWith("Agent listens for:")) {
      examples = listUnder(body, i + 1);
    } else if (line.startsWith("Agent replies:")) {
      response = line.slice("Agent replies:".length).trim();
    } else if (line.startsWith("Dispatcher note:")) {
      dispatcherNote = line.slice("Dispatcher note:".length).trim();
    } else if (line.startsWith("Careful:")) {
      careful = line.slice("Careful:".length).trim();
    } else if (line.startsWith("Then asks:")) {
      const rest = line.slice("Then asks:".length).trim();
      asks = rest === "(none)" ? [] : [];
      if (rest !== "(none)") {
        for (let j = i + 1; j < body.length; j += 1) {
          const numbered = NUMBERED.exec(body[j]);
          if (!numbered) break;
          asks.push(parseAsk(numbered[1]));
        }
      }
    }
  }

  if (status === null) fail(key, "no Status line — a block nobody approved is not a fact");
  if (response === null || response === "") fail(key, "no 'Agent replies:' line");
  if (dispatcherNote === null || dispatcherNote === "") fail(key, "no 'Dispatcher note:' line");
  // A proposed block may still be growing its lexicon; an approved one that
  // the matcher cannot hear is a block that silently does nothing.
  if (status === "approved" && examples.length === 0) fail(key, "approved, but 'Agent listens for' is empty");

  return {
    key, level: level as Level, status: status as BlockStatus,
    response: response as string, dispatcherNote: dispatcherNote as string,
    examples, corpus, asks, careful,
  };
}

function parseTestLines(lines: string[], knownKeys: Set<string>): ParsedTestLine[] {
  const start = lines.findIndex((l) => TEST_LINES_HEADING.test(l));
  if (start === -1) return [];
  const out: ParsedTestLine[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("#")) break;
    if (!line.startsWith("|") || TABLE_DIVIDER.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const [text, verdict] = cells;
    if (/^line a driver/i.test(text)) continue; // the header row
    if (text === "" && verdict === "") continue;
    const key = /^`([a-z][a-z0-9_]*)`$/.exec(verdict);
    if (key === null) {
      if (!/^\(nothing\)$/i.test(verdict)) throw new Error(`test line "${text}": "${verdict}" is neither \`a key\` nor (nothing)`);
      out.push({ text, expect: null });
      continue;
    }
    if (!knownKeys.has(key[1])) throw new Error(`test line "${text}": no block defines "${key[1]}"`);
    out.push({ text, expect: key[1] });
  }
  return out;
}

export function parseLibrary(markdown: string): ParsedLibrary {
  const lines = markdown.split(/\r?\n/);
  const blocks: ParsedBlock[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const heading = HEADING.exec(lines[i]);
    if (heading === null) continue;
    const [, key, level] = heading;
    if (seen.has(key)) throw new Error(`situation "${key}" is defined twice`);
    seen.add(key);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].startsWith("#") || lines[j].trim() === "---") break;
      body.push(lines[j]);
    }
    blocks.push(parseBlock(key, Number(level), body));
  }

  return { blocks, testLines: parseTestLines(lines, seen) };
}
