-- CreateTable
CREATE TABLE "RestStop" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "spaces" INTEGER,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'import',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestStop_orgId_lat_lng_idx" ON "RestStop"("orgId", "lat", "lng");

-- AddForeignKey
ALTER TABLE "RestStop" ADD CONSTRAINT "RestStop_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
