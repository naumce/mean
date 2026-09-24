-- pgcrypto lives in "public" on a local Postgres and in "extensions" on
-- Supabase; the test suite runs each migration inside its own schema. Keep
-- the tables resolving to the current schema (first in search_path) and let
-- gen_random_bytes resolve from wherever the extension actually is.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT set_config('search_path', current_setting('search_path') || ',public,extensions', false);

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "endorsements" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "equipmentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "homeBaseCity" TEXT,
ADD COLUMN     "homeBaseState" TEXT,
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "timezone" TEXT,
ADD COLUMN     "yearsExperience" INTEGER;

-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "customerId" TEXT;

-- AlterTable
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(gen_random_bytes(32), 'hex');

-- CreateTable
CREATE TABLE "DriverAvailability" (
    "driverId" TEXT NOT NULL,
    "acceptingLoads" BOOLEAN NOT NULL DEFAULT false,
    "availabilityStatus" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
    "availableAt" TIMESTAMP(3),
    "availableLat" DOUBLE PRECISION,
    "availableLng" DOUBLE PRECISION,
    "availableCity" TEXT,
    "availableState" TEXT,
    "locationSharingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "locationSharingUpdatedAt" TIMESTAMP(3),
    "shareToken" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverAvailability_pkey" PRIMARY KEY ("driverId")
);

-- CreateTable
CREATE TABLE "DriverPreference" (
    "driverId" TEXT NOT NULL,
    "maxTripMiles" INTEGER,
    "preferredRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredLanes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avoidRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avoidLanes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "homeTimeTarget" TEXT,
    "willingToDriveNight" BOOLEAN NOT NULL DEFAULT true,
    "willingToRelocateMiles" INTEGER,
    "preferredEquipment" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverPreference_pkey" PRIMARY KEY ("driverId")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryContactName" TEXT,
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "preferredCommunicationChannel" TEXT NOT NULL DEFAULT 'email',
    "timezone" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'standard',
    "updateCadenceMinutes" INTEGER,
    "lateNotificationThresholdMinutes" INTEGER,
    "detentionFreeMinutes" INTEGER,
    "requiresArrivalNotification" BOOLEAN NOT NULL DEFAULT false,
    "requiresDelayNotification" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationState" (
    "orgId" TEXT NOT NULL,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "simMinutesAdvanced" INTEGER NOT NULL DEFAULT 0,
    "lastTickAt" TIMESTAMP(3),
    "seed" TEXT,

    CONSTRAINT "SimulationState_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "SimDriverState" (
    "driverId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "modeUntil" TIMESTAMP(3),
    "offsetLat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offsetLng" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimDriverState_pkey" PRIMARY KEY ("driverId")
);

-- CreateTable
CREATE TABLE "AiExperiment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDecisionRecord" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "loadId" TEXT,
    "driverId" TEXT,
    "kind" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "toolCalls" JSONB NOT NULL,
    "toolResults" JSONB NOT NULL,
    "proposedDecision" JSONB,
    "reason" TEXT,
    "confidence" DOUBLE PRECISION,
    "humanDecision" JSONB,
    "actualOutcome" JSONB,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "outcomeAt" TIMESTAMP(3),

    CONSTRAINT "AiDecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverAvailability_shareToken_key" ON "DriverAvailability"("shareToken");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_orgId_name_key" ON "Customer"("orgId", "name");

-- CreateIndex
CREATE INDEX "AiDecisionRecord_orgId_loadId_idx" ON "AiDecisionRecord"("orgId", "loadId");

-- CreateIndex
CREATE INDEX "AiDecisionRecord_experimentId_idx" ON "AiDecisionRecord"("experimentId");

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverAvailability" ADD CONSTRAINT "DriverAvailability_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPreference" ADD CONSTRAINT "DriverPreference_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationState" ADD CONSTRAINT "SimulationState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimDriverState" ADD CONSTRAINT "SimDriverState_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExperiment" ADD CONSTRAINT "AiExperiment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDecisionRecord" ADD CONSTRAINT "AiDecisionRecord_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "AiExperiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (Task 1): split existing "name" into firstName/lastName. lastName
-- is everything after the first space, trimmed; a single-word name (or one
-- that is only whitespace after the first token) yields a NULL lastName, not
-- an empty string. Guarded by "firstName" IS NULL so this only ever touches
-- rows that have never been split before.
UPDATE "Driver"
SET "firstName" = nullif(split_part("name", ' ', 1), ''),
    "lastName" = nullif(btrim(substr("name", length(split_part("name", ' ', 1)) + 2)), '')
WHERE "name" IS NOT NULL AND "firstName" IS NULL;

-- Backfill (Task 1): homeBase ("City, ST") into homeBaseCity/State, only for
-- rows that actually match that shape — a homeBase that is freeform text
-- (or missing the state) is left alone rather than guessed at.
UPDATE "Driver"
SET "homeBaseCity" = btrim(split_part("homeBase", ',', 1)),
    "homeBaseState" = upper(btrim(split_part("homeBase", ',', 2)))
WHERE "homeBase" ~ '^[^,]+,\s*[A-Za-z]{2}$';

-- Backfill (Task 1): one Customer per distinct (orgId, trimmed customerName)
-- the Broker Board has ever recorded on a Load. primaryEmail takes the first
-- non-null customerEmail seen in that group — good enough for a backfill;
-- a dispatcher can correct it afterward. ON CONFLICT DO NOTHING makes this
-- safe to have run against data that already satisfies the (orgId, name)
-- unique constraint (an empty Load table is the degenerate, always-safe case).
INSERT INTO "Customer" ("id", "orgId", "name", "primaryEmail", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       "orgId",
       btrim("customerName"),
       (array_agg("customerEmail" ORDER BY "createdAt") FILTER (WHERE "customerEmail" IS NOT NULL))[1],
       now(),
       now()
FROM "Load"
WHERE "orgId" IS NOT NULL AND "customerName" IS NOT NULL AND btrim("customerName") <> ''
GROUP BY "orgId", btrim("customerName")
ON CONFLICT DO NOTHING;

-- Backfill (Task 1): link each Load to the Customer row just created/matched
-- above. Exact match on the trimmed name, in the same org — no case folding.
UPDATE "Load" AS l
SET "customerId" = c."id"
FROM "Customer" AS c
WHERE c."orgId" = l."orgId" AND c."name" = btrim(l."customerName");
