-- Exact pre-commit HOS snapshots for drift-free unassign restore.
ALTER TABLE "Assignment" ADD COLUMN "hosDriveBefore" INTEGER;
ALTER TABLE "Assignment" ADD COLUMN "hosWindowBefore" INTEGER;
ALTER TABLE "Assignment" ADD COLUMN "hosCycleBefore" INTEGER;
ALTER TABLE "Assignment" ADD COLUMN "hosBreakBefore" INTEGER;
-- One load per external reference per org (NULLs exempt).
CREATE UNIQUE INDEX "Load_orgId_externalId_key" ON "Load"("orgId", "externalId");
