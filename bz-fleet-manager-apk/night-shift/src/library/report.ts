// What a human needs to see before approving a block: how much of the corpus
// the classifier actually hears, and which phrasings a proposed block would
// take from — or lose to — a block that is already live.
//
// Pure: blocks in, lines of text out. The CLI prints them; a test reads them.
import { matchIn } from "../core/situations.js";
import type { Situation } from "../core/types.js";
import type { ParsedBlock } from "./parse.js";

const asSituation = (b: ParsedBlock): Situation => ({
  key: b.key, level: b.level, response: b.response, dispatcherNote: b.dispatcherNote, examples: b.examples,
});

export interface LibraryReport {
  /** heard / total across the approved corpus */
  heard: number;
  total: number;
  /** "block: phrasing -> other_key", for proposed blocks only */
  conflicts: string[];
  lines: string[];
}

export function reportOn(blocks: readonly ParsedBlock[]): LibraryReport {
  const approved = blocks.filter((b) => b.status === "approved");
  const proposed = blocks.filter((b) => b.status === "proposed");
  const live = approved.map(asSituation);
  const simulated = blocks.map(asSituation);

  let heard = 0, total = 0;
  const lines: string[] = [];
  for (const b of approved) {
    const own = b.corpus.filter((l) => matchIn(live, l).key === b.key).length;
    heard += own;
    total += b.corpus.length;
    lines.push(`  ${b.key.padEnd(16)} hears ${own}/${b.corpus.length} of what drivers say`);
  }

  const conflicts: string[] = [];
  for (const b of proposed) {
    for (const line of b.corpus) {
      const landed = matchIn(simulated, line).key;
      if (landed !== null && landed !== b.key) conflicts.push(`  ${b.key} → ${landed}: "${line}"`);
    }
  }

  return { heard, total, conflicts, lines };
}
