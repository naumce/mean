import { prisma } from "../src/db.js";
import { createApp } from "../src/app.js";

export const app = createApp();

export async function resetDb() {
  await prisma.$transaction([
    prisma.message.deleteMany(), prisma.conversation.deleteMany(),
    prisma.notification.deleteMany(), prisma.driverSession.deleteMany(),
    prisma.safetyAlert.deleteMany(), prisma.fuelLog.deleteMany(),
    prisma.vehicleIssue.deleteMany(), prisma.incident.deleteMany(),
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
