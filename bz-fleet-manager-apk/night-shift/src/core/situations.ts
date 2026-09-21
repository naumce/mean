// The situation library (spec §9): the bounded set of things a driver can
// actually be in. Each carries what the agent says back, how loudly the
// dispatcher hears about it, and the phrasings a reply is matched on.
//
// The table itself is GENERATED from library/situations.md by
// `npm run library:compile`. That notebook is the source of truth: it carries
// the phrasings, the levels, the follow-up questions, and — in each block's
// "Careful" note — the reason a phrasing is worded the way it is ("no bare
// hit", "no bare break"). A human approves a block there; rules never rewrite
// themselves here.
import { SITUATIONS } from "./situations.data.js";
import type { Situation } from "./types.js";

export { SITUATIONS };

export const UNKNOWN_RESPONSE = "Sorry, I didn't catch that — dispatch will follow up.";

export function situationFor(key: string): Situation | null {
  return SITUATIONS.find((s) => s.key === key) ?? null;
}

const KEYWORD_CONFIDENCE = 0.9;

/** The key of the fallback situation — see `matchByKeywords`. */
const ALL_GOOD_KEY = "all_good";

/** Every phone types a curly apostrophe (U+2019). Stripping it turned
 *  "won't start" into "won t start" and the breakdown went unrecognized, so
 *  it is folded to a plain apostrophe before anything else happens. */
const words = (s: string): string[] =>
  s.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Whole-word phrase match: every word of the example appears consecutively
 *  in the reply. "hit" does not match "shit". */
function containsPhrase(replyWords: string[], example: string): boolean {
  const ex = words(example);
  if (ex.length === 0) return false;
  for (let i = 0; i + ex.length <= replyWords.length; i += 1) {
    if (ex.every((w, j) => replyWords[i + j] === w)) return true;
  }
  return false;
}

/** The matcher over an ARBITRARY library. `matchByKeywords` is this over the
 *  approved one; the library tests use it to ask what a `proposed` block
 *  would do on the day it is approved, without approving it first. */
export function matchIn(situations: readonly Situation[], text: string): { key: string | null; confidence: number } {
  const replyWords = words(text);
  if (replyWords.length === 0) return { key: null, confidence: 0 };
  const scored = situations
    .map((s) => ({ s, hits: s.examples.filter((e) => containsPhrase(replyWords, e)).length }))
    .filter((c) => c.hits > 0);
  // "All good" is the least informative claim a reply can make; three
  // affirmatives must not outvote one "police pulled me over." It is a
  // FALLBACK, so it is discarded the moment anything else matched at all.
  const informative = scored.filter((c) => c.s.key !== ALL_GOOD_KEY);
  const candidates = informative.length > 0 ? informative : scored;
  // A plain loop, not reduce: TypeScript does not track an assignment made
  // inside a callback, so `best` would still be typed `null` at the return.
  // An earlier row wins a tie by never being overwritten — SITUATIONS is
  // ordered for that, so no explicit index comparison is needed.
  let best: { key: string; hits: number; level: number } | null = null;
  for (const c of candidates) {
    const better = best === null || c.hits > best.hits || (c.hits === best.hits && c.s.level > best.level);
    if (better) best = { key: c.s.key, hits: c.hits, level: c.s.level };
  }
  return best === null ? { key: null, confidence: 0 } : { key: best.key, confidence: KEYWORD_CONFIDENCE };
}

export function matchByKeywords(text: string): { key: string | null; confidence: number } {
  return matchIn(SITUATIONS, text);
}
