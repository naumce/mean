-- pgcrypto lives in "public" on a local Postgres and in "extensions" on
-- Supabase; the test suite runs each migration inside its own schema. Keep
-- the tables resolving to the current schema (first in search_path) and let
-- gen_random_bytes resolve from wherever the extension actually is.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT set_config('search_path', current_setting('search_path') || ',public,extensions', false);

-- AlterTable
-- Restates Org.linkSecret's dbgenerated() default — Prisma's migrate diff
-- re-detects it as drift on every schema change because dbgenerated() is
-- opaque to it; harmless (idempotent) each time, same as every migration
-- since it was introduced.
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(gen_random_bytes(32), 'hex');

-- CreateTable
CREATE TABLE "DemoStory" (
    "orgId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'uncovered',
    "loadId" TEXT,
    "driverId" TEXT,
    "assignmentId" TEXT,
    "runId" TEXT,
    "experimentId" TEXT,
    "policyId" TEXT,
    "customerId" TEXT,
    "recommendedDriverId" TEXT,
    "recommendationSource" TEXT,
    "breakdownAtFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "holdStartedAt" TIMESTAMP(3),
    "log" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoStory_pkey" PRIMARY KEY ("orgId")
);

-- AddForeignKey
ALTER TABLE "DemoStory" ADD CONSTRAINT "DemoStory_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
