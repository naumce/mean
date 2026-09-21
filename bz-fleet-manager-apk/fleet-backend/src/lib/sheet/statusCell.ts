// Renders the status-cell string the sync loop writes back to a dispatcher's
// sheet (spec §6.2). This picks words, never states — the pill and its line
// are decided upstream (the agent layer); this folder just renders them.

// Every pill the schema names (Load.agentPill's own comment): off | watching
// | asked | calling | escalated | delivered | attention | shadow | held. The
// three mid-ladder words were missing until the final fix wave (I10) — an
// asked/calling/escalated load rendered as "ATTENTION — unknown state".
export const PILL_WORDS: Record<string, string> = {
  watching: "WATCHING",
  asked: "ASKED",
  calling: "CALLING",
  escalated: "ESCALATED",
  shadow: "SHADOW",
  attention: "ATTENTION",
  delivered: "DELIVERED",
  held: "HELD",
  off: "OFF",
};

export function statusCellText(pill: string, line: string | null): string {
  const word = PILL_WORDS[pill];
  if (!word) return line ? `● ATTENTION — unknown state '${pill}': ${line}` : `● ATTENTION — unknown state '${pill}'`;
  if (pill === "delivered") return line ? `● ${word} ${line}` : `● ${word}`;
  return line ? `● ${word} — ${line}` : `● ${word}`;
}
