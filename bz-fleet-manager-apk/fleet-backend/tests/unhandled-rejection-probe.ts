// Spawned as a child process by tests/process-crash.test.ts. NOT a suite —
// vitest only collects *.test.ts, and that is the point: vitest installs its
// own `unhandledRejection` listener, so a rejection raised inside the runner
// can never demonstrate what Node does to a server process without one.
//
// Installs the real guard, then raises exactly the failure Node 22 kills a
// process for. With the guard the timer fires and this exits 0; without it
// Node prints the rejection and exits 1 before the timer ever runs.
import { installProcessGuards } from "../src/lib/processGuards.js";

installProcessGuards();

void Promise.reject(new Error("stray rejection from an un-awaited handler"));

setTimeout(() => {
  console.log("STILL ALIVE");
  process.exit(0);
}, 300);
