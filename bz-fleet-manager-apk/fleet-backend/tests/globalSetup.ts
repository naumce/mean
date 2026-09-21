import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";

// Creates and migrates this vitest process's own Postgres schema, then drops
// it again when the run finishes. See vitest.config.ts for WHY the suite needs
// one schema per process rather than a shared `public`.
//
// Runs once in the main vitest process, before any worker is forked, so every
// worker inherits a DATABASE_URL that already points at a migrated schema.

const require = createRequire(import.meta.url);

/** Schemas older than this are leftovers from a run that was killed before
 *  teardown (Ctrl-C, a crashed pool). Two hours is far longer than the whole
 *  suite takes, so nothing live can be inside the window. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — vitest.config.ts should have set it`);
  return value;
}

function adminClient(): PrismaClient {
  // Deliberately the un-namespaced URL: the schema we are about to create does
  // not exist yet, so connecting through it would fail.
  return new PrismaClient({ datasources: { db: { url: requireEnv("TEST_BASE_DATABASE_URL") } } });
}

/** `prisma migrate deploy` against this run's schema, without shelling out
 *  through `npx` (whose resolution differs between cmd.exe and a POSIX shell). */
function migrate(databaseUrl: string): void {
  let cli: string;
  try {
    cli = require.resolve("prisma/build/index.js");
  } catch {
    cli = join(dirname(require.resolve("prisma/package.json")), "build", "index.js");
  }
  execFileSync(process.execPath, [cli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}

/** Drop schemas left behind by runs that never reached teardown. Only schemas
 *  this file created are considered: each one carries its creation time as a
 *  schema COMMENT, and anything without a parseable one is left alone. */
async function dropStaleSchemas(admin: PrismaClient, keep: string): Promise<void> {
  const rows = await admin.$queryRawUnsafe<Array<{ nspname: string; comment: string | null }>>(
    `select n.nspname, obj_description(n.oid, 'pg_namespace') as comment
       from pg_namespace n
      where n.nspname like 'test\\_%'`,
  );
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const row of rows) {
    if (row.nspname === keep || !row.comment) continue;
    const createdAt = Date.parse(row.comment);
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
  }
}

export async function setup(): Promise<void> {
  const schema = requireEnv("TEST_SCHEMA");
  const databaseUrl = requireEnv("DATABASE_URL");
  const admin = adminClient();
  try {
    await dropStaleSchemas(admin, schema);
    // IF EXISTS covers a recycled pid whose previous run never tore down.
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await admin.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS '${new Date().toISOString()}'`);
  } finally {
    await admin.$disconnect();
  }
  migrate(databaseUrl);
}

export async function teardown(): Promise<void> {
  const schema = process.env.TEST_SCHEMA;
  if (!schema) return;
  const admin = adminClient();
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
}
