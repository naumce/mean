-- AlterTable
ALTER TABLE "Org" ALTER COLUMN "linkSecret" SET DEFAULT encode(gen_random_bytes(32), 'hex');

-- CreateTable
CREATE TABLE "OrgApiKey" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'nightshift',
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OrgApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgApiKey_orgId_idx" ON "OrgApiKey"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgApiKey_keyHash_key" ON "OrgApiKey"("keyHash");

-- AddForeignKey
ALTER TABLE "OrgApiKey" ADD CONSTRAINT "OrgApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
