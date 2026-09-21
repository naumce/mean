// There is no sheet in the first live run. The agent still "writes" — to the
// log, under the name it will use on SharePoint — so the runbook can show
// what the row would say, and nothing pretends a write happened elsewhere.
import type { AgentEvent } from "../core/types.js";
import type { SheetPort } from "../ports/index.js";
import { log } from "./log.js";

export class LogSheet implements SheetPort {
  async writeStatus(loadRef: string, cells: Record<string, string>): Promise<void> {
    log("info", "sheet row (no sheet configured — logged)", { loadRef, ...cells });
  }
  async appendLog(loadRef: string, event: AgentEvent): Promise<void> {
    log("info", "sheet log", { loadRef, kind: event.kind, actionTaken: event.actionTaken ?? null });
  }
}
