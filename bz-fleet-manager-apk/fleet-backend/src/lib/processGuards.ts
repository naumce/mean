// Process-level safety net for the API server.
//
// Node 22 terminates the process on an unhandled promise rejection
// (`--unhandled-rejections=throw` is the default mode). Express 4 does not
// await route handlers, so a rejecting `async (req, res)` handler — which is
// nearly every route here — produces exactly that. One malformed request was
// enough: a NUL byte in a route parameter made Postgres raise 22021, Prisma
// rejected, nothing caught it, and the process exited 1 with no HTTP response,
// dropping every tenant's in-memory lane lock (src/lib/locks.ts) on the way
// out.
//
// Vitest is why the suite never saw this: the runner installs its own
// `unhandledRejection` listener, so under test the process survives and the
// rejection is attributed to whichever test was running. Only a real `node`
// process shows the crash — see tests/process-crash.test.ts, which boots
// src/server.ts as a child process for that reason.
//
// This is a net, not a cure. It converts an abrupt exit into a logged,
// surviving process; the request that rejected still receives no response, so
// the log line is the signal to go and fix that handler. Deliberately no
// `uncaughtException` handler: a synchronous throw outside a handler leaves
// the process in an unknown state, and continuing from there is worse than
// exiting.

let installed = false;

/** Idempotent — safe to call from more than one entry point. */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
}
