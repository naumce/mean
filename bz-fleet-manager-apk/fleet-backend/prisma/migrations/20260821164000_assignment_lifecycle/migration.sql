-- Lifecycle timestamps for start/deliver transitions.
ALTER TABLE "Assignment" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Assignment" ADD COLUMN "completedAt" TIMESTAMP(3);
