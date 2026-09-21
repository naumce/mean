-- CreateTable
CREATE TABLE "LocationRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "locationId" TEXT,

    CONSTRAINT "LocationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocationRequest_orgId_status_requestedAt_idx" ON "LocationRequest"("orgId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "LocationRequest_driverId_status_idx" ON "LocationRequest"("driverId", "status");

-- AddForeignKey
ALTER TABLE "LocationRequest" ADD CONSTRAINT "LocationRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationRequest" ADD CONSTRAINT "LocationRequest_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
