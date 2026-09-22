-- Two-rows-per-load sheets: how many sheet rows make one load (1 or 2).
-- (Prisma's diff also wants to re-state Org.linkSecret's default because it
-- introspects it schema-qualified; that is a no-op and deliberately left out
-- so this migration never touches pgcrypto.)
-- AlterTable
ALTER TABLE "SheetBinding" ADD COLUMN     "rowsPerLoad" INTEGER NOT NULL DEFAULT 1;
