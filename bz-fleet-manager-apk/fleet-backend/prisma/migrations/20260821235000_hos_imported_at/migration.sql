-- HOS freshness: when real clock data last arrived (import/ELD). Commit-time
-- planning decrements deliberately do not touch it. Null = age unknown.
ALTER TABLE "HosState" ADD COLUMN "importedAt" TIMESTAMP(3);
