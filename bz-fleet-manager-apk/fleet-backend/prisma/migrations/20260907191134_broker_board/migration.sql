-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'appointment';

-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "apptText" TEXT,
ADD COLUMN     "bolNumber" TEXT,
ADD COLUMN     "carrierContactName" TEXT,
ADD COLUMN     "carrierId" TEXT,
ADD COLUMN     "carrierPhone" TEXT,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "driverCell" TEXT,
ADD COLUMN     "shipDate" TIMESTAMP(3),
ADD COLUMN     "soldRateCents" INTEGER,
ADD COLUMN     "trackingUrl" TEXT,
ADD COLUMN     "updateText" TEXT;

-- CreateTable
CREATE TABLE "AgentUpdate" (
    "id" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "atMs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardLayout" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "rowsPerLoad" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentUpdate_loadId_atMs_idx" ON "AgentUpdate"("loadId", "atMs");

-- CreateIndex
CREATE UNIQUE INDEX "BoardLayout_orgId_key" ON "BoardLayout"("orgId");

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUpdate" ADD CONSTRAINT "AgentUpdate_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardLayout" ADD CONSTRAINT "BoardLayout_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
