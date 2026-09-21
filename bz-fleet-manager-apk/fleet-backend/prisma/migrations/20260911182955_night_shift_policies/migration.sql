-- AlterTable
ALTER TABLE "AgentTrip" ADD COLUMN     "loadId" TEXT;

-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "agentPill" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "agentPolicyId" TEXT;

-- CreateTable
CREATE TABLE "AgentPolicy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stopMin" INTEGER NOT NULL DEFAULT 15,
    "delayMin" INTEGER NOT NULL DEFAULT 30,
    "darkMin" INTEGER NOT NULL DEFAULT 20,
    "darkAtStopMin" INTEGER NOT NULL DEFAULT 60,
    "offRouteMi" DOUBLE PRECISION NOT NULL DEFAULT 3.1,
    "offRouteMin" INTEGER NOT NULL DEFAULT 10,
    "rungGapMin" INTEGER NOT NULL DEFAULT 5,
    "maxCalls" INTEGER NOT NULL DEFAULT 2,
    "dispatcherEmail" TEXT NOT NULL,
    "dispatcherPhone" TEXT,
    "customerEmailOn" BOOLEAN NOT NULL DEFAULT false,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "bossCallOn" BOOLEAN NOT NULL DEFAULT true,
    "quietFrom" TEXT,
    "quietTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCommand" (
    "id" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "actorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "AgentCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentPolicy_orgId_name_key" ON "AgentPolicy"("orgId", "name");

-- CreateIndex
CREATE INDEX "AgentCommand_loadId_appliedAt_idx" ON "AgentCommand"("loadId", "appliedAt");

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_agentPolicyId_fkey" FOREIGN KEY ("agentPolicyId") REFERENCES "AgentPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrip" ADD CONSTRAINT "AgentTrip_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPolicy" ADD CONSTRAINT "AgentPolicy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;
