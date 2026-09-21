import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITUATIONS, matchByKeywords, matchIn } from "../src/core/situations.js";
import { parseLibrary } from "../src/library/parse.js";
import { NOTEBOOK_PATH } from "../src/library/paths.js";
import { reportOn } from "../src/library/report.js";
import type { Situation } from "../src/core/types.js";

const library = parseLibrary(readFileSync(NOTEBOOK_PATH, "utf8"));
const approved = library.blocks.filter((b) => b.status === "approved");
const liveKeys = new Set(SITUATIONS.map((s) => s.key));

/** Every block switched on: what the library WOULD do if today's proposals
 *  were approved. Used only to prove that approving them breaks nothing. */
const simulated: readonly Situation[] = library.blocks.map((b) => ({
  key: b.key, level: b.level, response: b.response, dispatcherNote: b.dispatcherNote, examples: b.examples,
}));

/** How much of "Driver says" the keyword matcher actually hears. Measured at
 *  0.47 with 763 phrasings — and that number is the argument for the next
 *  upgrade, not a failure: a keyword list cannot cover how people talk. The
 *  floor is here so it cannot quietly fall while the corpus grows. */
const COVERAGE_FLOOR = 0.4;

describe("what drivers say, against the live classifier", () => {
  it("never lands a phrasing in the WRONG approved block", () => {
    // The only hard rule. Hearing nothing is safe — the driver gets "I didn't
    // catch that" and a human reads the words. Hearing the wrong thing sends
    // the wrong answer and wakes, or fails to wake, the wrong person.
    const wrong: string[] = [];
    for (const b of approved) {
      for (const line of b.corpus) {
        const key = matchByKeywords(line).key;
        if (key !== null && key !== b.key) wrong.push(`${b.key}: "${line}" -> ${key}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("hears enough of the corpus to be worth having", () => {
    const total = approved.reduce((n, b) => n + b.corpus.length, 0);
    const heard = approved.reduce((n, b) => n + b.corpus.filter((l) => matchByKeywords(l).key === b.key).length, 0);
    expect(total).toBeGreaterThan(250);
    expect(heard / total, `only ${heard}/${total} of the corpus is heard`).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
  });

  it("hears something in every approved block", () => {
    // A block whose phrasings all miss is a block that never fires.
    for (const b of approved) {
      const heard = b.corpus.filter((l) => matchByKeywords(l).key === b.key).length;
      expect(heard, `${b.key} hears none of its own ${b.corpus.length} phrasings`).toBeGreaterThan(0);
    }
  });
});

describe("the notebook's test lines", () => {
  const live = library.testLines.filter((t) => t.expect === null || liveKeys.has(t.expect));
  const waiting = library.testLines.filter((t) => t.expect !== null && !liveKeys.has(t.expect));

  it("has lines to run", () => {
    expect(live.length).toBeGreaterThan(15);
  });

  it("classifies every line the way the notebook says it must", () => {
    const failures = live
      .map((t) => ({ t, got: matchByKeywords(t.text).key }))
      .filter(({ t, got }) => got !== t.expect)
      .map(({ t, got }) => `"${t.text}" -> ${got}, notebook says ${t.expect ?? "(nothing)"}`);
    expect(failures).toEqual([]);
  });

  it("holds lines that are waiting on a proposed block, and says so rather than failing", () => {
    // These start passing the day someone approves the block they name. They
    // are the argument FOR approving it, so they belong in the file, not in a
    // TODO somewhere.
    for (const t of waiting) expect(liveKeys.has(t.expect as string)).toBe(false);
    expect(waiting.length).toBeGreaterThan(0);
  });
});

describe("the report a human reads before approving", () => {
  it("counts what the classifier hears, block by block", () => {
    const report = reportOn(library.blocks);
    expect(report.lines).toHaveLength(approved.length);
    expect(report.total).toBe(approved.reduce((n, b) => n + b.corpus.length, 0));
    expect(report.heard).toBeGreaterThan(0);
    expect(report.heard).toBeLessThanOrEqual(report.total);
  });

  it("names every phrasing a proposed block would have to argue for", () => {
    const conflict = reportOn([
      { key: "breakdown", level: 3, status: "approved", response: "r.", dispatcherNote: "d.", examples: ["tire"], corpus: ["my tire is broken"], asks: [], careful: null },
      { key: "equipment", level: 2, status: "proposed", response: "r.", dispatcherNote: "d.", examples: ["reefer"], corpus: ["the trailer tire is low"], asks: [], careful: null },
    ]);
    expect(conflict.conflicts).toEqual(['  equipment → breakdown: "the trailer tire is low"']);
  });

  it("says nothing about a proposal that steps on nobody", () => {
    const clean = reportOn([
      { key: "breakdown", level: 3, status: "approved", response: "r.", dispatcherNote: "d.", examples: ["tire"], corpus: ["my tire is broken"], asks: [], careful: null },
      { key: "ferry", level: 1, status: "proposed", response: "r.", dispatcherNote: "d.", examples: ["ferry"], corpus: ["waiting for the ferry"], asks: [], careful: null },
    ]);
    expect(clean.conflicts).toEqual([]);
  });
});

describe("approving the proposed blocks", () => {
  it("would not change a single answer the library already gets right", () => {
    // The safety property that makes 19 written-but-inert blocks safe to keep
    // in the file: switching them all on must not move any line that the
    // approved library already classifies the way the notebook demands.
    const moved = library.testLines
      .filter((t) => t.expect === null || liveKeys.has(t.expect))
      .map((t) => ({ t, before: matchByKeywords(t.text).key, after: matchIn(simulated, t.text).key }))
      .filter(({ t, before, after }) => before === t.expect && after !== before)
      .map(({ t, before, after }) => `"${t.text}" would move from ${before} to ${after}`);
    expect(moved).toEqual([]);
  });

  it("would not steal an approved block's own phrasings", () => {
    // A proposed block may claim lines that today match nothing — that is the
    // point of writing it. It may not take lines an approved block already
    // hears correctly.
    const stolen: string[] = [];
    for (const b of approved) {
      for (const line of b.corpus) {
        if (matchByKeywords(line).key !== b.key) continue;
        const after = matchIn(simulated, line).key;
        if (after !== b.key) stolen.push(`${b.key}: "${line}" would go to ${after}`);
      }
    }
    expect(stolen).toEqual([]);
  });
});
