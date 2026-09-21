-- Fleet compliance & maintenance: expiry clocks on units and drivers, the
-- service-shop registry, and the maintenance ledger.
ALTER TABLE "Tractor"
  ADD COLUMN "inspectionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "registrationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextServiceAt" TIMESTAMP(3);

ALTER TABLE "Trailer"
  ADD COLUMN "inspectionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "registrationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextServiceAt" TIMESTAMP(3);

ALTER TABLE "Driver" ADD COLUMN "medicalCertExpiresAt" TIMESTAMP(3);

CREATE TABLE "ServiceShop" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "phone" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceShop_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ServiceShop_orgId_idx" ON "ServiceShop"("orgId");
ALTER TABLE "ServiceShop" ADD CONSTRAINT "ServiceShop_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ServiceRecord" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "tractorId" TEXT,
  "trailerId" TEXT,
  "kind" TEXT NOT NULL,
  "notes" TEXT,
  "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextDueAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ServiceRecord_orgId_tractorId_idx" ON "ServiceRecord"("orgId", "tractorId");
CREATE INDEX "ServiceRecord_orgId_trailerId_idx" ON "ServiceRecord"("orgId", "trailerId");
CREATE INDEX "ServiceRecord_orgId_shopId_idx" ON "ServiceRecord"("orgId", "shopId");
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "ServiceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_tractorId_fkey"
  FOREIGN KEY ("tractorId") REFERENCES "Tractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_trailerId_fkey"
  FOREIGN KEY ("trailerId") REFERENCES "Trailer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
