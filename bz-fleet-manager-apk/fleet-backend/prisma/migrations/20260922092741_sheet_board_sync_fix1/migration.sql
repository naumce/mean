-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "sheetBindingId" TEXT;

-- CreateIndex
CREATE INDEX "Load_sheetBindingId_idx" ON "Load"("sheetBindingId");

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_sheetBindingId_fkey" FOREIGN KEY ("sheetBindingId") REFERENCES "SheetBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (review ruling, fix round 1): a load already mirroring some sheet
-- row (`sheetRowIndex IS NOT NULL`) gets its org's single CONNECTED binding's
-- id, when the org has exactly one. An org with zero or more than one
-- connected binding is left NULL — ambiguous, and the row pass will set the
-- right one itself the next time each such load's row is read.
UPDATE "Load" AS l
SET "sheetBindingId" = one."id"
FROM (
  SELECT "orgId", MIN(id) AS id
  FROM "SheetBinding"
  WHERE status = 'connected'
  GROUP BY "orgId"
  HAVING COUNT(*) = 1
) AS one
WHERE l."orgId" = one."orgId" AND l."sheetRowIndex" IS NOT NULL;
