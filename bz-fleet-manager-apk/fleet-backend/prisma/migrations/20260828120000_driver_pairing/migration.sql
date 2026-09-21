-- Driver ↔ unit pairing for the cockpit lane header / default equipment.
ALTER TABLE "Driver" ADD COLUMN "defaultTractorId" TEXT;
ALTER TABLE "Driver" ADD COLUMN "defaultTrailerId" TEXT;
