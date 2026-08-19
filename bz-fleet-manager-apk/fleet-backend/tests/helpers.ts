import { prisma } from "../src/db.js";
import { createApp } from "../src/app.js";

export const app = createApp();

export async function resetDb() {
  await prisma.$transaction([
    prisma.signsProof.deleteMany(), prisma.signsProofRequirement.deleteMany(),
    prisma.upload.deleteMany(), prisma.checklistItem.deleteMany(),
    prisma.stop.deleteMany(), prisma.trip.deleteMany(),
    prisma.vehicle.deleteMany(), prisma.revokedToken.deleteMany(),
    prisma.driver.deleteMany(),
  ]);
}

export async function createDriver(over: Partial<{ email: string; passwordHash: string; name: string }> = {}) {
  return prisma.driver.create({
    data: { email: over.email ?? "d@x.com", passwordHash: over.passwordHash ?? "x",
            name: over.name ?? "Test Driver" },
  });
}
