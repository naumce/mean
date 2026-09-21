-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "boardLine" INTEGER;

-- CreateIndex
CREATE INDEX "Load_orgId_boardLine_idx" ON "Load"("orgId", "boardLine");
