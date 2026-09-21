-- CreateTable
CREATE TABLE "LoadLock" (
    "id" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dispatcherId" TEXT NOT NULL,
    "dispatcherName" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoadLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoadLock_loadId_key" ON "LoadLock"("loadId");

-- CreateIndex
CREATE INDEX "LoadLock_orgId_expiresAt_idx" ON "LoadLock"("orgId", "expiresAt");

-- CreateIndex
CREATE INDEX "LoadLock_dispatcherId_idx" ON "LoadLock"("dispatcherId");

-- AddForeignKey
ALTER TABLE "LoadLock" ADD CONSTRAINT "LoadLock_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

