-- pgcrypto lives in "public" on a local Postgres and in "extensions" on
-- Supabase; the test suite runs each migration inside its own schema. Keep
-- the tables resolving to the current schema (first in search_path) and let
-- gen_random_bytes resolve from wherever the extension actually is.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT set_config('search_path', current_setting('search_path') || ',public,extensions', false);

-- AlterTable
ALTER TABLE "DemoStory" ADD COLUMN     "breakdownTriggeredAt" TIMESTAMP(3),
ALTER COLUMN "breakdownAtFraction" SET DEFAULT 0.05;

-- AlterTable
-- Restates Org.linkSecret's dbgenerated() default — Prisma's migrate diff
-- re-detects it as drift on every schema change because dbgenerated() is
-- opaque to it; harmless (idempotent) each time, same as every migration
-- since it was introduced.
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(gen_random_bytes(32), 'hex');
