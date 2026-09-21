-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "boardLoadNo" TEXT,
ADD COLUMN     "extras" JSONB;

-- CreateTable
CREATE TABLE "BoardView" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fills" JSONB NOT NULL DEFAULT '{}',
    "merges" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoardView_orgId_key" ON "BoardView"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Load_orgId_boardLoadNo_key" ON "Load"("orgId", "boardLoadNo");

-- AddForeignKey
ALTER TABLE "BoardView" ADD CONSTRAINT "BoardView_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

