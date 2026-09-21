-- pgcrypto lives in "public" on a local Postgres and in "extensions" on
-- Supabase; the test suite runs each migration inside its own schema. Keep
-- the tables resolving to the current schema (first in search_path) and let
-- gen_random_bytes resolve from wherever the extension actually is.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT set_config('search_path', current_setting('search_path') || ',public,extensions', false);

-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "customerEmail" TEXT,
ADD COLUMN     "sheetRowIndex" INTEGER,
ADD COLUMN     "sheetStatusWrittenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "linkSecret" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "loadNightCents" INTEGER,
    "messagingMarkup" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "dailyCommsCapCents" INTEGER NOT NULL DEFAULT 2000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgTelephony" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'ours',
    "region" TEXT NOT NULL DEFAULT 'US',
    "smsSender" TEXT,
    "callerId" TEXT,
    "messagingServiceSid" TEXT,
    "tenDlcCampaignSid" TEXT,
    "tenDlcStatus" TEXT NOT NULL DEFAULT 'none',
    "byoAccountSid" TEXT,
    "byoAuthToken" TEXT,
    "numberPurchasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgTelephony_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetBinding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "tabId" TEXT NOT NULL,
    "tabTitle" TEXT NOT NULL,
    "headerRow" INTEGER NOT NULL DEFAULT 1,
    "columns" JSONB NOT NULL,
    "agentSwitchCol" INTEGER,
    "agentStatusCol" INTEGER,
    "refreshToken" TEXT NOT NULL,
    "accountEmail" TEXT,
    "lastVersion" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_orgId_key" ON "Plan"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgTelephony_orgId_key" ON "OrgTelephony"("orgId");

-- CreateIndex
CREATE INDEX "SheetBinding_status_idx" ON "SheetBinding"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SheetBinding_orgId_spreadsheetId_tabId_key" ON "SheetBinding"("orgId", "spreadsheetId", "tabId");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgTelephony" ADD CONSTRAINT "OrgTelephony_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SheetBinding" ADD CONSTRAINT "SheetBinding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every existing org gets a real linkSecret and a tower plan (this
-- product existed for tower-only orgs before this migration).
-- Schema-qualified: pgcrypto installs into "public" regardless of which
-- schema this migration itself runs in (each vitest process gets its own
-- `test_<pid>` schema whose search_path does not include public).
UPDATE "Org" SET "linkSecret" = encode(gen_random_bytes(32), 'hex') WHERE "linkSecret" = '';
INSERT INTO "Plan" (id, "orgId", tier)
SELECT gen_random_uuid()::text, id, 'tower' FROM "Org" WHERE id NOT IN (SELECT "orgId" FROM "Plan");

-- Invariant: every Org has a Plan, from the instant it's inserted, with no
-- window where one exists without the other. Review finding (Task 1, fix
-- round 1): making this a DB-enforced invariant — rather than teaching every
-- one of the ~74 existing fixtures across the suite that create a bare Org
-- to also create a Plan — is what lets login/`/me` use the strict `planOf`
-- (which throws on a missing plan) instead of a silently-nullable read.
-- Signup overwrites the default 'tower' tier with `tx.plan.update` right
-- after the Org insert when the signup is for the "sheet" product.
CREATE OR REPLACE FUNCTION org_default_plan() RETURNS trigger AS $$
BEGIN
  INSERT INTO "Plan" (id, "orgId", tier)
  VALUES (gen_random_uuid()::text, NEW.id, 'tower')
  ON CONFLICT ("orgId") DO NOTHING;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_default_plan AFTER INSERT ON "Org"
FOR EACH ROW EXECUTE FUNCTION org_default_plan();
