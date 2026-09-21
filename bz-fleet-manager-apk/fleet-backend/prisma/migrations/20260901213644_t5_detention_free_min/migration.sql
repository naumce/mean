-- AlterTable
ALTER TABLE "LoadStop" ADD COLUMN     "detentionFreeMin" INTEGER;

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "detentionFreeMin" INTEGER NOT NULL DEFAULT 120;
