-- Empty-miles-saved metric, computed at commit time.
ALTER TABLE "Assignment" ADD COLUMN "savedMi" DOUBLE PRECISION NOT NULL DEFAULT 0;
