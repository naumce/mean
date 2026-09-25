-- pgcrypto lives in "public" on a local Postgres and in "extensions" on
-- Supabase; the test suite runs each migration inside its own schema. Keep
-- the tables resolving to the current schema (first in search_path) and let
-- gen_random_bytes resolve from wherever the extension actually is.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT set_config('search_path', current_setting('search_path') || ',public,extensions', false);

-- AlterTable
ALTER TABLE "AiDecisionRecord" ADD COLUMN     "baseline" JSONB,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "error" TEXT,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "modelConfig" JSONB,
ADD COLUMN     "parentRunId" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "stats" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'queued',
ADD COLUMN     "terminationReason" TEXT;

-- AlterTable
ALTER TABLE "AiExperiment" ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "promptVersion" TEXT NOT NULL DEFAULT 'dispatch-v1',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(gen_random_bytes(32), 'hex');

-- CreateTable
CREATE TABLE "AiRunStep" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "payload" JSONB NOT NULL,
    "atMs" BIGINT NOT NULL,
    "durationMs" INTEGER,

    CONSTRAINT "AiRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRunStep_decisionId_idx" ON "AiRunStep"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AiRunStep_decisionId_seq_key" ON "AiRunStep"("decisionId", "seq");

-- CreateIndex
CREATE INDEX "AiDecisionRecord_orgId_status_idx" ON "AiDecisionRecord"("orgId", "status");

-- AddForeignKey
ALTER TABLE "AiRunStep" ADD CONSTRAINT "AiRunStep_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AiDecisionRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
