import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITUATIONS } from "../src/core/situations.js";
import { renderSituationsModule } from "../src/library/compile.js";
import { parseLibrary } from "../src/library/parse.js";
import { COMPILED_PATH, NOTEBOOK_PATH } from "../src/library/paths.js";

const library = parseLibrary(readFileSync(NOTEBOOK_PATH, "utf8"));
const approved = library.blocks.filter((b) => b.status === "approved");

describe("the notebook and the compiled table", () => {
  it("agree, or the build says which command fixes it", () => {
    // The whole point of the compile step: one definition, not two. If this
    // fails, someone edited library/situations.md (good) and did not run the
    // compile (fixable), or edited the generated file by hand (don't).
    const onDisk = readFileSync(COMPILED_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk, "library/situations.md changed — run `npm run library:compile`").toBe(renderSituationsModule(library.blocks));
  });

  it("gives the classifier exactly the approved blocks, in the notebook's order", () => {
    expect(SITUATIONS.map((s) => s.key)).toEqual(approved.map((b) => b.key));
    for (const [i, s] of SITUATIONS.entries()) {
      expect({ level: s.level, response: s.response, dispatcherNote: s.dispatcherNote, examples: s.examples }).toEqual({
        level: approved[i].level, response: approved[i].response, dispatcherNote: approved[i].dispatcherNote, examples: approved[i].examples,
      });
    }
  });

  it("never lets a proposed block reach the classifier", () => {
    // Writing a situation in the notebook must not switch it on. A block goes
    // live when a human changes one word — `Status:` — and not before.
    const live = new Set(SITUATIONS.map((s) => s.key));
    const proposed = library.blocks.filter((b) => b.status === "proposed");
    expect(proposed.length).toBeGreaterThan(0);
    for (const b of proposed) expect(live.has(b.key), `${b.key} is proposed but live`).toBe(false);
  });
});

describe("house rules for the notebook itself", () => {
  it("gives every block a Careful note — the words it steals from its neighbours", () => {
    for (const b of library.blocks) expect(b.careful, `${b.key} has no Careful note`).not.toBeNull();
  });

  it("never lets two blocks listen for the same phrase", () => {
    // A phrase in two lexicons is a coin toss decided by file order. Whoever
    // wrote the second one meant something, and this is where they find out.
    const owner = new Map<string, string>();
    for (const b of library.blocks) {
      for (const phrase of b.examples) {
        const first = owner.get(phrase);
        expect(first === undefined, `"${phrase}" is listened for by both ${first} and ${b.key}`).toBe(true);
        owner.set(phrase, b.key);
      }
    }
  });

  it("asks follow-up questions that name the answer they want", () => {
    for (const b of library.blocks) {
      for (const ask of b.asks) {
        expect(ask.text, `${b.key}: "${ask.text}" is not a question`).toMatch(/\?$/);
        expect(ask.answer, `${b.key}: "${ask.text}" does not say what kind of answer it wants`).not.toBe("free");
      }
    }
  });

  it("keeps every level-3 block asking whether the driver is safe", () => {
    // The one thing a level-3 block exists to find out. A block that wakes a
    // dispatcher and never asks this is a bug in the notebook, not in code.
    for (const b of library.blocks.filter((x) => x.level === 3)) {
      const asksSafety = b.asks.some((a) => /safe|hurt|ambulance/i.test(a.text));
      expect(asksSafety, `${b.key} is level 3 but never asks whether anyone is safe`).toBe(true);
    }
  });
});
