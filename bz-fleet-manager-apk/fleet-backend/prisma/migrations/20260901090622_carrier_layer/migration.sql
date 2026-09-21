-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "carrierId" TEXT;

-- AlterTable
ALTER TABLE "Tractor" ADD COLUMN     "carrierId" TEXT;

-- AlterTable
ALTER TABLE "Trailer" ADD COLUMN     "carrierId" TEXT;

-- CreateTable
CREATE TABLE "Carrier" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mcNumber" TEXT,
    "dotNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mpg" DOUBLE PRECISION,
    "dieselCentsPerGal" INTEGER,
    "driverPayCentsPerMi" INTEGER,
    "fixedCentsPerMi" INTEGER,
    "insuranceExpiresAt" TIMESTAMP(3),
    "authorityStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Carrier_orgId_status_idx" ON "Carrier"("orgId", "status");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Carrier" ADD CONSTRAINT "Carrier_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tractor" ADD CONSTRAINT "Tractor_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trailer" ADD CONSTRAINT "Trailer_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
