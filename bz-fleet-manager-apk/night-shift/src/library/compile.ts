// Notebook → the table the classifier runs on. Pure: text in, text out, so a
// test can compile a fixture without touching the disk.
//
// Only `approved` blocks are emitted. A block written in the notebook does
// nothing until a human sets its status — that is the whole safety catch, and
// it lives here in one line (`APPROVED`).
import type { ParsedBlock } from "./parse.js";

const APPROVED = "approved";

const HEADER = `// GENERATED FILE — do not edit by hand.
//
// \`npm run library:compile\` writes this from library/situations.md, and
// tests/library-drift.test.ts fails the build if the two disagree. To change
// what the agent hears, edit the notebook and re-run the compile.
//
// Only blocks marked \`Status: approved\` are here. Proposed blocks stay in the
// notebook, reviewable and inert, until a human approves them.
import type { Situation } from "./types.js";

/** Order is the notebook's order, and it is load-bearing: on a tie the
 *  earlier situation wins, which is why \`all_good\` is last. */
export const SITUATIONS: readonly Situation[] = [`;

const str = (s: string): string => JSON.stringify(s);

function renderBlock(b: ParsedBlock): string {
  return [
    "  {",
    `    key: ${str(b.key)}, level: ${b.level},`,
    `    response: ${str(b.response)},`,
    `    dispatcherNote: ${str(b.dispatcherNote)},`,
    `    examples: [${b.examples.map(str).join(", ")}],`,
    "  },",
  ].join("\n");
}

export function renderSituationsModule(blocks: readonly ParsedBlock[]): string {
  const approved = blocks.filter((b) => b.status === APPROVED);
  if (approved.length === 0) throw new Error("the notebook has no approved situations — refusing to compile an agent that hears nothing");
  return [HEADER, ...approved.map(renderBlock), "];", ""].join("\n");
}
