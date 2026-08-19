import { defineConfig } from "vitest/config";

// SQLite substitution (see project instructions): a single on-disk DB file is
// shared by the whole test process. fileParallelism:false below keeps
// DB-touching specs from racing on it, and resetDb() gives per-test isolation.
process.env.DATABASE_URL ||= "file:./dev.db";

export default defineConfig({
  test: { environment: "node", globals: true, fileParallelism: false },
});
