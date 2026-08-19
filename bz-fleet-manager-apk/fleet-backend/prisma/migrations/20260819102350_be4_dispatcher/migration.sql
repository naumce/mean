-- CreateTable
CREATE TABLE "Dispatcher" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RoutePreAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "driverId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "declineReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME
);

-- CreateTable
CREATE TABLE "DriverLocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "driverId" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "preTripCheckCompleted" BOOLEAN NOT NULL DEFAULT false,
    "driverId" TEXT,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Trip" ("completedAt", "createdAt", "driverId", "id", "identifier", "preTripCheckCompleted", "startedAt", "status") SELECT "completedAt", "createdAt", "driverId", "id", "identifier", "preTripCheckCompleted", "startedAt", "status" FROM "Trip";
DROP TABLE "Trip";
ALTER TABLE "new_Trip" RENAME TO "Trip";
CREATE UNIQUE INDEX "Trip_identifier_key" ON "Trip"("identifier");
CREATE INDEX "Trip_driverId_status_idx" ON "Trip"("driverId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Dispatcher_email_key" ON "Dispatcher"("email");

-- CreateIndex
CREATE INDEX "RoutePreAssignment_driverId_idx" ON "RoutePreAssignment"("driverId");

-- CreateIndex
CREATE INDEX "RoutePreAssignment_tripId_idx" ON "RoutePreAssignment"("tripId");

-- CreateIndex
CREATE INDEX "DriverLocation_driverId_createdAt_idx" ON "DriverLocation"("driverId", "createdAt");
