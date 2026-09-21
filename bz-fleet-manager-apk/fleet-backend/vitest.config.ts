import { defineConfig } from "vitest/config";

// --- Per-process Postgres schema -------------------------------------------
//
// The suite used to point every vitest process at ONE schema (`public`) of the
// docker `fleet-postgres` database. resetDb() (tests/helpers.ts) is a single
// READ COMMITTED batch of ~34 deleteMany() calls ending in org.deleteMany(),
// which is only safe while nothing else writes to that database — and nothing
// enforced it. Two `vitest run` invocations at once therefore corrupted each
// other ~83% of the time: one process's resetDb() deleted the Org a live
// transaction in the other process was inserting against (P2003
// `Assignment_orgId_fkey`), and its own org.deleteMany() failed on rows the
// other process had committed since statement 1 (P2003 `Load_orgId_fkey`,
// batchRequestIdx 34). The failures landed on whichever test happened to be
// running, so they read as unrelated flakes across a dozen files.
//
// The fix is to remove one of the two writers rather than narrow the window:
// each vitest PROCESS gets its own Postgres schema, `test_<pid>`, created and
// migrated by tests/globalSetup.ts and dropped again on teardown. Two
// concurrent runs can no longer see each other's rows at all. Do NOT "fix"
// this class of failure by reordering resetDb()'s deletes, retrying it, or
// switching it to TRUNCATE CASCADE: all three leave two writers on one schema
// and only make the race rarer, which makes it harder to diagnose, not safer.
//
// TEST_BASE_DATABASE_URL keeps the un-namespaced URL for globalSetup, which
// has to connect somewhere in order to CREATE the schema.
const baseDatabaseUrl = process.env.DATABASE_URL ?? "postgresql://fleet:fleet@localhost:5434/fleet";
const testSchema = `test_${process.pid}`;
const schemaUrl = new URL(baseDatabaseUrl);
schemaUrl.searchParams.set("schema", testSchema);

process.env.TEST_BASE_DATABASE_URL = baseDatabaseUrl;
process.env.TEST_SCHEMA = testSchema;
// Read by src/db.ts's PrismaClient in every worker: the forks pool inherits
// this process's env, so the whole run lands in `test_<pid>`.
process.env.DATABASE_URL = schemaUrl.toString();

// src/lib/tokens.ts throws at import time if these are unset (fail-fast in
// real deployments) — give the test process dev-only values the same way.
process.env.JWT_ACCESS_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
// Suites hammer login/signup far past the public-endpoint limits; the limiter
// middleware is unit-tested directly in tests/rate-limit.test.ts instead.
process.env.RATE_LIMIT_DISABLED = "1";
// Routing providers are pinned OFF for the whole suite, deliberately and here
// rather than in .env.test — Vitest loads `.env` into process.env, and `.env`
// now carries a real MAPBOX_TOKEN so the dev server can draw real roads.
//
// The moment that token landed, three tests failed: plans that had always been
// costed on haversine started getting real provider miles, and the suite began
// making live, billable Mapbox calls on every run. A test suite that reaches an
// external API is broken by design — slow, flaky, billable, and red on a plane.
// The engine's offline fallback is the behaviour under test; a live route is
// not. Tests that DO exercise a provider set ROUTER_URL themselves and stub
// fetch (see tests/routing.test.ts).
// NOTE: deleting these from THIS process is not enough — the `forks` pool
// spawns workers that re-load `.env` themselves, so the token comes straight
// back. `test.env` below is applied inside each worker, which is the only
// place the rule actually holds.

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Applied in every worker (see the note above). Empty string is falsy, so
    // routingConfigured() reports false and the engine uses its offline
    // haversine path — the behaviour these suites actually assert.
    env: { ROUTER_URL: "", MAPBOX_TOKEN: "" },
    // Still false. Per-process schemas fix the CROSS-process race; files
    // inside one process share this run's schema and resetDb() runs in every
    // beforeEach, so two files running at once would still delete each
    // other's fixtures. Parallelism would need a schema per WORKER, not per
    // process.
    fileParallelism: false,
    // The default `threads` pool SIGSEGVs non-deterministically here (exit
    // 139, killing the reporter before it flushes — the suite appears to
    // vanish mid-run rather than fail). `forks` runs all 88 files to
    // completion; every gate in this project was being run in small batches
    // to work around the crash.
    pool: "forks",
    globalSetup: ["./tests/globalSetup.ts"],
  },
});
