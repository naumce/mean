// The one place the worker writes to the console. Structured, one line per
// event, so a log can be grepped by trip id. Adapters never log secrets;
// nothing here redacts, so nothing here may be handed one.
export type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}
