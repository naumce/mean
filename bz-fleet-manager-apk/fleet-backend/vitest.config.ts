import { defineConfig } from "vitest/config";

// SQLite substitution (see project instructions): a single on-disk DB file is
// shared by the whole test process. fileParallelism:false below keeps
// DB-touching specs from racing on it, and resetDb() gives per-test isolation.
process.env.DATABASE_URL ||= "file:./dev.db";
// src/lib/tokens.ts throws at import time if these are unset (fail-fast in
// real deployments) — give the test process dev-only values the same way.
process.env.JWT_ACCESS_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";

export default defineConfig({
  test: { environment: "node", globals: true, fileParallelism: false },
});
