-- Provider road-distance cache.
CREATE TABLE "RouteDistance" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "miles" DOUBLE PRECISION NOT NULL,
    "minutes" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'osrm',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RouteDistance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RouteDistance_key_key" ON "RouteDistance"("key");
