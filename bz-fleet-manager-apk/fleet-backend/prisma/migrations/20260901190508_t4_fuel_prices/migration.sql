-- CreateTable
CREATE TABLE "FuelPrice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "centsPerGal" INTEGER NOT NULL,
    "effectiveOn" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'import',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FuelPrice_orgId_state_effectiveOn_idx" ON "FuelPrice"("orgId", "state", "effectiveOn");

-- CreateIndex
CREATE UNIQUE INDEX "FuelPrice_orgId_state_effectiveOn_key" ON "FuelPrice"("orgId", "state", "effectiveOn");

-- AddForeignKey
ALTER TABLE "FuelPrice" ADD CONSTRAINT "FuelPrice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
