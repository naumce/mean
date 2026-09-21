import { describe, expect, it } from "vitest";
import { parseLibrary } from "../src/library/parse.js";

// One well-formed block, written exactly as the notebook writes them. Every
// other fixture in this file is this one with a single thing wrong, so a
// failure names the rule that broke.
const BLOCK = `## breakdown — level 3
Status: approved
Driver says:
- my tire is broken
- truck no start

Agent listens for:
- breakdown
- won't start

Agent replies: Understood. Are you safe? Dispatch is being notified now.

Then asks:
1. Are you safe and off the road? [yes/no]
2. How long until you think you can roll? [number, minutes]

Dispatcher note: Driver reports a breakdown.

Careful: "smoke from engine" is a breakdown.

---
`;

const withPreamble = (blocks: string): string => `# Situation library — the dispatcher's notebook

Prose a human reads. Not parsed.

---

${blocks}`;

describe("parseLibrary — blocks", () => {
  it("reads the key, the level and the status out of the heading", () => {
    const [b] = parseLibrary(withPreamble(BLOCK)).blocks;
    expect(b.key).toBe("breakdown");
    expect(b.level).toBe(3);
    expect(b.status).toBe("approved");
  });

  it("keeps the two lists apart: what drivers say, and what the matcher listens for", () => {
    // The whole point of the split. The corpus is sentences; the lexicon is
    // the curated tokens. Compiling the corpus into the matcher would lose
    // the single-word triggers the classifier is tuned on.
    const [b] = parseLibrary(withPreamble(BLOCK)).blocks;
    expect(b.corpus).toEqual(["my tire is broken", "truck no start"]);
    expect(b.examples).toEqual(["breakdown", "won't start"]);
  });

  it("reads the response, the dispatcher note and the careful note", () => {
    const [b] = parseLibrary(withPreamble(BLOCK)).blocks;
    expect(b.response).toBe("Understood. Are you safe? Dispatch is being notified now.");
    expect(b.dispatcherNote).toBe("Driver reports a breakdown.");
    expect(b.careful).toMatch(/smoke from engine/);
  });

  it("reads the follow-up questions with the answer each one wants", () => {
    const [b] = parseLibrary(withPreamble(BLOCK)).blocks;
    expect(b.asks).toEqual([
      { text: "Are you safe and off the road?", answer: "yes/no", unit: null },
      { text: "How long until you think you can roll?", answer: "number", unit: "minutes" },
    ]);
  });

  it("reads a question whose answer is words to write down", () => {
    const text = BLOCK.replace("1. Are you safe and off the road? [yes/no]", "1. What exactly stopped you? [text]");
    const [b] = parseLibrary(withPreamble(text)).blocks;
    expect(b.asks[0]).toEqual({ text: "What exactly stopped you?", answer: "text", unit: null });
  });

  it("marks an unmarked question `free`, so the house rules can reject it", () => {
    const text = BLOCK.replace("1. Are you safe and off the road? [yes/no]", "1. Are you safe?");
    const [b] = parseLibrary(withPreamble(text)).blocks;
    expect(b.asks[0]).toEqual({ text: "Are you safe?", answer: "free", unit: null });
  });

  it("reads a block that asks nothing", () => {
    const none = BLOCK.replace(/Then asks:\n1\..*\n2\..*\n/, "Then asks: (none)\n");
    const [b] = parseLibrary(withPreamble(none)).blocks;
    expect(b.asks).toEqual([]);
  });

  it("keeps the file's order — the matcher breaks ties on it", () => {
    const second = BLOCK.replace("## breakdown — level 3", "## all_good — level 0").replace("Status: approved", "Status: proposed");
    const keys = parseLibrary(withPreamble(BLOCK + second)).blocks.map((b) => b.key);
    expect(keys).toEqual(["breakdown", "all_good"]);
  });

  it("skips the empty template block and every prose heading", () => {
    const template = `## (new situation — copy this block)
Level: (human selects 0–3)

Driver says:
-

---
`;
    const prose = `# What drivers ask the agent

| Driver asks | Answer comes from |
|---|---|
| Where am I delivering? | the load's destination |

---
`;
    const lib = parseLibrary(withPreamble(BLOCK + template + prose));
    expect(lib.blocks.map((b) => b.key)).toEqual(["breakdown"]);
  });
});

describe("parseLibrary — refusing what it cannot trust", () => {
  const broken = (edit: (s: string) => string): (() => unknown) => () => parseLibrary(withPreamble(edit(BLOCK)));

  it("refuses a block with no status — a block nobody approved is not a fact", () => {
    expect(broken((s) => s.replace("Status: approved\n", ""))).toThrow(/breakdown.*status/i);
  });

  it("refuses a status it does not know", () => {
    expect(broken((s) => s.replace("Status: approved", "Status: maybe"))).toThrow(/maybe/);
  });

  it("refuses a block with no reply to the driver", () => {
    expect(broken((s) => s.replace(/Agent replies:.*\n/, ""))).toThrow(/breakdown.*replies/i);
  });

  it("refuses a block with no dispatcher note", () => {
    expect(broken((s) => s.replace(/Dispatcher note:.*\n/, ""))).toThrow(/breakdown.*dispatcher note/i);
  });

  it("refuses an approved block the matcher cannot hear", () => {
    expect(broken((s) => s.replace(/Agent listens for:\n- breakdown\n- won't start\n/, "Agent listens for:\n"))).toThrow(/breakdown.*listens/i);
  });

  it("refuses two blocks with the same key", () => {
    expect(() => parseLibrary(withPreamble(BLOCK + BLOCK))).toThrow(/breakdown/);
  });

  it("refuses a level outside 0–3", () => {
    expect(broken((s) => s.replace("level 3", "level 7"))).toThrow(/level/i);
  });
});

describe("parseLibrary — the test lines table", () => {
  const table = `# Test lines

A dispatcher who sees the agent get a line wrong pastes it here.

| Line a driver could send | Must be |
|---|---|
| my tire is broken | \`breakdown\` |
| rolled over the curb, no damage | (nothing) |
| ok fine yes but the truck no start | \`breakdown\` |
`;

  it("reads each line with the key it must land on", () => {
    const lines = parseLibrary(withPreamble(BLOCK) + table).testLines;
    expect(lines).toEqual([
      { text: "my tire is broken", expect: "breakdown" },
      { text: "rolled over the curb, no damage", expect: null },
      { text: "ok fine yes but the truck no start", expect: "breakdown" },
    ]);
  });

  it("is empty, not broken, when the table is not there", () => {
    expect(parseLibrary(withPreamble(BLOCK)).testLines).toEqual([]);
  });

  it("refuses a line that expects a key no block defines", () => {
    const bad = table.replace("`breakdown`", "`teleport`");
    expect(() => parseLibrary(withPreamble(BLOCK) + bad)).toThrow(/teleport/);
  });
});
