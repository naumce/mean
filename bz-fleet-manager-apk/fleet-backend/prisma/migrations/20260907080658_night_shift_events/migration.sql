-- CreateTable
CREATE TABLE "AgentTrip" (
    "id" TEXT NOT NULL,
    "loadRef" TEXT NOT NULL,
    "driverToken" TEXT NOT NULL,
    "brief" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" SERIAL NOT NULL,
    "tripId" TEXT NOT NULL,
    "atMs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "actionTaken" TEXT,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentTrip_driverToken_key" ON "AgentTrip"("driverToken");

-- CreateIndex
CREATE INDEX "AgentEvent_tripId_atMs_idx" ON "AgentEvent"("tripId", "atMs");

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "AgentTrip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
