-- pgcrypto lives in "public" on a local Postgres and in "extensions" on
-- Supabase; the test suite runs each migration inside its own schema. Keep
-- the tables resolving to the current schema (first in search_path) and let
-- gen_random_bytes resolve from wherever the extension actually is.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT set_config('search_path', current_setting('search_path') || ',public,extensions', false);
-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "sheetSwitchSeen" TEXT;

-- AlterTable
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(gen_random_bytes(32), 'hex');

-- AlterTable
ALTER TABLE "SheetBinding" ADD COLUMN     "spreadsheetTitle" TEXT;

-- Backfill (final fix wave, I12): any org still carrying the old '' default
-- gets a real secret, so `verifyOrgToken` (which now refuses an empty
-- secret) can never lock an existing org out of its own deep links.
-- Schema-qualified for the same reason the previous migration was: pgcrypto
-- lives in "public" regardless of the schema this runs in.
UPDATE "Org" SET "linkSecret" = encode(gen_random_bytes(32), 'hex') WHERE "linkSecret" = '';
