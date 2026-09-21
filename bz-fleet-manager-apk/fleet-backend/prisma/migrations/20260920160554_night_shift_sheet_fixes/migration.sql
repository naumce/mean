-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "sheetSwitchSeen" TEXT;

-- AlterTable
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(public.gen_random_bytes(32), 'hex');

-- AlterTable
ALTER TABLE "SheetBinding" ADD COLUMN     "spreadsheetTitle" TEXT;

-- Backfill (final fix wave, I12): any org still carrying the old '' default
-- gets a real secret, so `verifyOrgToken` (which now refuses an empty
-- secret) can never lock an existing org out of its own deep links.
-- Schema-qualified for the same reason the previous migration was: pgcrypto
-- lives in "public" regardless of the schema this runs in.
UPDATE "Org" SET "linkSecret" = encode(public.gen_random_bytes(32), 'hex') WHERE "linkSecret" = '';
