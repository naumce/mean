// `npm run library:compile` — the one command that turns the dispatcher's
// notebook into the agent's table.
import { readFileSync, writeFileSync } from "node:fs";
import { renderSituationsModule } from "./compile.js";
import { parseLibrary } from "./parse.js";
import { COMPILED_PATH, NOTEBOOK_PATH } from "./paths.js";
import { reportOn } from "./report.js";

const say = (line: string): void => void process.stdout.write(line + "\n");

try {
  const library = parseLibrary(readFileSync(NOTEBOOK_PATH, "utf8"));
  const approved = library.blocks.filter((b) => b.status === "approved");
  const proposed = library.blocks.length - approved.length;
  writeFileSync(COMPILED_PATH, renderSituationsModule(library.blocks), "utf8");
  say(`library: ${approved.length} approved situations compiled, ${proposed} proposed left in the notebook, ${library.testLines.length} test lines.`);

  const report = reportOn(library.blocks);
  say("");
  say(`what the classifier hears — ${report.heard}/${report.total} of the approved corpus:`);
  for (const line of report.lines) say(line);
  if (report.conflicts.length > 0) {
    // Not a failure: a proposed block is allowed to disagree with a live one.
    // It is the list the human reads before changing a Status line.
    say("");
    say(`before approving, decide these ${report.conflicts.length} — a proposed block's phrasing that lands somewhere else today:`);
    for (const line of report.conflicts) say(line);
  }
} catch (error) {
  // The notebook is edited by a human at midnight; a stack trace is not the
  // help they need. The parser's messages name the block and the missing line.
  say(`library: NOT compiled — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
