-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LoadChange" (
    "id" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "atMs" BIGINT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "note" TEXT,

    CONSTRAINT "LoadChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdateRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoadChange_loadId_atMs_idx" ON "LoadChange"("loadId", "atMs");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateRule_orgId_prefix_key" ON "UpdateRule"("orgId", "prefix");

-- AddForeignKey
ALTER TABLE "LoadChange" ADD CONSTRAINT "LoadChange_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateRule" ADD CONSTRAINT "UpdateRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

